/**
 * Service worker — broker.
 *
 * Le moteur d'export vit dans l'offscreen document. Le service worker :
 * - garantit que l'offscreen existe (le crée à la demande et au démarrage,
 *   pour reprendre les exports interrompus) ;
 * - relaie les commandes des vues (overlay, popup) vers l'offscreen ;
 * - capte les diffusions d'état → badge d'icône + relais aux onglets Discord ;
 * - déclenche les téléchargements et les notifications.
 */
import {
  isCommandEnvelope,
  isDoDownload,
  isGetToken,
  isStateBroadcast,
  progressPct,
  type CommandResponse,
  type ExecEnvelope,
  type VespryCommand,
  type VespryState,
} from '../messaging';
import { getToken } from '../engine/auth';
import {
  SCHEDULE_STORAGE_KEY,
  SCHEDULED_EXPORT_ALARM_NAME,
  installAlarmFor,
  isScheduledExport,
  loadSchedule,
} from '../engine/scheduler';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const DISCORD_URL = 'https://discord.com/channels/@me';

// --- cycle de vie de l'offscreen ---

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification:
          'Exporte l’historique Discord en arrière-plan (checkpoint IndexedDB, zip).',
      })
      .finally(() => {
        creating = null;
      });
  }
  return creating;
}

// Au démarrage de Chrome : réveille l'offscreen pour reprendre les exports.
chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen();
  void syncScheduledAlarm();
});

// Installation / mise à jour de l'extension : ré-aligne l'alarme planifiée
// avec le storage. Sans ça, après une mise à jour Chrome efface les alarmes.
chrome.runtime.onInstalled.addListener(() => {
  void syncScheduledAlarm();
});

// --- planificateur d'export (Phase 3) ---

/**
 * Aligne l'alarme `chrome.alarms` sur l'état stocké dans
 * `chrome.storage.local`. Idempotent : sûr à appeler plusieurs fois.
 * Pas de planning enregistré → l'alarme est nettoyée.
 */
async function syncScheduledAlarm(): Promise<void> {
  try {
    const schedule = await loadSchedule(chrome.storage.local);
    await installAlarmFor(chrome.alarms, schedule);
  } catch (e) {
    console.warn('[Vespry] sync alarm a échoué :', e);
  }
}

// Recharge l'alarme dès que la UI modifie le planning dans storage.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!(SCHEDULE_STORAGE_KEY in changes)) return;
  void syncScheduledAlarm();
});

// Réveil sur l'alarme planifiée : pousse une commande à l'offscreen pour
// qu'il enqueue un export incrémental du guild ciblé.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SCHEDULED_EXPORT_ALARM_NAME) return;
  void onScheduledAlarmFire();
});

async function onScheduledAlarmFire(): Promise<void> {
  const schedule = await loadSchedule(chrome.storage.local);
  if (!isScheduledExport(schedule)) {
    // Storage vidé entre-temps — on désinstalle l'alarme par sécurité.
    await chrome.alarms.clear(SCHEDULED_EXPORT_ALARM_NAME);
    return;
  }
  const result = await forwardCommand({
    cmd: 'scheduled-export-fire',
    guildId: schedule.guildId,
    guildName: schedule.guildName,
  });
  if (!result.ok) {
    // Échec non bloquant : la prochaine occurrence (24h / 7j) retentera.
    // Une notification informe l'utilisateur — il peut avoir besoin de se
    // reconnecter à Discord.
    notify(
      'Export planifié — impossible',
      `${schedule.guildName} : ${result.error ?? 'erreur inconnue'}. Ouvre Discord pour réessayer.`,
    );
  }
}

// --- relais de commandes ---

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function forwardCommand(command: VespryCommand): Promise<CommandResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `offscreen non créé : ${String(e)}` };
  }
  const envelope: ExecEnvelope = { kind: 'vespry-exec', command };
  // L'offscreen vient peut-être d'être créé : on réessaie le temps que son
  // écouteur de messages soit enregistré.
  let lastError = 'offscreen injoignable';
  for (let i = 0; i < 6; i += 1) {
    try {
      const r = await chrome.runtime.sendMessage(envelope);
      if (r && typeof r === 'object') return r as CommandResponse;
    } catch (e) {
      lastError = String(e);
    }
    await sleep(400);
  }
  return { ok: false, error: lastError };
}

// --- ouverture de Discord ---

async function openDiscord(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: 'https://discord.com/*' });
  const existing = tabs[0];
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: DISCORD_URL });
}

// --- badge + notifications sur changement d'état ---

const lastStatus = new Map<string, string>();

function updateBadge(state: VespryState): void {
  const running = state.queue.find((q) => q.status === 'in_progress');
  if (running) {
    const pct = progressPct(running);
    void chrome.action.setBadgeBackgroundColor({ color: '#5865f2' });
    void chrome.action.setBadgeText({ text: `${pct}%` });
    return;
  }
  const finished = state.queue.some(
    (q) => (q.status === 'completed' || q.status === 'partial') && q.zipReady,
  );
  if (finished) {
    void chrome.action.setBadgeBackgroundColor({ color: '#23a55a' });
    void chrome.action.setBadgeText({ text: '✓' });
    return;
  }
  void chrome.action.setBadgeText({ text: '' });
}

function notify(title: string, message: string): void {
  void chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('src/assets/icon-128.png'),
    title,
    message,
  });
}

function checkTransitions(state: VespryState): void {
  for (const item of state.queue) {
    const prev = lastStatus.get(item.runId);
    if (prev !== item.status) {
      lastStatus.set(item.runId, item.status);
      if (prev === undefined) continue; // première observation, pas de notif
      if (item.status === 'completed' || item.status === 'partial') {
        notify('Export terminé', `${item.guildName} — ${item.messages} messages prêts.`);
      } else if (item.status === 'paused') {
        notify('Export en pause', `${item.guildName} — reconnecte-toi à Discord pour reprendre.`);
      } else if (item.status === 'failed') {
        notify('Export échoué', `${item.guildName} — voir les détails dans le panneau.`);
      }
    }
  }
}

async function relayToDiscordTabs(message: unknown): Promise<void> {
  const tabs = await chrome.tabs.query({ url: 'https://discord.com/*' });
  for (const tab of tabs) {
    if (tab.id !== undefined) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        /* onglet sans content script — sans gravité */
      });
    }
  }
}

// --- routeur de messages ---

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isCommandEnvelope(message)) {
    forwardCommand(message.command).then(sendResponse).catch((e: unknown) => {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }
  if (isStateBroadcast(message)) {
    updateBadge(message.state);
    checkTransitions(message.state);
    void relayToDiscordTabs(message);
    return false;
  }
  if (isDoDownload(message)) {
    void chrome.downloads.download({ url: message.url, filename: message.filename });
    return false;
  }
  if (isGetToken(message)) {
    // L'offscreen n'a pas chrome.storage — on lit le jeton pour lui.
    getToken().then((token) => sendResponse({ token })).catch(() => {
      sendResponse({ token: null });
    });
    return true;
  }
  if (typeof message === 'object' && message !== null
    && (message as { kind?: unknown }).kind === 'open-discord') {
    void openDiscord();
    return false;
  }
  return undefined;
});
