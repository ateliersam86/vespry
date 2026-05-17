/**
 * RemoteController — contrôleur côté vue (overlay, popup).
 *
 * Même surface que le VespryController, mais sans moteur : il pilote
 * l'offscreen document par messaging et tient le dernier état diffusé.
 * Permet à `Overlay.tsx` et au popup de fonctionner sans changement de logique.
 */
import {
  isStateBroadcast,
  type CommandResponse,
  type EnqueueExtras,
  type QueueItemView,
  type VespryCommand,
  type VespryState,
} from '../messaging';
import type { MediaSelection } from '../engine/checkpoint-types';
import type { RawChannel, RawGuild } from '../engine/types';

const EMPTY: VespryState = {
  ready: false,
  error: null,
  userName: null,
  guilds: [],
  queue: [],
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RemoteController {
  private state: VespryState = EMPTY;
  private lastError: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor() {
    chrome.runtime.onMessage.addListener((m: unknown) => {
      if (isStateBroadcast(m)) {
        this.state = m.state;
        this.notify();
      }
      return undefined;
    });
  }

  get ready(): boolean { return this.state.ready; }
  get error(): string | null { return this.state.error; }
  get guilds(): RawGuild[] { return this.state.guilds; }
  get queue(): QueueItemView[] { return this.state.queue; }

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
   * Récupère l'état initial en interrogeant l'offscreen jusqu'à ce qu'il soit
   * « prêt ». Si l'offscreen ne répond pas après ~17 s, bascule sur un état
   * d'erreur visible — l'overlay ne reste jamais bloqué sur « Chargement… ».
   */
  async init(): Promise<void> {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const r = await this.send({ cmd: 'get-state' });
      if (r.state) {
        this.state = r.state;
        this.notify();
        if (r.state.ready) return;
      } else if (r.error) {
        this.lastError = r.error;
      }
      await sleep(700);
    }
    this.state = {
      ...this.state,
      ready: true,
      error: this.state.error ?? this.lastError ?? 'Moteur injoignable',
    };
    this.notify();
  }

  async loadChannels(guildId: string): Promise<RawChannel[]> {
    const r = await this.send({ cmd: 'load-channels', guildId });
    return r.channels ?? [];
  }

  async enqueue(
    guild: RawGuild,
    channels: RawChannel[],
    media: MediaSelection,
    extras: EnqueueExtras,
  ): Promise<void> {
    await this.send({ cmd: 'enqueue', guild, channels, media, ...extras });
  }

  resume(runId: string): void {
    void this.send({ cmd: 'resume', runId });
  }

  downloadZip(runId: string): void {
    void this.send({ cmd: 'download', runId });
  }

  private async send(command: VespryCommand): Promise<CommandResponse> {
    try {
      const r = await chrome.runtime.sendMessage({ kind: 'vespry-command', command });
      return r && typeof r === 'object'
        ? (r as CommandResponse)
        : { ok: false, error: 'réponse vide du service worker' };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}
