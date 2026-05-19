/**
 * VespryController — orchestration de l'overlay.
 *
 * Tient le moteur (CheckpointStore + DiscordApi + ExportRunner), la file
 * d'export, et notifie l'UI Preact à chaque changement. Tourne dans le
 * content script de la page Discord.
 */
import { CheckpointStore } from '../../engine/checkpoint-store';
import { DiscordApi } from '../../engine/discord-api';
import {
  ExportRunner,
  planGuildExport,
  type RunnerLogEvent,
} from '../../engine/export-runner';
import { packageRun } from '../../engine/packager';
import { detectPerfProfile } from '../../engine/perf-profile';
import { maybeSendSchemaReport } from '../../engine/schema-report';
import { loadCredits } from '../../credits';
import type {
  AssetKind,
  ExportOptions,
  MediaSelection,
  RunStatus,
} from '../../engine/checkpoint-types';
import { DiscordApiError } from '../../engine/types';
import type { RawChannel, RawGuild, RawMessage, RawUser, Snowflake } from '../../engine/types';
import type { EnqueueExtras, PurgeItemView, VespryState } from '../../messaging';

const MAX_LOG = 250;
const ZERO_KINDS: Record<AssetKind, number> = {
  image: 0, video: 0, audio: 0, file: 0, emoji: 0, avatar: 0,
};

/**
 * Délai inter-DELETE pour la purge. Discord renvoie un 429 quand on dépasse
 * ~5 DELETE/s sur un même salon — on se cale à 200 ms (cf. tâche #4, le
 * back-off 429 dans `DiscordApi.deleteMessage` reste un filet de sécurité).
 */
const PURGE_DELAY_MS = 200;

/** Une tâche d'export dans la file. */
export interface QueueItem {
  runId: string;
  guildId: string;
  guildName: string;
  status: RunStatus;
  /** Cf. `QueueItemView.triggeredBy`. */
  triggeredBy: 'user' | 'schedule';
  channelsTotal: number;
  channelsDone: number;
  messages: number;
  /** Total estimé de messages attendus (cf. `QueueItemView.estimatedMessages`). */
  estimatedMessages: number | null;
  assetsByKind: Record<AssetKind, number>;
  reactions: number;
  /** Lignes de la mini-console (plafonné). */
  log: string[];
  zip: Blob | null;
}

/**
 * Statut d'une opération de purge (Phase 2). `failed` est réservé aux
 * erreurs fatales bloquantes (auth perdue) — les 403 / 404 ne stoppent pas
 * la file, ils incrémentent simplement les compteurs.
 */
export type PurgeStatus = 'in_progress' | 'completed' | 'partial' | 'failed';

/**
 * Une tâche de purge dans la file. Parallèle à `QueueItem` — la suppression
 * n'a rien à voir avec un export, on les juxtapose dans deux files distinctes.
 */
export interface PurgeItem {
  /** Id local (`purge_<ts>_<rand>`), indépendant de Discord. */
  runId: string;
  guildName: string;
  channelId: Snowflake;
  channelName: string;
  status: PurgeStatus;
  /** Nombre total de messages à traiter (taille de la sélection). */
  total: number;
  /** Messages traités avec succès (204) ou déjà absents (404 = idempotent). */
  done: number;
  /** Messages refusés (403) ou en erreur récupérable — traités quand même. */
  failed: number;
  /** Lignes de la mini-console (plafonné à MAX_LOG). */
  log: string[];
  /** Ids restants à supprimer — consommé par le drain, non broadcastée. */
  pending: Snowflake[];
}

const KIND_LABEL: Record<AssetKind, string> = {
  image: 'image(s)',
  video: 'vidéo(s)',
  audio: 'audio',
  file: 'fichier(s)',
  emoji: 'emoji',
  avatar: 'avatar(s)',
};

function clock(): string {
  return new Date().toLocaleTimeString('fr-FR', { hour12: false });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Demande le jeton de session au service worker.
 * Le contrôleur tourne dans l'offscreen document, qui n'a PAS accès à
 * `chrome.storage` — seul le service worker peut lire le jeton.
 */
async function requestToken(): Promise<string | null> {
  try {
    const r = await chrome.runtime.sendMessage({ kind: 'get-token' });
    const token = (r as { token?: unknown } | undefined)?.token;
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

/**
 * Vrai si le salon est une conversation privée (DM) ou un groupe DM.
 * Discord type 1 = DM, type 3 = group DM. On ne dépend pas de l'enum
 * `ChannelType` ici pour éviter un import circulaire avec checkpoint-types.
 */
function isDmLike(c: RawChannel): boolean {
  return c.type === 1 || c.type === 3;
}

/**
 * Minimum d'API requis pour découvrir les threads dans des DMs. Sous-ensemble
 * de `DiscordApi` qu'on injecte dans `collectDmThreads()` — permet aux tests
 * de fournir un faux sans construire un client complet.
 */
export interface DmThreadProbe {
  getMessages: (channelId: string, before?: string) => Promise<RawMessage[]>;
}

/**
 * Étend une liste de DMs / group DMs avec leurs threads. Fonction pure
 * paramétrée par une `DmThreadProbe` — extraite pour être directement
 * testable sans construire un VespryController complet.
 *
 * Algorithme : pour chaque salon DM/group DM, on lit les ~100 messages
 * les plus récents et on collecte tout `message.thread` rencontré.
 * Dédupliqué par id de thread. Voir le commentaire de `withDmThreads`
 * pour la limite assumée (threads ancrés plus loin que la première page
 * ne sont pas détectés).
 */
export async function collectDmThreads(
  api: DmThreadProbe,
  channels: RawChannel[],
): Promise<RawChannel[]> {
  const threads = new Map<string, RawChannel>();
  for (const ch of channels) {
    if (!isDmLike(ch)) continue;
    try {
      const recent = await api.getMessages(ch.id);
      for (const m of recent) {
        if (m.thread) threads.set(m.thread.id, m.thread);
      }
    } catch {
      /* DM inaccessible (révoqué, vidé) — ignoré */
    }
  }
  return [...channels, ...threads.values()];
}

/** Nom d'affichage d'une conversation privée, dérivé de ses destinataires. */
function dmName(c: RawChannel): string {
  const names = (c.recipients ?? []).map((r) => r.global_name ?? r.username);
  return names.length > 0 ? names.join(', ') : 'Conversation';
}

function formatLog(e: RunnerLogEvent): string {
  switch (e.type) {
    case 'channel-start':
      return `${clock()}  → #${e.channel}…`;
    case 'batch':
      return `${clock()}  #${e.channel} · +${e.count} msg`;
    case 'media':
      return `${clock()}  #${e.channel} · ↓ ${e.count} ${KIND_LABEL[e.kind]}`;
    case 'channel-done':
      return `${clock()}  ✓ #${e.channel} — ${e.total} msg`;
  }
}

/** Ajoute une ligne à un log plafonné (mute la dernière ligne si dépassement). */
function pushLog(log: string[], line: string): void {
  log.push(line);
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

export class VespryController {
  readonly store = new CheckpointStore();
  api: DiscordApi | null = null;
  currentUser: RawUser | null = null;
  guilds: RawGuild[] = [];
  queue: QueueItem[] = [];
  /**
   * File des opérations de purge (Phase 2 — suppression de messages).
   * Indépendante de la file d'export : on peut purger un salon pendant
   * qu'un export tourne ailleurs.
   */
  purgeQueue: PurgeItem[] = [];
  /** `no-token` si la session Discord n'a pas été captée. */
  error: string | null = null;
  ready = false;

  private draining = false;
  /** Vrai tant qu'une purge est en cours (singleton de file). */
  private purging = false;
  /** Vrai tant qu'un `watchForToken` tourne — empêche les doublons. */
  private watching = false;
  private readonly listeners = new Set<() => void>();

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  /**
   * Initialise le moteur. `ready` passe vite à `true` (pas de blocage).
   *
   * Si le jeton n'est pas encore là, l'overlay affiche « pas de session »
   * MAIS le moteur surveille en arrière-plan : dès que le bridge capte le
   * jeton (Discord émet une requête), la session se charge toute seule.
   */
  async init(): Promise<void> {
    try {
      await this.store.init();
      for (const run of await this.store.listRuns()) {
        this.queue.push(
          await this.rebuildItem(run.id, run.guildName, run.guildId, run.status),
        );
      }
    } catch (e) {
      this.error = `Erreur d'initialisation : ${e instanceof Error ? e.message : String(e)}`;
      this.ready = true;
      this.notify();
      return;
    }

    const token = await requestToken();
    if (token) await this.loadSession(token);
    if (!this.api) {
      // Pas de session valide : on affiche « non connecté » et on surveille
      // l'arrivée d'un jeton frais (reconnexion à Discord).
      if (!this.error) this.error = 'no-token';
      void this.watchForToken();
    }
    this.ready = true;
    this.notify();
    void this.drain();
  }

  /**
   * Charge la session Discord (utilisateur + serveurs). Renvoie `true` si la
   * session est valide.
   *
   * Sur un 401, on repasse en « non connecté » (pour ne pas afficher une
   * fausse session active) MAIS on n'efface PAS le jeton stocké : un 401
   * passager (Cloudflare, pic) ne doit jamais faire perdre un jeton valide.
   * `watchForToken` réessaiera ; une vraie reconnexion fera capter un jeton
   * frais par le bridge, qui écrasera l'ancien.
   */
  private async loadSession(token: string): Promise<boolean> {
    this.api = new DiscordApi({ token });
    try {
      const [user, guilds] = await Promise.all([
        this.api.getCurrentUser(),
        this.api.getGuilds(),
      ]);
      this.currentUser = user;
      this.guilds = guilds;
      this.error = null;
      return true;
    } catch (e) {
      this.api = null;
      this.currentUser = null;
      this.guilds = [];
      this.error = e instanceof DiscordApiError && e.kind === 'auth'
        ? 'no-token'
        : (e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  /**
   * Surveille l'arrivée d'un jeton valide (premier lancement ou reconnexion
   * après un 401). Le bridge capte le jeton dès que Discord émet une requête
   * API ; dès qu'une session valide se charge, on notifie — rétablissement
   * automatique. Un seul watcher à la fois (`this.watching`).
   */
  private async watchForToken(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    try {
      for (let i = 0; i < 240; i += 1) {
        await sleep(2500);
        if (this.api) return; // session chargée entre-temps
        const token = await requestToken();
        if (token && (await this.loadSession(token))) {
          this.notify();
          void this.drain();
          return;
        }
      }
    } finally {
      this.watching = false;
    }
  }

  /**
   * Charge les salons d'un serveur — ou les conversations privées si
   * `guildId` vaut `'@me'` (pour la sidebar de sélection).
   */
  async loadChannels(guildId: string): Promise<RawChannel[]> {
    if (!this.api) return [];
    if (guildId === '@me') {
      const dms = await this.api.getDmChannels();
      return dms.map((c) => ({ ...c, name: c.name ?? dmName(c) }));
    }
    return this.api.getGuildChannels(guildId);
  }

  /**
   * Estimation rapide du nombre de messages attendus pour un ensemble
   * de salons, AVANT lancement d'un export. Volontairement rapide :
   * 3 workers parallèles, pas de dichotomie. Si un salon est plafonné
   * à 8000 messages on garde 8000 (sous-estimé, mais utile pour décider
   * si afficher l'avertissement « gros export » à 10k+).
   *
   * `null` si toutes les recherches ont échoué (perms, rate-limit).
   *
   * Cf. Sam 2026-05-19 : le bon proxy pour l'avertissement n'est pas
   * le nombre de salons mais le nombre de messages.
   */
  async estimateMessages(
    guildId: string,
    channelIds: string[],
  ): Promise<number | null> {
    if (!this.api || channelIds.length === 0) return 0;
    const isDmGuild = !guildId || guildId === '@me';
    const counts: (number | null)[] = new Array(channelIds.length).fill(null);
    let cursor = 0;
    const next = (): number | null => {
      if (cursor >= channelIds.length) return null;
      const i = cursor;
      cursor += 1;
      return i;
    };
    const CONCURRENCY = 3;
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, channelIds.length) },
      async () => {
        if (!this.api) return;
        for (;;) {
          const i = next();
          if (i === null) return;
          const id = channelIds[i];
          if (!id) return;
          counts[i] = isDmGuild
            ? await this.api.searchDmMessageCount(id)
            : await this.api.searchMessageCount(guildId, id);
        }
      },
    );
    await Promise.all(workers);
    const anyOk = counts.some((c) => c !== null);
    if (!anyOk) return null;
    return counts.reduce<number>((s, c) => s + (c ?? 0), 0);
  }

  /**
   * Aperçu des messages d'un salon (lecture seule, une page ~100).
   * `before` = id de message → page plus ancienne (défilement de l'historique).
   */
  async previewChannel(channelId: string, before?: string): Promise<RawMessage[]> {
    if (!this.api) return [];
    try {
      return await this.api.getMessages(channelId, before);
    } catch {
      return [];
    }
  }

  /**
   * Étend la liste de salons avec leurs threads — actifs, et archivés
   * publics ET privés. Couvre aussi les posts de forum (qui sont des
   * threads). Dédupliqué par id. Un thread est un salon comme un autre
   * pour le moteur d'export.
   */
  private async withThreads(
    guildId: string,
    channels: RawChannel[],
  ): Promise<RawChannel[]> {
    if (!this.api) return channels;
    const selected = new Set(channels.map((c) => c.id));
    const threads = new Map<string, RawChannel>();
    try {
      for (const th of await this.api.getActiveThreads(guildId)) {
        if (th.parent_id && selected.has(th.parent_id)) threads.set(th.id, th);
      }
    } catch {
      /* threads actifs indisponibles — sans gravité */
    }
    for (const ch of channels) {
      for (const visibility of ['public', 'private'] as const) {
        try {
          for (const th of await this.api.getArchivedThreads(ch.id, visibility)) {
            threads.set(th.id, th);
          }
        } catch {
          /* salon sans threads de ce type ou accès refusé — ignoré */
        }
      }
    }
    return [...channels, ...threads.values()];
  }

  /**
   * Étend une liste de DMs / group DMs avec leurs threads.
   *
   * Pourquoi un chemin séparé. Discord expose `GET /guilds/{id}/threads/active`
   * et `GET /channels/{id}/threads/archived/{public|private}` UNIQUEMENT pour
   * les guilds — il n'y a pas d'équivalent pour les DMs (cf. dev portal,
   * 2025). Les threads de DM ne sont découvrables qu'à travers le champ
   * `message.thread` quand un message a ouvert un fil. On parcourt donc
   * la page la plus récente de messages de chaque conversation (~100) et
   * on collecte chaque thread non nul, dédupliqué par id.
   *
   * Limite assumée et documentée : les threads dont le message d'origine
   * est plus ancien que les 100 derniers messages d'un DM ne sont PAS
   * détectés. Une exploration plus profonde (paginer avant) serait coûteuse
   * pour un gain marginal — les utilisateurs ouvrant un thread dans un DM
   * y restent généralement actifs, donc le message d'ancrage reste récent.
   * Si Sam veut couvrir le cas inverse, on ajoutera un mode « profond »
   * paginé en arrière, opt-in pour ne pas tripler le temps d'extension.
   */
  private async withDmThreads(channels: RawChannel[]): Promise<RawChannel[]> {
    if (!this.api) return channels;
    return collectDmThreads(this.api, channels);
  }

  /** Lit l'URL du Worker depuis credits.json — pour les fetchs tiers. */
  private async donorApiUrl(): Promise<string> {
    return (await loadCredits()).donorApiUrl;
  }

  /**
   * Date de début du dernier export abouti d'un serveur — sert de plancher
   * à l'export incrémental. `undefined` si le serveur n'a jamais été exporté.
   */
  private async lastExportTime(guildId: string): Promise<number | undefined> {
    const runs = await this.store.listRuns(); // déjà trié récent → ancien
    const prev = runs.find(
      (r) => r.guildId === guildId
        && (r.status === 'completed' || r.status === 'partial'),
    );
    return prev?.createdAt;
  }

  /**
   * Ajoute une tâche d'export à la file et lance le traitement.
   *
   * `triggeredBy` indique l'origine du run :
   *   - `'user'` (défaut) : clic « Lancer l'exportation » dans l'overlay.
   *   - `'schedule'` : déclenché par `chrome.alarms` (Phase 3, daily/weekly).
   *
   * Propagé jusqu'à la `QueueItemView` puis au badge icône pour distinguer
   * visuellement les deux cas. Cf. feedback Sam (2026-05-19).
   */
  async enqueue(
    guild: RawGuild,
    channels: RawChannel[],
    media: MediaSelection,
    extras: EnqueueExtras,
    triggeredBy: 'user' | 'schedule' = 'user',
  ): Promise<void> {
    const { incremental, ...rest } = extras;
    const options: ExportOptions = { media, ...rest };
    // Export incrémental : plancher temporel = début du dernier export abouti.
    // Quand l'utilisateur coche « incrémental » mais n'a jamais exporté ce
    // serveur, le `sinceMs` reste indéfini et le run est en fait un export
    // complet — c'était silencieux et trompeur. On garde l'export complet
    // (c'est le bon comportement), mais on signale clairement dans le log.
    let incrementalNote: string | null = null;
    if (incremental) {
      const since = await this.lastExportTime(guild.id);
      if (since !== undefined) {
        options.sinceMs = since;
        const d = new Date(since).toISOString().replace('T', ' ').slice(0, 16);
        incrementalNote = `↻ Export incrémental — messages postés depuis ${d} UTC.`;
      } else {
        incrementalNote = '↻ Incrémental coché mais aucun export précédent pour ce serveur — premier export complet.';
      }
    }
    // `includeThreads` est désormais respecté aussi pour les DMs : on
    // utilise un chemin séparé (`withDmThreads`) qui découvre les fils
    // via `message.thread` plutôt que via les endpoints `/threads/active`
    // (réservés aux guilds). Cf. commentaire sur la méthode.
    let expanded = channels;
    if (extras.includeThreads) {
      expanded = guild.id === '@me'
        ? await this.withDmThreads(channels)
        : await this.withThreads(guild.id, channels);
    }
    const runId = await planGuildExport(this.store, guild, expanded, options);
    const initialLog: string[] = [];
    if (incrementalNote) initialLog.push(`${clock()}  ${incrementalNote}`);
    this.queue.push({
      runId,
      guildId: guild.id,
      guildName: guild.name,
      status: 'in_progress',
      triggeredBy,
      channelsTotal: expanded.length,
      channelsDone: 0,
      messages: 0,
      // null = pré-comptage pas encore exécuté (le runner le calcule au
      // démarrage et le pousse via onProgress). La UI affichera une barre
      // indéterminée pendant cette ~1 s, puis fluide quand l'estimation
      // arrive.
      estimatedMessages: null,
      assetsByKind: { ...ZERO_KINDS },
      reactions: 0,
      log: initialLog,
      zip: null,
    });
    this.notify();
    void this.drain();
  }

  /**
   * Phase 2 — purge de messages dans un salon.
   *
   * Garde-fous côté UI (cf. tâche #6) : la modale de confirmation a déjà
   * exigé une frappe explicite de l'utilisateur. Côté contrôleur on fait
   * confiance à `messageIds` — c'est la sélection cochée dans l'aperçu.
   *
   * Crée une `PurgeItem` dans `purgeQueue` et lance le drain. Le moteur
   * traite la file en série, ~5/s (cf. `PURGE_DELAY_MS`), avec back-off
   * 429 hérité de `DiscordApi.deleteMessage`. On poursuit sur 403 / 404
   * et on stoppe net sur 401 (session morte).
   *
   * Renvoie l'id local de la purge (utile à l'overlay pour cibler l'item
   * dans la console).
   */
  async purgeMessages(
    guild: RawGuild,
    channelId: Snowflake,
    channelName: string,
    messageIds: Snowflake[],
  ): Promise<string> {
    const runId = `purge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const item: PurgeItem = {
      runId,
      guildName: guild.name,
      channelId,
      channelName,
      status: 'in_progress',
      total: messageIds.length,
      done: 0,
      failed: 0,
      log: [],
      pending: [...messageIds],
    };

    if (messageIds.length === 0) {
      // Cas dégénéré : rien à supprimer. On marque completed et on notifie.
      // L'UI affichera « 0/0 supprimés » — légitime si la sélection vide.
      item.status = 'completed';
      pushLog(item.log, `${clock()}  ⚠ aucun message à supprimer`);
      this.purgeQueue.push(item);
      this.notify();
      return runId;
    }

    if (!this.api) {
      item.status = 'failed';
      pushLog(item.log, `${clock()}  ✗ pas de session Discord active`);
      this.purgeQueue.push(item);
      this.notify();
      return runId;
    }

    pushLog(
      item.log,
      `${clock()}  🗑 purge de ${messageIds.length} message(s) dans #${channelName}`,
    );
    this.purgeQueue.push(item);
    this.notify();
    void this.drainPurge();
    return runId;
  }

  /**
   * Traite la file de purge en série. Tolérant aux appels concurrents
   * (`this.purging`) — l'overlay peut lancer plusieurs purges, on les
   * enchaîne sans retour.
   */
  private async drainPurge(): Promise<void> {
    if (this.purging) return;
    this.purging = true;
    try {
      for (;;) {
        const item = this.purgeQueue.find((p) => p.status === 'in_progress');
        if (!item) break;
        await this.runPurgeItem(item);
      }
    } finally {
      this.purging = false;
    }
  }

  /** Traite tous les ids restants d'une `PurgeItem`. */
  private async runPurgeItem(item: PurgeItem): Promise<void> {
    if (!this.api) {
      item.status = 'failed';
      pushLog(item.log, `${clock()}  ✗ session Discord perdue`);
      this.notify();
      return;
    }

    // Bornes pour logguer la progression sans saturer la console — un
    // tick toutes les ~10 % d'avancement, et toujours sur le dernier.
    const logEvery = Math.max(1, Math.floor(item.total / 10));

    while (item.pending.length > 0) {
      const messageId = item.pending.shift();
      if (messageId === undefined) break;

      try {
        await this.api.deleteMessage(item.channelId, messageId);
        // `DiscordApi.deleteMessage` résout sur 204 ET sur 404 (idempotent
        // côté tâche #4). On agrège les deux dans `done` — l'utilisateur
        // voit « X / Y supprimés » sans distinction utile.
        item.done += 1;
      } catch (e) {
        if (e instanceof DiscordApiError) {
          if (e.kind === 'auth') {
            // Session morte — la suite est sans espoir. On stoppe la file
            // proprement avec un message clair, l'utilisateur reconnecte
            // Discord et relance la purge (les ids restants sont déjà sortis
            // de `pending`, donc le redémarrage repart de zéro côté UI ;
            // pour la v1 c'est acceptable, on documentera dans #6).
            pushLog(
              item.log,
              `${clock()}  ✗ session Discord expirée — reconnecte-toi puis relance la purge`,
            );
            item.status = 'failed';
            this.notify();
            return;
          }
          if (e.kind === 'forbidden') {
            item.failed += 1;
            pushLog(
              item.log,
              `${clock()}  ⊘ 403 sur message ${messageId} — accès refusé`,
            );
          } else {
            item.failed += 1;
            pushLog(
              item.log,
              `${clock()}  ✗ message ${messageId} — ${e.message}`,
            );
          }
        } else {
          // Erreur inattendue (réseau, parsing) — on incrémente et on
          // continue, l'utilisateur saura en lisant le log.
          item.failed += 1;
          pushLog(
            item.log,
            `${clock()}  ✗ message ${messageId} — `
            + (e instanceof Error ? e.message : String(e)),
          );
        }
      }

      const processed = item.done + item.failed;
      if (processed % logEvery === 0 || item.pending.length === 0) {
        pushLog(
          item.log,
          `${clock()}  · ${processed}/${item.total} traités (`
          + `${item.done} OK, ${item.failed} échec)`,
        );
      }
      this.notify();

      // Throttle inter-DELETE. On le saute sur le dernier message
      // (200 ms perçues en moins à la fin).
      if (item.pending.length > 0) await sleep(PURGE_DELAY_MS);
    }

    // Bilan final.
    item.status = item.failed > 0 ? 'partial' : 'completed';
    pushLog(
      item.log,
      `${clock()}  ${item.failed > 0 ? '⚠' : '✓'} terminé — `
      + `${item.done} supprimé(s), ${item.failed} échec(s)`,
    );

    // Notification système (toast natif). Le service worker écoute déjà
    // les broadcasts d'état et peut afficher un toast en transition de
    // status (`in_progress` → `completed`/`partial`) — pas besoin d'un
    // message ad-hoc pour ce premier shipping.
    this.notify();
  }

  /** Reprend une tâche mise en pause (après reconnexion à Discord). */
  resume(runId: string): void {
    const item = this.queue.find((q) => q.runId === runId);
    if (item && item.status === 'paused') {
      item.status = 'in_progress';
      this.notify();
      void this.drain();
    }
  }

  /**
   * Télécharge le zip d'une tâche terminée. Le contrôleur tourne dans
   * l'offscreen document : on crée l'URL du blob et on délègue le
   * téléchargement au service worker (chrome.downloads).
   *
   * `filenameOverride` est calculé côté UI à partir du template utilisateur
   * (Phase 3 — templates de zip). Sans override on retombe sur le défaut
   * historique `vespry-${safe(guildName)}.zip`.
   */
  downloadZip(runId: string, filenameOverride?: string): void {
    const item = this.queue.find((q) => q.runId === runId);
    if (!item?.zip) return;
    const url = URL.createObjectURL(item.zip);
    const filename = filenameOverride
      ?? `vespry-${item.guildName.replace(/[^\w-]/gu, '_')}.zip`;
    void chrome.runtime.sendMessage({ kind: 'do-download', url, filename });
  }

  /** Projette l'état dans une forme sérialisable pour les vues. */
  toState(): VespryState {
    return {
      ready: this.ready,
      error: this.error,
      userName: this.currentUser?.global_name ?? this.currentUser?.username ?? null,
      guilds: this.guilds,
      queue: this.queue.map((q) => ({
        runId: q.runId,
        guildName: q.guildName,
        status: q.status,
        triggeredBy: q.triggeredBy,
        channelsTotal: q.channelsTotal,
        channelsDone: q.channelsDone,
        messages: q.messages,
        estimatedMessages: q.estimatedMessages,
        assetsByKind: q.assetsByKind,
        reactions: q.reactions,
        log: q.log,
        zipReady: q.zip !== null,
      })),
      purgeQueue: this.purgeQueue.map((p): PurgeItemView => ({
        runId: p.runId,
        guildName: p.guildName,
        channelId: p.channelId,
        channelName: p.channelName,
        status: p.status,
        total: p.total,
        done: p.done,
        failed: p.failed,
        // On exclut `pending` du broadcast — c'est de la donnée interne
        // (potentiellement des milliers d'ids) sans valeur pour l'UI.
        log: p.log,
      })),
    };
  }

  /** Traite la file séquentiellement — une tâche active à la fois. */
  private async drain(): Promise<void> {
    if (this.draining || !this.api) return;
    this.draining = true;
    try {
      for (;;) {
        const item = this.queue.find((q) => q.status === 'in_progress');
        if (!item) break;
        await this.runItem(item);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runItem(item: QueueItem): Promise<void> {
    if (!this.api) return;
    // Concurrence salons adaptative : `parallelChannels` est issu du profil
    // de performance (Phase 1) — 3 sur machine puissante, 1 sur RAM faible.
    // Capé en interne à 3 (rate-limit Discord). On le détecte par run pour
    // refléter une éventuelle évolution (passage en mode économie d'énergie).
    const profile = detectPerfProfile();
    const runner = new ExportRunner(
      this.api,
      this.store,
      {
        onProgress: (s) => {
          item.channelsTotal = s.channelsTotal;
          item.channelsDone = s.channelsDone;
          item.messages = s.messagesTotal;
          item.estimatedMessages = s.estimatedMessagesTotal;
          item.assetsByKind = s.assetsByKind;
          item.reactions = s.reactions;
          this.notify();
        },
        onLog: (e) => {
          pushLog(item.log, formatLog(e));
          this.notify();
        },
      },
      { channelConcurrency: profile.parallelChannels },
    );
    let status: RunStatus;
    try {
      status = await runner.run(item.runId);
    } catch (e) {
      status = 'failed';
      pushLog(item.log, `${clock()}  ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
    item.status = status;
    if (status === 'completed' || status === 'partial') {
      const { blob } = await packageRun(this.store, item.runId);
      item.zip = blob;
      pushLog(item.log, `${clock()}  📦 Paquet prêt — ${(blob.size / 1e6).toFixed(1)} Mo`);
    }
    // Si l'utilisateur a opt-in à la télémétrie de schéma, on envoie un
    // rapport minimal (version + locale + champs Discord inconnus). Sans
    // contenu de message ni id ; idempotent par signature locale.
    void maybeSendSchemaReport(await this.donorApiUrl());
    this.notify();
  }

  /** Reconstruit une tâche depuis le store (runs repris au démarrage). */
  private async rebuildItem(
    runId: string,
    guildName: string,
    guildId: string,
    status: RunStatus,
  ): Promise<QueueItem> {
    const channels = await this.store.getChannels(runId);
    const assets = await this.store.getAssets(runId);
    const byKind: Record<AssetKind, number> = { ...ZERO_KINDS };
    for (const a of assets) {
      if (a.status === 'done') byKind[a.kind] += 1;
    }
    return {
      runId,
      guildId,
      guildName,
      status,
      // L'info `triggeredBy` n'est pas persistée dans le checkpoint —
      // un run repris au démarrage suivant est traité comme `'user'` par
      // défaut. Acceptable : un run planifié qui crashe a peu de chances
      // d'être repris depuis le popup, c'est juste pour le badge.
      triggeredBy: 'user',
      channelsTotal: channels.length,
      channelsDone: channels.filter((c) => c.status === 'done' || c.status === 'partial').length,
      messages: channels.reduce((s, c) => s + c.messageCount, 0),
      // Le run repris n'a pas refait de pré-comptage — le runner va re-tirer
      // l'estimation au prochain `run()`, donc null en attendant.
      estimatedMessages: null,
      assetsByKind: byKind,
      reactions: 0,
      log: [`${clock()}  ↻ run repris depuis le checkpoint`],
      zip: null,
    };
  }
}
