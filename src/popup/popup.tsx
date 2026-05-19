/**
 * Popup Vespry — ouvre Discord et affiche les exports en cours.
 *
 * VUE : lit l'état de l'offscreen via le RemoteController. Les exports
 * continuent dans l'offscreen même popup fermé.
 */
import { type JSX, render } from 'preact';
import { useEffect, useReducer, useState } from 'preact/hooks';
import { RemoteController } from '../ui/remote-controller';
import { progressPct } from '../messaging';
import { t } from '../ui/i18n';
import { getVersion } from '../version';
import { getThemePref, resolveTheme } from '../ui/theme-pref';
import {
  computeNextFireTime, loadSchedule,
  type ScheduledExport,
} from '../engine/scheduler';
import '../ui/theme.css';
import './popup.css';

const controller = new RemoteController();

// Applique le thème choisi (partagé avec l'overlay) sur <html>.
void getThemePref().then((pref) => {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
});

function openDiscord(): void {
  void chrome.runtime.sendMessage({ kind: 'open-discord' });
}

function Popup(): JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [loaded, setLoaded] = useState(false);
  const [discordOpen, setDiscordOpen] = useState(false);
  /**
   * Planning d'export récurrent (Phase 3) — affiché dans le popup pour
   * que l'utilisateur voie d'un coup d'œil la prochaine exécution sans
   * devoir ouvrir Discord. `null` = aucun planning actif. Sam (2026-05-19) :
   * « on devrait pouvoir voir la première et la prochaine exécution ».
   */
  const [schedule, setSchedule] = useState<ScheduledExport | null>(null);

  useEffect(() => {
    const off = controller.subscribe(force as () => void);
    void controller.init().then(() => setLoaded(true));
    // Détecte si un onglet Discord est déjà ouvert → le bouton s'adapte.
    void chrome.tabs
      .query({ url: ['https://discord.com/*', 'https://*.discord.com/*'] })
      .then((tabs) => setDiscordOpen(tabs.length > 0));
    // Lecture initiale du planning + rafraîchissement à chaque modif
    // storage (l'utilisateur peut le modifier depuis l'overlay pendant
    // que le popup est ouvert ; cas rare mais propre).
    void loadSchedule(chrome.storage.local).then(setSchedule);
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area === 'local' && 'vespry.scheduled' in changes) {
        void loadSchedule(chrome.storage.local).then(setSchedule);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      off();
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const noSession = controller.error === 'no-token';
  const connected = loaded && !noSession;
  const running = controller.queue.filter((q) => q.status === 'in_progress');
  const finished = controller.queue.filter(
    (q) => (q.status === 'completed' || q.status === 'partial') && q.zipReady,
  );

  return (
    <div class="popup">
      <header class="popup__head">
        <span class="popup__logo">Vespry</span>
        {loaded && (
          <span class={`v-pill ${connected ? 'v-pill--ok' : 'v-pill--off'}`}>
            {connected ? t('popup.session_ok') : t('popup.session_off')}
          </span>
        )}
      </header>

      {running.length > 0 && (
        <div class="popup__tasks">
          {running.map((task) => {
            const pct = progressPct(task);
            return (
              <div class="popup__task" key={task.runId}>
                <div class="popup__task-row">
                  <span>{task.guildName}</span>
                  <span class="v-muted">{pct}%</span>
                </div>
                <div class="popup__bar"><i style={`width:${pct}%`} /></div>
                <div class="popup__task-sub v-muted">
                  {t('popup.task_sub', {
                    m: task.messages.toLocaleString(),
                    d: task.channelsDone,
                    t: task.channelsTotal,
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {running.length === 0 && (
        <p class="v-muted">
          {connected
            ? t('popup.no_export_connected')
            : t('popup.no_export_disconnected')}
        </p>
      )}

      {finished.length > 0 && (
        <p class="v-muted" style="font-size:12px">
          {t('popup.finished', { n: finished.length })}
        </p>
      )}

      {schedule && <ScheduleCard schedule={schedule} />}

      <button
        class={`v-btn ${discordOpen ? 'v-btn--ghost' : ''}`}
        onClick={openDiscord}
      >
        {discordOpen ? t('popup.go_discord') : t('popup.open_discord')}
      </button>

      <footer class="popup__foot v-muted">
        v{getVersion()} · {t('popup.tagline')}
      </footer>
    </div>
  );
}

/**
 * Carte « Planning actif » dans le popup — montre serveur, fréquence,
 * prochaine occurrence et dernière exécution (si déjà tirée). Sam
 * (2026-05-19) : « on devrait pouvoir voir la première et la prochaine
 * exécution ». Lecture seule — pour modifier, l'utilisateur ouvre Discord
 * → mode Avancé → section Planification.
 */
function ScheduleCard({ schedule }: { schedule: ScheduledExport }): JSX.Element {
  const now = Date.now();
  const next = computeNextFireTime(schedule, now);
  const freq = schedule.frequency === 'daily'
    ? t('schedule.frequency_daily')
    : t('schedule.frequency_weekly');
  return (
    <div class="popup__schedule">
      <div class="popup__schedule-hd">
        <span>🕒 {t('popup.schedule_active')}</span>
        <span class="v-muted">{freq}</span>
      </div>
      <div class="popup__schedule-guild">{schedule.guildName}</div>
      <div class="popup__schedule-row v-muted">
        <span>{t('popup.schedule_next')}</span>
        <span title={new Date(next).toUTCString()}>{formatRelativeFuture(next, now)}</span>
      </div>
      {schedule.lastFiredAt && (
        <div class="popup__schedule-row v-muted">
          <span>{t('popup.schedule_last')}</span>
          <span title={new Date(schedule.lastFiredAt).toUTCString()}>
            {formatRelativePast(schedule.lastFiredAt, now)}
          </span>
        </div>
      )}
    </div>
  );
}

/** « dans 3 h », « dans 2 j » — résolution adaptée à l'échelle. */
function formatRelativeFuture(target: number, now: number): string {
  const sec = Math.max(0, Math.round((target - now) / 1000));
  if (sec < 60) return t('time.in_seconds', { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t('time.in_minutes', { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t('time.in_hours', { n: h });
  const d = Math.round(h / 24);
  return t('time.in_days', { n: d });
}

/** « il y a 3 h », « il y a 2 j » — symétrique de formatRelativeFuture. */
function formatRelativePast(target: number, now: number): string {
  const sec = Math.max(0, Math.round((now - target) / 1000));
  if (sec < 60) return t('time.ago_seconds', { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t('time.ago_minutes', { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t('time.ago_hours', { n: h });
  const d = Math.round(h / 24);
  return t('time.ago_days', { n: d });
}

const root = document.getElementById('app');
if (root) render(<Popup />, root);
