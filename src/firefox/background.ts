/**
 * Background script — Firefox (event page MV3).
 *
 * Pourquoi un fichier dédié au lieu de réutiliser le service worker Chrome.
 *
 * - Sur Chrome, le moteur d'export vit dans un **document offscreen** : un
 *   contexte invisible, tab-indépendant, qui survit aux changements d'onglet
 *   et au sommeil du service worker. Le service worker n'est qu'un broker.
 * - Firefox ne supporte PAS `chrome.offscreen` (ni `chrome.scripting.executeScript`
 *   dans un contexte off-tab équivalent). Il faut héberger le moteur ailleurs.
 *
 * La seule option crédible : l'**event page** non-persistante de Firefox MV3.
 * Elle a les caractéristiques d'un document (DOM, fetch tiers, IndexedDB,
 * Blob, URL.createObjectURL, navigator.clipboard…) et reste vivante tant
 * qu'un `port` ou un handler asynchrone est actif. C'est exactement ce dont
 * `VespryController` a besoin.
 *
 * Pour empêcher Firefox de mettre l'event page en sommeil pendant un export
 * long, l'overlay ouvre un `chrome.runtime.connect` persistant côté Firefox
 * (cf. RemoteController quand le port est dispo). La présence du port suffit
 * à garder l'event page vivante (politique officielle Firefox).
 *
 * Ce fichier joue donc le double rôle :
 *  - service worker Chrome (routage messaging, badge, notifications,
 *    téléchargements, ouverture de Discord) ;
 *  - document offscreen Chrome (hébergement du `VespryController`, exécution
 *    du moteur d'export, fetch des dons / Stripe Checkout / token).
 *
 * On NE FORK PAS le moteur. On importe `VespryController` tel quel — c'est
 * la même classe que celle utilisée par l'offscreen Chrome. Toute évolution
 * du moteur profite aux deux builds.
 */
import { VespryController } from '../content/overlay/controller';
import { getToken } from '../engine/auth';
import { installGlobalHandlers } from '../diagnostics';
import { loadCredits } from '../credits';
import { createCheckout, fetchDonorFeed } from '../donors';
import {
  isCommandEnvelope,
  isDoDownload,
  isExecEnvelope,
  isGetToken,
  type CommandResponse,
  type EnqueueExtras,
  type StateBroadcast,
  type VespryCommand,
  type VespryState,
} from '../messaging';

installGlobalHandlers('firefox-background');

const DISCORD_URL = 'https://discord.com/channels/@me';

// --- moteur d'export ---

// Pourquoi ici. L'event page Firefox est l'unique contexte tab-indépendant
// qui survit à la fermeture de l'onglet Discord. Le contrôleur s'initialise
// au chargement, et le port persistant ouvert par l'overlay (cf. ci-dessous)
// garantit que la page reste vivante pendant un run.
const controller = new VespryController();

/** Diffuse l'état courant aux vues abonnées (popup, overlay). */
function broadcast(): void {
  const msg: StateBroadcast = { kind: 'vespry-state', state: controller.toState() };
  // Vues hors discord.com : broadcast runtime classique (popup).
  chrome.runtime.sendMessage(msg).catch(() => {
    /* aucun récepteur — sans gravité */
  });
  // Vues dans un onglet Discord : on relaie aussi par tabs (le runtime
  // sendMessage n'atteint pas les content scripts). Identique au routeur
  // côté service worker Chrome.
  void relayToDiscordTabs(msg);
  // Et on rafraîchit l'UI du badge / notifications.
  const state = controller.toState();
  updateBadge(state);
  checkTransitions(state);
}

controller.subscribe(broadcast);
void controller.init().then(broadcast);

// --- exécution des commandes (anciennement offscreen) ---

async function exec(command: VespryCommand): Promise<CommandResponse> {
  switch (command.cmd) {
    case 'get-state':
      return { ok: true, state: controller.toState() };
    case 'load-channels':
      return { ok: true, channels: await controller.loadChannels(command.guildId) };
    case 'enqueue': {
      const extras: EnqueueExtras = {
        includeThreads: command.includeThreads,
        zones: command.zones,
        zoneMode: command.zoneMode,
        partitionSize: command.partitionSize,
        formats: command.formats,
      };
      if (command.includeReactionUsers) extras.includeReactionUsers = true;
      if (command.incremental) extras.incremental = true;
      await controller.enqueue(command.guild, command.channels, command.media, extras);
      return { ok: true, state: controller.toState() };
    }
    case 'resume':
      controller.resume(command.runId);
      return { ok: true };
    case 'download':
      controller.downloadZip(command.runId);
      return { ok: true };
    case 'preview':
      return {
        ok: true,
        messages: await controller.previewChannel(command.channelId, command.before),
      };
    case 'get-donors': {
      // Fetch tiers : impossible depuis l'overlay (CSP de discord.com). On le
      // fait depuis le background — équivalent du fetch depuis l'offscreen
      // sur Chrome.
      const credits = await loadCredits();
      return { ok: true, donors: await fetchDonorFeed(credits.donorApiUrl) };
    }
    case 'checkout': {
      const credits = await loadCredits();
      const url = await createCheckout(credits.donorApiUrl, {
        amountCents: command.amountCents,
        donorName: command.donorName ?? null,
        message: command.message ?? null,
        isPublic: command.isPublic,
      });
      return url ? { ok: true, checkoutUrl: url } : { ok: true };
    }
  }
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

// --- badge + notifications (transitions d'état) ---

const lastStatus = new Map<string, string>();

function updateBadge(state: VespryState): void {
  const running = state.queue.find((q) => q.status === 'in_progress');
  if (running) {
    const pct = running.channelsTotal > 0
      ? Math.round((running.channelsDone / running.channelsTotal) * 100)
      : 0;
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

// --- routeur de messages (vues → background) ---

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  // Sur Firefox, l'overlay/popup envoient TOUJOURS un `vespry-command` —
  // c'est le contrat unifié. Le moteur étant ici, on exécute directement.
  if (isCommandEnvelope(message)) {
    exec(message.command).then(sendResponse).catch((e: unknown) => {
      sendResponse({ ok: false, error: String(e) });
    });
    return true; // réponse asynchrone
  }
  // Pour rester source-compatible avec le code partagé (overlay et popup),
  // on accepte aussi l'enveloppe d'exécution offscreen Chrome.
  if (isExecEnvelope(message)) {
    exec(message.command).then(sendResponse).catch((e: unknown) => {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }
  if (isDoDownload(message)) {
    void chrome.downloads.download({ url: message.url, filename: message.filename });
    return false;
  }
  if (isGetToken(message)) {
    // Le contrôleur tourne dans CE contexte — il pourrait lire le jeton
    // directement. On garde le message pour rester source-compatible avec
    // l'overlay quand il discute avec le moteur.
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

// --- port persistant (anti-sommeil event page) ---

// Pourquoi un port et pas seulement des messages ponctuels. L'event page
// MV3 Firefox est terminée si aucun port n'est ouvert ET aucun handler async
// n'est en cours pendant ~30 s. Pendant un export long (plusieurs minutes),
// les batchs API laissent des fenêtres où la page pourrait s'endormir entre
// deux tâches. Un `port` ouvert depuis l'overlay maintient explicitement
// l'event page vivante (`Active context kept` — politique documentée).
//
// L'overlay (RemoteController) connecte un port nommé "vespry-keepalive"
// dès qu'il s'ouvre, le ferme à la destruction du panneau. Le port sert
// aussi de canal de broadcast d'état rapide (sans round-trip sendMessage).
const KEEPALIVE = 'vespry-keepalive';
const keepalivePorts = new Set<chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE) return;
  keepalivePorts.add(port);
  // Envoi initial : l'overlay reçoit l'état courant dès la connexion, sans
  // avoir à émettre un `get-state` séparé.
  try {
    port.postMessage({ kind: 'vespry-state', state: controller.toState() });
  } catch {
    /* port déjà fermé — ignoré */
  }
  port.onDisconnect.addListener(() => {
    keepalivePorts.delete(port);
  });
});

// Pousse l'état sur tous les ports keepalive à chaque changement — relais
// très peu coûteux, et l'overlay peut s'abonner sans dépendre du fan-out
// `chrome.runtime.sendMessage` (qui rate ses propres expéditeurs).
controller.subscribe(() => {
  if (keepalivePorts.size === 0) return;
  const state = controller.toState();
  for (const port of keepalivePorts) {
    try {
      port.postMessage({ kind: 'vespry-state', state });
    } catch {
      keepalivePorts.delete(port);
    }
  }
});
