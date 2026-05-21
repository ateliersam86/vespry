/**
 * Popup Vespry — ouvre Discord et affiche les exports en cours.
 *
 * VUE : lit l'état de l'offscreen via le RemoteController. Les exports
 * continuent dans l'offscreen même popup fermé.
 */
import { type JSX, render } from 'preact';
import { useEffect, useReducer, useState } from 'preact/hooks';
import { RemoteController } from '../ui/remote-controller';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { progressPct } from '../messaging';
import { t } from '../ui/i18n';
import { formatRelativeFuture, formatRelativePast } from '../ui/relative-time';
import { reportProblem } from '../diagnostics';
import { resetAllVespryData } from '../ui/reset-vespry';
import { checkForUpdate, getVersion } from '../version';
import { getThemePref, resolveTheme } from '../ui/theme-pref';
import {
  computeNextFireTime, loadSchedule,
  type ScheduledExport,
} from '../engine/scheduler';
import type { ExportRunSummary } from '../messaging';
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
  /**
   * Version GitHub plus récente que celle actuelle, si l'API GitHub
   * répond et qu'une release tag a été créée depuis. `null` = pas de
   * update dispo / GitHub inaccessible. Affiché en bannière discrète
   * sous le header. Helper checkForUpdate() pingue api.github.com —
   * documenté dans PRIVACY.md (4e sortie réseau).
   */
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  /**
   * Historique des exports précédents (chargé une fois au montage du
   * popup, max 5 affichés). Sam (2026-05-19) : « continue avec
   * l'historique et les autres fonctions non implémentées ».
   */
  const [history, setHistory] = useState<ExportRunSummary[]>([]);

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
    // Notif d'update : silencieux si pas de release plus récente, sinon
    // bannière. L'utilisateur clique pour ouvrir la release GitHub.
    // Pingue api.github.com (cf. PRIVACY.md § 6 — sortie réseau auxiliaire).
    void checkForUpdate().then(setLatestVersion);
    // Historique des exports — chargé une fois, rafraîchi à chaque
    // ouverture du popup (acceptable : on est sur du IDB local, lecture
    // rapide ~10 ms). Limité aux 10 derniers pour ne pas saturer.
    void controller.listRuns().then((all) => setHistory(all.slice(0, 10)));
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
      {latestVersion && (
        /* Bannière update — cliquable, ouvre la release GitHub. Présente
           uniquement si une version plus récente a été détectée
           (checkForUpdate retourne null dans tous les autres cas). */
        <a
          class="popup__update"
          href={`https://github.com/ateliersam86/vespry/releases/tag/v${latestVersion}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('popup.update_available', { v: latestVersion })}
        </a>
      )}

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

      {history.length > 0 && (
        <HistoryCard
          runs={history}
          onDelete={(runId) => {
            void controller.deleteRun(runId);
            setHistory(history.filter((r) => r.runId !== runId));
          }}
        />
      )}

      <button
        class={`v-btn ${discordOpen ? 'v-btn--ghost' : ''}`}
        onClick={openDiscord}
      >
        {discordOpen ? t('popup.go_discord') : t('popup.open_discord')}
      </button>

      <button
        class="popup__replay-tuto"
        onClick={() => {
          // Reset les flags tuto (vespry.tutoCompleted + firstSeenOnDiscord).
          // Le content-script écoute storage.onChanged et relance le tuto
          // immédiatement, peu importe que l'overlay soit ouvert ou non.
          // Cf. content-script.ts § 3 (« tuto : premier launch + bouton
          // Revoir »). Si Discord n'est pas ouvert dans aucun onglet, on
          // l'ouvre — le tuto démarrera au chargement.
          void chrome.storage.local.set({
            'vespry.tutoCompleted': false,
            'vespry.firstSeenOnDiscord': false,
          });
          if (!discordOpen) openDiscord();
        }}
      >
        {t('popup.review_tuto')}
      </button>

      <ResetSection />

      <footer class="popup__foot v-muted">
        v{getVersion()} · {t('popup.tagline')}
        {' · '}
        <span
          class="popup__report"
          onClick={() => {
            // Ouvre une issue GitHub pré-remplie avec env + journal 60 lignes
            // + champs Discord inconnus détectés. Sans contenu de messages
            // ni jeton. Cf. src/diagnostics.ts pour le détail du rapport.
            void reportProblem('Problème signalé depuis le popup Vespry');
          }}
        >
          {t('report.problem')}
        </span>
      </footer>
    </div>
  );
}

/**
 * Section « Réinitialisation Vespry » dans le footer du popup.
 *
 * Trois états : (1) bouton replié (ghost discret), (2) modale de
 * confirmation listant ce qui sera purgé, (3) post-reset avec récap.
 * L'utilisateur doit cliquer DEUX fois (bouton replié + bouton danger
 * dans la modale) pour éviter les clics accidentels.
 *
 * Cf. feedback Sam 2026-05-21 : « un système pour nettoyer toutes les
 * données liées à Vespry en cas de bug par rapport à l'historique de
 * sauvegarde ou autre. Il faut prévoir tous les problèmes. »
 */
function ResetSection(): JSX.Element {
  type Stage = 'closed' | 'confirm' | 'done' | 'partial' | 'failed';
  const [stage, setStage] = useState<Stage>('closed');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');

  async function confirmReset(): Promise<void> {
    setBusy(true);
    try {
      const r = await resetAllVespryData();
      setSummary(r.summary);
      // Triplet d'états honnête : succès complet, succès partiel (IDB
      // bloquée mais préférences purgées), échec total. Cf. audit Codex
      // 2026-05-22 #3 : on ne dit plus « réinitialisé » si ok=false.
      if (!r.ok) setStage('failed');
      else if (r.blocked) setStage('partial');
      else setStage('done');
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'closed') {
    return (
      <button class="popup__reset-trigger" onClick={() => setStage('confirm')}>
        {t('reset.trigger')}
      </button>
    );
  }
  if (stage === 'done') {
    return (
      <div class="popup__reset-done">
        <strong>{t('reset.done_title')}</strong>
        <div class="popup__reset-summary">{summary}</div>
        <div class="popup__reset-help">{t('reset.done_help')}</div>
      </div>
    );
  }
  if (stage === 'partial') {
    return (
      <div class="popup__reset-partial">
        <strong>{t('reset.partial_title')}</strong>
        <div class="popup__reset-summary">{summary}</div>
        <div class="popup__reset-help">{t('reset.partial_help')}</div>
      </div>
    );
  }
  if (stage === 'failed') {
    return (
      <div class="popup__reset-failed">
        <strong>{t('reset.failed_title')}</strong>
        <div class="popup__reset-summary">{summary}</div>
        <button
          class="popup__reset-confirm"
          onClick={() => setStage('confirm')}
        >
          {t('reset.retry')}
        </button>
      </div>
    );
  }
  return (
    <div class="popup__reset-modal">
      <strong>{t('reset.confirm_title')}</strong>
      <ul class="popup__reset-list">
        <li>{t('reset.item_history')}</li>
        <li>{t('reset.item_prefs')}</li>
        <li>{t('reset.item_schedule')}</li>
        <li>{t('reset.item_tuto')}</li>
        <li>{t('reset.item_token')}</li>
      </ul>
      <div class="popup__reset-actions">
        <button class="popup__reset-cancel" onClick={() => setStage('closed')}>
          {t('reset.cancel')}
        </button>
        <button
          class="popup__reset-confirm"
          disabled={busy}
          onClick={() => void confirmReset()}
        >
          {busy ? t('reset.busy') : t('reset.confirm')}
        </button>
      </div>
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

/**
 * Section « Historique des exports » dans le popup. Lecture seule —
 * pour supprimer, l'utilisateur clique sur la croix de chaque entrée.
 * Pas de bouton « re-télécharger » pour les vieux runs : le blob du
 * zip n'est plus en RAM côté controller, seulement les métadonnées et
 * messages dans IDB. Pour récupérer le zip, l'utilisateur relance un
 * export (incrémental ou complet selon ses besoins).
 *
 * Cf. Sam 2026-05-19 : « continue avec l'historique ».
 */
function HistoryCard({
  runs,
  onDelete,
}: {
  runs: ExportRunSummary[];
  onDelete: (runId: string) => void;
}): JSX.Element {
  const now = Date.now();
  return (
    <div class="popup__history">
      <div class="popup__history-hd">📜 {t('popup.history_title')}</div>
      {runs.map((r) => (
        <div class="popup__history-row" key={r.runId}>
          <div class="popup__history-main">
            <div class="popup__history-guild">{r.guildName}</div>
            <div class="v-muted" style="font-size:11px">
              {formatRelativePast(r.createdAt, now)}
              {' · '}
              {r.messageCount.toLocaleString()} {t('popup.history_msg')}
              {' · '}
              <span class={`popup__history-status popup__history-status--${r.status}`}>
                {t(`status.${r.status}`)}
              </span>
            </div>
          </div>
          <button
            class="popup__history-del"
            title={t('popup.history_delete')}
            onClick={() => onDelete(r.runId)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// formatRelativeFuture / formatRelativePast vivent désormais dans
// `src/ui/relative-time.ts` (partage avec l'overlay). Cf. import en haut.

const root = document.getElementById('app');
if (root) {
  render(
    <ErrorBoundary context="popup">
      <Popup />
    </ErrorBoundary>,
    root,
  );
}
