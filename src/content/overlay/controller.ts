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
import type {
  AssetKind,
  ExportOptions,
  MediaSelection,
  RunStatus,
} from '../../engine/checkpoint-types';
import type { RawChannel, RawGuild, RawUser } from '../../engine/types';
import type { VespryState } from '../../messaging';

const MAX_LOG = 250;
const ZERO_KINDS: Record<AssetKind, number> = {
  image: 0, video: 0, audio: 0, file: 0, emoji: 0, avatar: 0,
};

/** Une tâche d'export dans la file. */
export interface QueueItem {
  runId: string;
  guildId: string;
  guildName: string;
  status: RunStatus;
  channelsTotal: number;
  channelsDone: number;
  messages: number;
  assetsByKind: Record<AssetKind, number>;
  reactions: number;
  /** Lignes de la mini-console (plafonné). */
  log: string[];
  zip: Blob | null;
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

export class VespryController {
  readonly store = new CheckpointStore();
  api: DiscordApi | null = null;
  currentUser: RawUser | null = null;
  guilds: RawGuild[] = [];
  queue: QueueItem[] = [];
  /** `no-token` si la session Discord n'a pas été captée. */
  error: string | null = null;
  ready = false;

  private draining = false;
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
    if (token) {
      await this.loadSession(token);
    } else {
      this.error = 'no-token';
      void this.watchForToken();
    }
    this.ready = true;
    this.notify();
    void this.drain();
  }

  /** Charge la session Discord : utilisateur + serveurs. */
  private async loadSession(token: string): Promise<void> {
    this.error = null;
    this.api = new DiscordApi({ token });
    try {
      const [user, guilds] = await Promise.all([
        this.api.getCurrentUser(),
        this.api.getGuilds(),
      ]);
      this.currentUser = user;
      this.guilds = guilds;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Surveille l'arrivée du jeton après l'init. Le bridge peut le capter avec
   * un léger retard (dès que Discord émet une requête API). Dès qu'il
   * apparaît, on charge la session et on notifie — rétablissement automatique.
   */
  private async watchForToken(): Promise<void> {
    for (let i = 0; i < 120; i += 1) {
      await sleep(2500);
      const token = await requestToken();
      if (token) {
        await this.loadSession(token);
        this.notify();
        void this.drain();
        return;
      }
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

  /** Ajoute une tâche d'export à la file et lance le traitement. */
  async enqueue(
    guild: RawGuild,
    channels: RawChannel[],
    media: MediaSelection,
    range: { afterMs?: number; beforeMs?: number },
    includeThreads: boolean,
  ): Promise<void> {
    const options: ExportOptions = {
      includeThreads,
      media,
      ...(range.afterMs !== undefined ? { afterMs: range.afterMs } : {}),
      ...(range.beforeMs !== undefined ? { beforeMs: range.beforeMs } : {}),
    };
    const expanded = includeThreads && guild.id !== '@me'
      ? await this.withThreads(guild.id, channels)
      : channels;
    const runId = await planGuildExport(this.store, guild, expanded, options);
    this.queue.push({
      runId,
      guildId: guild.id,
      guildName: guild.name,
      status: 'in_progress',
      channelsTotal: expanded.length,
      channelsDone: 0,
      messages: 0,
      assetsByKind: { ...ZERO_KINDS },
      reactions: 0,
      log: [],
      zip: null,
    });
    this.notify();
    void this.drain();
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
   */
  downloadZip(runId: string): void {
    const item = this.queue.find((q) => q.runId === runId);
    if (!item?.zip) return;
    const url = URL.createObjectURL(item.zip);
    const filename = `vespry-${item.guildName.replace(/[^\w-]/gu, '_')}.zip`;
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
        channelsTotal: q.channelsTotal,
        channelsDone: q.channelsDone,
        messages: q.messages,
        assetsByKind: q.assetsByKind,
        reactions: q.reactions,
        log: q.log,
        zipReady: q.zip !== null,
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
    const runner = new ExportRunner(this.api, this.store, {
      onProgress: (s) => {
        item.channelsTotal = s.channelsTotal;
        item.channelsDone = s.channelsDone;
        item.messages = s.messagesTotal;
        item.assetsByKind = s.assetsByKind;
        item.reactions = s.reactions;
        this.notify();
      },
      onLog: (e) => {
        item.log.push(formatLog(e));
        if (item.log.length > MAX_LOG) item.log.shift();
        this.notify();
      },
    });
    let status: RunStatus;
    try {
      status = await runner.run(item.runId);
    } catch (e) {
      status = 'failed';
      item.log.push(`${clock()}  ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
    item.status = status;
    if (status === 'completed' || status === 'partial') {
      const { blob } = await packageRun(this.store, item.runId);
      item.zip = blob;
      item.log.push(`${clock()}  📦 Paquet prêt — ${(blob.size / 1e6).toFixed(1)} Mo`);
    }
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
      channelsTotal: channels.length,
      channelsDone: channels.filter((c) => c.status === 'done' || c.status === 'partial').length,
      messages: channels.reduce((s, c) => s + c.messageCount, 0),
      assetsByKind: byKind,
      reactions: 0,
      log: [`${clock()}  ↻ run repris depuis le checkpoint`],
      zip: null,
    };
  }
}
