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
import { watchMessageSchema } from './schema-watch';
import { clampParallel } from './perf-profile';

/**
 * Sécurise la concurrence salons : non-numérique / NaN / ≤ 1 → 1, ≥ 3 → 3,
 * sinon 2. Délègue à `perf-profile.clampParallel` pour la borne supérieure
 * (rate-limit Discord = max 3).
 */
function clampChannelConcurrency(n: number): 1 | 2 | 3 {
  return clampParallel(n);
}

/** Au-delà de ce ratio d'occupation IndexedDB, on met le run en pause. */
const QUOTA_PAUSE_RATIO = 0.9;

export interface ProgressSnapshot {
  runId: string;
  status: RunStatus;
  channelsTotal: number;
  channelsDone: number;
  currentChannel: string | null;
  messagesTotal: number;
  /**
   * Total estimé de messages attendus sur tout le run, calculé via
   * `DiscordApi.searchMessageCount` au démarrage (un appel par salon, en
   * parallèle). `null` si l'estimation a échoué (perms, rate-limit,
   * DM non supporté) — la UI retombe alors sur `channelsDone/channelsTotal`.
   *
   * Permet une barre de progression FLUIDE qui ne saute plus de 0 à 80 %
   * en avalant des petits salons puis stagne sur le gros — le rapport
   * `messagesTotal / estimatedMessagesTotal` reste à peu près linéaire dans
   * le temps. Plafond Discord : 8000 par salon (au-delà l'API renvoie
   * 8000+, donc on sous-estime un peu sur les très gros salons — acceptable
   * pour une barre indicative).
   */
  estimatedMessagesTotal: number | null;
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
 * Options de l'exécution d'un run — concurrence salons typiquement.
 */
export interface RunnerOptions {
  /**
   * Nombre maximum de salons traités en parallèle dans un même run.
   * Défaut 1 (comportement historique séquentiel). Capé à 3 par
   * `perf-profile.clampParallel` (rate-limit Discord, cf. Phase 1).
   *
   * En profil `low` la concurrence vaut 1 (faible RAM = on évite la
   * pression mémoire des batches en parallèle). En `balanced` 2, en
   * `fast` 3 — c'est le contrôleur qui passe la valeur du profil.
   */
  channelConcurrency?: number;
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
  // Map id → nom pour résoudre le parent d'un thread (types 10/11/12).
  // Permet au packager de préfixer le slug d'un thread par son parent
  // (Sam 2026-05-19 : threads séparés en fichiers, nommage clair).
  const nameById = new Map<string, string>();
  for (const ch of channels) nameById.set(ch.id, ch.name ?? ch.id);
  for (const ch of channels) {
    const isThread = ch.type === 10 || ch.type === 11 || ch.type === 12;
    const parentName = (isThread && ch.parent_id)
      ? nameById.get(ch.parent_id) ?? null
      : null;
    const progress: ChannelProgress = {
      runId,
      channelId: ch.id,
      name: ch.name ?? ch.id,
      category: parentName,
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
  /**
   * Total estimé de messages attendus sur tout le run, calculé via l'API
   * `search` au démarrage. `null` tant que le pré-comptage n'a pas eu lieu
   * ou s'il a complètement échoué (perms manquantes, rate-limit excédé).
   * La UI s'en sert pour rendre la barre fluide ; sinon retombe sur
   * `channelsDone/channelsTotal`.
   */
  private estimatedMessagesTotal: number | null = null;
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
    private readonly options: RunnerOptions = {},
  ) {}

  /**
   * Exécute (ou reprend) un run. Les enregistrements de salon doivent déjà
   * exister (cf. `planGuildExport`). Renvoie le statut final.
   *
   * Concurrence salons (Phase 1) — quand `options.channelConcurrency > 1`,
   * jusqu'à N salons sont traités en parallèle. Implémentation : sémaphore
   * par run (workers permanents qui consomment une file partagée). Sur
   * `paused` (quota / 401) on attend que les workers en cours terminent
   * leur tour avant de revenir, pour ne pas laisser un salon à moitié écrit
   * sans curseur cohérent.
   */
  async run(runId: string): Promise<RunStatus> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`run introuvable : ${runId}`);
    await this.store.patchRun(runId, { status: 'in_progress' });

    const channels = await this.store.getChannels(runId);
    const pending = channels.filter(
      (ch) => ch.status !== 'done' && ch.status !== 'skipped',
    );
    const concurrency = clampChannelConcurrency(
      this.options.channelConcurrency ?? 1,
    );

    // Pré-comptage des messages attendus, en parallèle, avant de démarrer.
    // 1 appel `messages/search?channel_id=X&limit=1` par salon pending, qui
    // renvoie `total_results` plafonné à 8000 (limite ES Discord). Au-delà
    // on sous-estime un peu, mais ça suffit largement à pondérer la barre.
    // Échec d'estimation = on retombe sur le calcul historique côté UI ;
    // pas de blocage du run sur un pré-comptage qui foire.
    await this.preCount(run.guildId, pending);
    // Premier broadcast avec l'estimation totale, AVANT toute pagination —
    // la barre est ainsi prête à afficher du % dès le premier batch.
    if (this.events.onProgress) {
      void this.snapshot(runId, null).then(this.events.onProgress);
    }

    let anyPartial = false;
    let paused = false;
    let cursor = 0;

    const takeNext = (): ChannelProgress | undefined => {
      if (paused) return undefined;
      const ch = pending[cursor];
      cursor += 1;
      return ch;
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        const ch = takeNext();
        if (!ch) return;
        const outcome = await this.runChannel(run, ch);
        if (outcome === 'paused') {
          // Le premier `paused` arme le drapeau : les autres workers finiront
          // leur salon en cours puis sortiront sans en commencer un nouveau.
          paused = true;
          return;
        }
        if (outcome === 'partial') anyPartial = true;
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.max(1, Math.min(concurrency, pending.length)); i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (paused) {
      this.events.onPaused?.('quota ou session — run en pause');
      this.events.onDone?.('paused');
      return 'paused';
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
    // Sentinelle de schéma — détecte les champs Discord inconnus pour qu'on
    // sache quand Vespry doit être mis à jour. Non bloquant.
    for (const m of messages) watchMessageSchema(m);

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
    const messagesTotal = channels.reduce((s, c) => s + c.messageCount, 0);
    // Rolling adjust de l'estimation : si la réalité dépasse l'estimation
    // initiale (cas du plafond 8000 par salon dépassé), on étire pour
    // que la barre ne reste pas bloquée à 100 %. Elle NE redescend
    // jamais — on plafonne l'estimation à au moins `messagesTotal`.
    // Cf. feedback Sam (2026-05-19) sur les salons > 8000 messages.
    if (
      this.estimatedMessagesTotal !== null
      && messagesTotal > this.estimatedMessagesTotal
    ) {
      this.estimatedMessagesTotal = messagesTotal;
    }
    return {
      runId,
      status: run?.status ?? 'in_progress',
      channelsTotal: channels.length,
      channelsDone: channels.filter(
        (c) => c.status === 'done' || c.status === 'partial' || c.status === 'skipped',
      ).length,
      currentChannel,
      messagesTotal,
      estimatedMessagesTotal: this.estimatedMessagesTotal,
      assetsDone: this.assetsDone,
      assetsFailed: this.assetsFailed,
      assetsByKind: { ...this.assetsByKind },
      reactions: this.reactions,
    };
  }

  /**
   * Lance `searchMessageCount` pour chaque salon pending en parallèle (cap 3
   * pour rester sous le rate-limit Discord ~50/min). Stocke le total estimé
   * dans `this.estimatedMessagesTotal`. Quand une estimation échoue pour un
   * salon donné, on l'ignore — l'estimation totale est juste un peu basse,
   * pas un blocage. Si TOUS les salons échouent, `estimatedMessagesTotal`
   * reste null et la UI retombe sur le calcul par salons.
   */
  private async preCount(
    guildId: Snowflake,
    pending: ChannelProgress[],
  ): Promise<void> {
    if (pending.length === 0) {
      this.estimatedMessagesTotal = 0;
      return;
    }
    const CONCURRENCY = 3;
    const counts: (number | null)[] = new Array(pending.length).fill(null);
    let cursor = 0;
    const next = (): number | null => {
      if (cursor >= pending.length) return null;
      const i = cursor;
      cursor += 1;
      return i;
    };
    const isDmGuild = !guildId || guildId === '@me';
    const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
      for (;;) {
        const i = next();
        if (i === null) return;
        const ch = pending[i];
        if (!ch) return;
        counts[i] = await this.countChannelMessages(guildId, ch, isDmGuild);
      }
    });
    await Promise.all(workers);
    const total = counts.reduce<number>((s, c) => s + (c ?? 0), 0);
    const anySuccess = counts.some((c) => c !== null);
    this.estimatedMessagesTotal = anySuccess ? total : null;
  }

  /**
   * Compte les messages d'un seul salon, avec dichotomie 1 niveau si la
   * première search plafonne à 8000 (limite ES Discord).
   *
   * - 1 search par défaut (< 8000 → on a la valeur exacte).
   * - Si plafonné, 2 searches supplémentaires bornées par snowflake : moitié
   *   ancienne (`max_id=mid`) + moitié récente (`min_id=mid`). On somme.
   *   Résultat : estimation correcte jusqu'à ~16k messages, sous-estimée
   *   au-delà mais corrigée pendant le run par le rolling adjust de
   *   `snapshot()` (estimatedTotal ne redescend jamais).
   * - Si le salon n'a pas de cursor (jamais paginé), on ne peut pas
   *   borner — on prend l'estimation plafonnée telle quelle.
   */
  private async countChannelMessages(
    guildId: Snowflake,
    ch: ChannelProgress,
    isDmGuild: boolean,
  ): Promise<number | null> {
    const isDmChannel = isDmGuild || ch.type === 1 || ch.type === 3;
    const search = (maxId?: Snowflake, minId?: Snowflake): Promise<number | null> =>
      isDmChannel
        ? this.api.searchDmMessageCount(ch.channelId, maxId, minId)
        : this.api.searchMessageCount(guildId, ch.channelId, maxId, minId);

    const initial = await search();
    if (initial === null) return null;
    // Seuil 8000 = plafond ES Discord. < 8000 = valeur exacte, on s'arrête.
    if (initial < SEARCH_CAP_THRESHOLD) return initial;

    // Plafonné : on cherche le `last_message_id` pour fixer la borne haute,
    // puis on coupe en deux par snowflake midpoint. Si pas de last_msg,
    // on retombe sur la valeur plafonnée brute.
    let lastId: Snowflake | null = null;
    try {
      const channel = await this.api.getChannel(ch.channelId);
      lastId = channel.last_message_id ?? null;
    } catch { /* salon supprimé / permission perdue — fallback */ }
    if (!lastId) return initial;

    const midId = snowflakeMidpoint(lastId);
    if (!midId) return initial;

    const [oldHalf, newHalf] = await Promise.all([
      search(midId), // max_id = mid → moitié ancienne (de 0 à mid)
      search(undefined, midId), // min_id = mid → moitié récente
    ]);
    if (oldHalf === null && newHalf === null) return initial;
    return (oldHalf ?? 0) + (newHalf ?? 0);
  }
}

/**
 * Au-delà de ce seuil, on considère le `total_results` plafonné par l'index
 * Elasticsearch de Discord (limite ES ≈ 8000). On déclenche alors une
 * dichotomie temporelle pour affiner.
 */
const SEARCH_CAP_THRESHOLD = 8000;

/**
 * Snowflake médian entre 0 et `lastId` — temporellement, c'est le moment
 * "milieu de l'histoire" du salon. Sert à la dichotomie pour estimer un
 * salon plafonné à 8000.
 *
 * Discord snowflake = 64 bits avec timestamp_ms en bits 22..63. Diviser
 * par 2 le snowflake brut divise par 2 le timestamp depuis l'epoch Discord,
 * ce qui produit un point qui borne en pratique la moitié temporelle.
 *
 * Renvoie null si `lastId` n'est pas un nombre valide.
 */
function snowflakeMidpoint(lastId: Snowflake): Snowflake | null {
  try {
    const n = BigInt(lastId);
    if (n <= 0n) return null;
    return (n / 2n).toString();
  } catch {
    return null;
  }
}
