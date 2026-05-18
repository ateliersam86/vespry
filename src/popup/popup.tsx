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

  useEffect(() => {
    const off = controller.subscribe(force as () => void);
    void controller.init().then(() => setLoaded(true));
    // Détecte si un onglet Discord est déjà ouvert → le bouton s'adapte.
    void chrome.tabs
      .query({ url: ['https://discord.com/*', 'https://*.discord.com/*'] })
      .then((tabs) => setDiscordOpen(tabs.length > 0));
    return off;
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

const root = document.getElementById('app');
if (root) render(<Popup />, root);
