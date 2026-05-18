/**
 * Couche de persistance IndexedDB — source de vérité de l'export.
 *
 * Chaque écriture (lot de messages, progression de salon, blob média) est
 * commitée immédiatement : si Chrome ferme ou plante, `getResumableRun()`
 * retrouve l'état et l'export reprend au curseur exact.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  ChannelProgress,
  ExportRun,
  StoredAsset,
  StoredMessage,
} from './checkpoint-types';

const DB_VERSION = 1;

interface VespryDB extends DBSchema {
  runs: { key: string; value: ExportRun };
  channels: {
    key: [string, string];
    value: ChannelProgress;
    indexes: { 'by-run': string };
  };
  messages: {
    key: [string, string, string];
    value: StoredMessage;
    indexes: { 'by-channel': [string, string] };
  };
  assets: {
    key: [string, string];
    value: StoredAsset;
    indexes: { 'by-run': string };
  };
}

export interface QuotaInfo {
  usageBytes: number;
  quotaBytes: number;
  /** Ratio 0–1. */
  ratio: number;
}

export class CheckpointStore {
  private db: IDBPDatabase<VespryDB> | null = null;

  constructor(private readonly dbName = 'vespry') {}

  async init(): Promise<void> {
    if (this.db) return;
    this.db = await openDB<VespryDB>(this.dbName, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('runs', { keyPath: 'id' });
        const channels = db.createObjectStore('channels', {
          keyPath: ['runId', 'channelId'],
        });
        channels.createIndex('by-run', 'runId');
        const messages = db.createObjectStore('messages', {
          keyPath: ['runId', 'channelId', 'messageId'],
        });
        messages.createIndex('by-channel', ['runId', 'channelId']);
        const assets = db.createObjectStore('assets', {
          keyPath: ['runId', 'assetId'],
        });
        assets.createIndex('by-run', 'runId');
      },
    });
  }

  private get conn(): IDBPDatabase<VespryDB> {
    if (!this.db) throw new Error('CheckpointStore non initialisé — appelle init()');
    return this.db;
  }

  // --- Runs ---

  async putRun(run: ExportRun): Promise<void> {
    await this.conn.put('runs', { ...run, updatedAt: Date.now() });
  }

  async getRun(id: string): Promise<ExportRun | undefined> {
    return this.conn.get('runs', id);
  }

  async patchRun(id: string, patch: Partial<ExportRun>): Promise<void> {
    const run = await this.getRun(id);
    if (!run) throw new Error(`run introuvable : ${id}`);
    await this.conn.put('runs', { ...run, ...patch, updatedAt: Date.now() });
  }

  /** Le run le plus récent encore reprenable (`in_progress` ou `paused`). */
  async getResumableRun(): Promise<ExportRun | undefined> {
    const runs = await this.conn.getAll('runs');
    return runs
      .filter((r) => r.status === 'in_progress' || r.status === 'paused')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  async listRuns(): Promise<ExportRun[]> {
    return (await this.conn.getAll('runs')).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }

  // --- Channels ---

  async putChannel(channel: ChannelProgress): Promise<void> {
    await this.conn.put('channels', channel);
  }

  async getChannel(
    runId: string,
    channelId: string,
  ): Promise<ChannelProgress | undefined> {
    return this.conn.get('channels', [runId, channelId]);
  }

  async getChannels(runId: string): Promise<ChannelProgress[]> {
    return this.conn.getAllFromIndex('channels', 'by-run', runId);
  }

  async patchChannel(
    runId: string,
    channelId: string,
    patch: Partial<ChannelProgress>,
  ): Promise<void> {
    const ch = await this.getChannel(runId, channelId);
    if (!ch) throw new Error(`salon introuvable : ${runId}/${channelId}`);
    await this.conn.put('channels', { ...ch, ...patch });
  }

  // --- Messages ---

  /** Écrit un lot de messages en une transaction (checkpoint atomique). */
  async appendMessages(messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const tx = this.conn.transaction('messages', 'readwrite');
    await Promise.all([
      ...messages.map((m) => tx.store.put(m)),
      tx.done,
    ]);
  }

  async countMessages(runId: string, channelId: string): Promise<number> {
    return this.conn.countFromIndex('messages', 'by-channel', [runId, channelId]);
  }

  /**
   * Parcourt les messages d'un salon par curseur (pas de chargement total en
   * mémoire). Ordre = clé primaire [runId, channelId, messageId] ; les ids
   * Discord étant des snowflakes horodatés, c'est l'ordre chronologique.
   */
  async forEachMessage(
    runId: string,
    channelId: string,
    visit: (m: StoredMessage) => void,
  ): Promise<void> {
    let cursor = await this.conn
      .transaction('messages')
      .store.index('by-channel')
      .openCursor(IDBKeyRange.only([runId, channelId]));
    while (cursor) {
      visit(cursor.value);
      cursor = await cursor.continue();
    }
  }

  /**
   * Variante asynchrone-iterable de `forEachMessage` : permet au consommateur
   * d'`await` entre deux messages (utile pour pousser dans un ReadableStream
   * avec back-pressure sans tout charger en RAM).
   *
   * Une transaction IndexedDB se termine dès qu'un tick microtâche se déroule
   * sans accès — on ouvre donc le curseur, et le `await` côté consommateur
   * doit rester dans la même boucle d'événements. C'est le cas quand on le
   * branche directement sur la lecture d'un ReadableStream.
   */
  async *iterateMessages(
    runId: string,
    channelId: string,
  ): AsyncIterable<StoredMessage> {
    let cursor = await this.conn
      .transaction('messages')
      .store.index('by-channel')
      .openCursor(IDBKeyRange.only([runId, channelId]));
    while (cursor) {
      yield cursor.value;
      cursor = await cursor.continue();
    }
  }

  // --- Assets ---

  async putAsset(asset: StoredAsset): Promise<void> {
    await this.conn.put('assets', asset);
  }

  async getPendingAssets(runId: string): Promise<StoredAsset[]> {
    const all = await this.conn.getAllFromIndex('assets', 'by-run', runId);
    return all.filter((a) => a.status === 'pending');
  }

  async getAssets(runId: string): Promise<StoredAsset[]> {
    return this.conn.getAllFromIndex('assets', 'by-run', runId);
  }

  // --- Quota ---

  /** Estimation de l'occupation du stockage (pilote l'alerte quota). */
  async estimateQuota(): Promise<QuotaInfo | null> {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return {
      usageBytes: usage,
      quotaBytes: quota,
      ratio: quota > 0 ? usage / quota : 0,
    };
  }

  // --- Nettoyage ---

  /** Supprime entièrement un run (run + salons + messages + médias). */
  async deleteRun(runId: string): Promise<void> {
    const tx = this.conn.transaction(
      ['runs', 'channels', 'messages', 'assets'],
      'readwrite',
    );
    await tx.objectStore('runs').delete(runId);

    // channels & assets : clé composite [runId, ...] → borne de préfixe.
    for (const store of ['channels', 'assets'] as const) {
      const range = IDBKeyRange.bound([runId], [runId, []]);
      let cur = await tx.objectStore(store).openCursor(range);
      while (cur) {
        await cur.delete();
        cur = await cur.continue();
      }
    }
    // messages : clé [runId, channelId, messageId] → même borne de préfixe.
    const msgRange = IDBKeyRange.bound([runId], [runId, [], []]);
    let mcur = await tx.objectStore('messages').openCursor(msgRange);
    while (mcur) {
      await mcur.delete();
      mcur = await mcur.continue();
    }
    await tx.done;
  }
}
