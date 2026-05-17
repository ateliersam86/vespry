/**
 * Orchestrateur d'export — checkpoint-natif.
 *
 * Pour chaque salon : pagination par 100, écriture immédiate de chaque lot
 * dans IndexedDB (messages + curseur), médias téléchargés au fil de l'eau.
 * Tout est resumable : `run()` reprend chaque salon à son curseur.
 *
 * Tourne dans le document offscreen (contexte persistant), jamais dans le
 * service worker.
 */
import type { DiscordApi } from './discord-api';
import type { CheckpointStore } from './checkpoint-store';
import { messageMatchesZones } from './checkpoint-types';
import type {
  AssetKind,
  ChannelProgress,
  ExportOptions,
  ExportRun,
  RunStatus,
  SelectionZone,
  StoredAsset,
  StoredMessage,
  ZoneMode,
} from './checkpoint-types';
import {
  ChannelType,
  DiscordApiError,
  type RawChannel,
  type RawMessage,
  type Snowflake,
} from './types';
import { collectAssets } from './media';

/** Au-delà de ce ratio d'occupation IndexedDB, on met le run en pause. */
const QUOTA_PAUSE_RATIO = 0.9;

export interface ProgressSnapshot {
  runId: string;
  status: RunStatus;
  channelsTotal: number;
  channelsDone: number;
  currentChannel: string | null;
  messagesTotal: number;
  assetsDone: number;
  assetsFailed: number;
  /** Décompte des médias téléchargés par type (pour le détail 100 %). */
  assetsByKind: Record<AssetKind, number>;
  /** Total des réactions rencontrées. */
  reactions: number;
}

/** Évènement temps réel pour la mini-console de l'UI. */
export type RunnerLogEvent =
  | { type: 'channel-start'; channel: string }
  | { type: 'batch'; channel: string; count: number }
  | { type: 'media'; channel: string; count: number; kind: AssetKind }
  | { type: 'channel-done'; channel: string; total: number };

export interface RunnerEvents {
  onProgress?: (p: ProgressSnapshot) => void;
  /** Flux d'évènements de bas niveau (lots, médias) — alimente la console. */
  onLog?: (e: RunnerLogEvent) => void;
  onPaused?: (reason: string) => void;
  onDone?: (status: RunStatus) => void;
}

/**
 * Borne basse de pagination : id-timestamp en dessous duquel aucun message ne
 * peut plus être retenu — on peut alors arrêter de paginer ce salon.
 *
 * - Une zone `manual` peut viser n'importe quel message ancien → aucune borne.
 * - Mode `all` (ET) : le message doit satisfaire CHAQUE zone, donc rester au-
 *   dessus de la plus tardive des périodes non-niées → borne = max(afterMs).
 * - Mode `any` (OU) : on ne peut borner que si TOUTES les zones sont des
 *   périodes datées non-niées → borne = min(afterMs).
 */
function paginationLowerBound(
  zones: SelectionZone[],
  mode: ZoneMode,
): number | undefined {
  if (zones.length === 0) return undefined;
  if (zones.some((z) => z.kind === 'manual')) return undefined;

  const datedPeriods = zones.filter(
    (z): z is SelectionZone & { kind: 'period'; afterMs: number } =>
      z.kind === 'period' && !z.negate && z.afterMs !== undefined,
  );
  if (datedPeriods.length === 0) return undefined;

  if (mode === 'all') {
    return Math.max(...datedPeriods.map((z) => z.afterMs));
  }
  // mode `any` : toute zone non-période interdit de borner.
  if (datedPeriods.length !== zones.length) return undefined;
  return Math.min(...datedPeriods.map((z) => z.afterMs));
}

/** Crée le run + les enregistrements de salon. Renvoie l'id du run. */
export async function planGuildExport(
  store: CheckpointStore,
  guild: { id: Snowflake; name: string },
  channels: RawChannel[],
  options: ExportOptions,
): Promise<string> {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const run: ExportRun = {
    id: runId,
    guildId: guild.id,
    guildName: guild.name,
    status: 'in_progress',
    options,
    createdAt: now,
    updatedAt: now,
  };
  await store.putRun(run);
  for (const ch of channels) {
    const progress: ChannelProgress = {
      runId,
      channelId: ch.id,
      name: ch.name ?? ch.id,
      category: null,
      type: ch.type,
      status: 'pending',
      cursor: null,
      messageCount: 0,
    };
    await store.putChannel(progress);
  }
  return runId;
}

export class ExportRunner {
  private assetsDone = 0;
  private assetsFailed = 0;
  private reactions = 0;
  private readonly assetsByKind: Record<AssetKind, number> = {
    image: 0,
    video: 0,
    audio: 0,
    file: 0,
    emoji: 0,
    avatar: 0,
  };

  constructor(
    private readonly api: DiscordApi,
    private readonly store: CheckpointStore,
    private readonly events: RunnerEvents = {},
  ) {}

  /**
   * Exécute (ou reprend) un run. Les enregistrements de salon doivent déjà
   * exister (cf. `planGuildExport`). Renvoie le statut final.
   */
  async run(runId: string): Promise<RunStatus> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`run introuvable : ${runId}`);
    await this.store.patchRun(runId, { status: 'in_progress' });

    const channels = await this.store.getChannels(runId);
    let anyPartial = false;

    for (const ch of channels) {
      if (ch.status === 'done' || ch.status === 'skipped') continue;

      const outcome = await this.runChannel(run, ch);
      if (outcome === 'paused') {
        this.events.onPaused?.('quota ou session — run en pause');
        this.events.onDone?.('paused');
        return 'paused';
      }
      if (outcome === 'partial') anyPartial = true;
    }

    const finalStatus: RunStatus = anyPartial ? 'partial' : 'completed';
    await this.store.patchRun(runId, { status: finalStatus });
    this.events.onDone?.(finalStatus);
    return finalStatus;
  }

  /** Traite un salon. Renvoie 'done' | 'partial' | 'paused'. */
  private async runChannel(
    run: ExportRun,
    channel: ChannelProgress,
  ): Promise<'done' | 'partial' | 'paused'> {
    await this.store.patchChannel(run.id, channel.channelId, {
      status: 'in_progress',
    });
    this.events.onLog?.({ type: 'channel-start', channel: channel.name });

    // Un forum n'a pas de messages propres : c'est un conteneur de posts.
    // Chaque post est un thread, exporté comme un salon à part entière
    // (ajouté à la liste par le contrôleur quand « inclure les threads »).
    if (channel.type === ChannelType.GUILD_FORUM) {
      await this.store.patchChannel(run.id, channel.channelId, {
        status: 'done',
        messageCount: 0,
      });
      this.events.onLog?.({ type: 'channel-done', channel: channel.name, total: 0 });
      return 'done';
    }

    let cursor = channel.cursor;
    let count = channel.messageCount;

    for (;;) {
      // Garde-fou quota avant chaque lot.
      const quota = await this.store.estimateQuota();
      if (quota && quota.ratio >= QUOTA_PAUSE_RATIO) {
        await this.store.patchRun(run.id, {
          status: 'paused',
          error: 'Quota de stockage presque atteint',
        });
        return 'paused';
      }

      let batch: RawMessage[];
      try {
        batch = await this.api.getMessages(channel.channelId, cursor ?? undefined);
      } catch (e) {
        if (e instanceof DiscordApiError && e.kind === 'auth') {
          await this.store.patchRun(run.id, {
            status: 'paused',
            error: 'Session Discord expirée — reconnecte-toi puis reprends',
          });
          return 'paused';
        }
        if (
          e instanceof DiscordApiError
          && (e.kind === 'forbidden' || e.kind === 'not_found')
        ) {
          await this.store.patchChannel(run.id, channel.channelId, {
            status: 'partial',
            error: e.message,
          });
          return 'partial';
        }
        throw e;
      }

      if (batch.length === 0) break;

      const kept = this.filterMessages(batch, run.options, channel.channelId);
      await this.persistBatch(run, channel, kept);
      count += kept.length;

      // Curseur = id du plus ancien message du lot (lot trié récent→ancien).
      cursor = batch[batch.length - 1]?.id ?? cursor;
      await this.store.patchChannel(run.id, channel.channelId, {
        cursor,
        messageCount: count,
      });
      this.emitProgress(run, channel.channelId, count);

      // Borne basse atteinte (plus vieux que `afterMs`) → on arrête ce salon.
      if (this.reachedLowerBound(batch, run.options)) break;
      if (batch.length < 100) break;
    }

    await this.store.patchChannel(run.id, channel.channelId, {
      status: 'done',
      messageCount: count,
    });
    this.events.onLog?.({ type: 'channel-done', channel: channel.name, total: count });
    return 'done';
  }

  /** Écrit les messages puis télécharge leurs médias au fil de l'eau. */
  private async persistBatch(
    run: ExportRun,
    channel: ChannelProgress,
    messages: RawMessage[],
  ): Promise<void> {
    // Enrichit chaque réaction de la liste des utilisateurs (avant écriture,
    // pour que le message persisté soit complet). Coûteux → derrière l'option.
    if (run.options.includeReactionUsers) {
      await this.enrichReactionUsers(channel.channelId, messages);
    }

    const stored: StoredMessage[] = messages.map((m) => ({
      runId: run.id,
      channelId: channel.channelId,
      messageId: m.id,
      message: m,
    }));
    await this.store.appendMessages(stored);
    for (const m of messages) {
      for (const r of m.reactions ?? []) this.reactions += r.count;
    }
    if (messages.length > 0) {
      this.events.onLog?.({
        type: 'batch',
        channel: channel.name,
        count: messages.length,
      });
    }

    const byKind: Partial<Record<AssetKind, number>> = {};
    for (const message of messages) {
      for (const asset of collectAssets(message, run.options.media)) {
        const ok = await this.downloadAsset(run.id, channel.channelId, asset);
        if (ok) byKind[asset.kind] = (byKind[asset.kind] ?? 0) + 1;
      }
    }
    for (const [kind, count] of Object.entries(byKind)) {
      this.events.onLog?.({
        type: 'media',
        channel: channel.name,
        count,
        kind: kind as AssetKind,
      });
    }
  }

  /**
   * Récupère la liste des utilisateurs ayant réagi à chaque message et la
   * pose dans `reaction.users`. Un appel API par emoji distinct — l'échec
   * d'une réaction n'interrompt pas l'export.
   */
  private async enrichReactionUsers(
    channelId: Snowflake,
    messages: RawMessage[],
  ): Promise<void> {
    for (const m of messages) {
      for (const r of m.reactions ?? []) {
        try {
          r.users = await this.api.getReactions(channelId, m.id, r.emoji);
        } catch {
          /* échec ponctuel sur une réaction — sans gravité, on continue */
        }
      }
    }
  }

  /** Télécharge un média. Renvoie true si réussi. */
  private async downloadAsset(
    runId: string,
    channelId: Snowflake,
    asset: { assetId: string; url: string; kind: StoredAsset['kind']; filename: string },
  ): Promise<boolean> {
    const pending: StoredAsset = {
      runId,
      assetId: asset.assetId,
      channelId,
      url: asset.url,
      kind: asset.kind,
      filename: asset.filename,
      status: 'pending',
    };
    await this.store.putAsset(pending);

    const blob = await this.api.downloadAsset(asset.url);
    if (blob) {
      await this.store.putAsset({ ...pending, status: 'done', blob });
      this.assetsDone += 1;
      this.assetsByKind[asset.kind] += 1;
      return true;
    }
    await this.store.putAsset({
      ...pending,
      status: 'failed',
      error: 'téléchargement échoué (lien expiré ?)',
    });
    this.assetsFailed += 1;
    return false;
  }

  /**
   * Garde les messages retenus : zones de sélection (mode + négation), ET le
   * plancher incrémental `sinceMs` s'il est défini.
   */
  private filterMessages(
    batch: RawMessage[],
    opts: ExportOptions,
    channelId: string,
  ): RawMessage[] {
    let kept = batch;
    if (opts.sinceMs !== undefined) {
      const floor = opts.sinceMs;
      kept = kept.filter((m) => Date.parse(m.timestamp) >= floor);
    }
    if (opts.zones.length === 0) return kept;
    return kept.filter(
      (m) => messageMatchesZones(m, opts.zones, channelId, opts.zoneMode),
    );
  }

  /**
   * Vrai si le lot dépasse la borne basse de pagination — on peut alors
   * arrêter ce salon. La borne est le plus contraignant de : la borne dérivée
   * des zones, et le plancher incrémental `sinceMs` (toujours un ET strict).
   */
  private reachedLowerBound(batch: RawMessage[], opts: ExportOptions): boolean {
    const zoneBound = paginationLowerBound(opts.zones, opts.zoneMode);
    const bounds = [zoneBound, opts.sinceMs].filter(
      (b): b is number => b !== undefined,
    );
    if (bounds.length === 0) return false;
    const bound = Math.max(...bounds);
    return batch.some((m) => Date.parse(m.timestamp) < bound);
  }

  private emitProgress(
    run: ExportRun,
    currentChannel: string,
    messagesInChannel: number,
  ): void {
    void messagesInChannel;
    if (!this.events.onProgress) return;
    void this.snapshot(run.id, currentChannel).then(this.events.onProgress);
  }

  private async snapshot(
    runId: string,
    currentChannel: string | null,
  ): Promise<ProgressSnapshot> {
    const channels = await this.store.getChannels(runId);
    const run = await this.store.getRun(runId);
    return {
      runId,
      status: run?.status ?? 'in_progress',
      channelsTotal: channels.length,
      channelsDone: channels.filter(
        (c) => c.status === 'done' || c.status === 'partial' || c.status === 'skipped',
      ).length,
      currentChannel,
      messagesTotal: channels.reduce((s, c) => s + c.messageCount, 0),
      assetsDone: this.assetsDone,
      assetsFailed: this.assetsFailed,
      assetsByKind: { ...this.assetsByKind },
      reactions: this.reactions,
    };
  }
}
