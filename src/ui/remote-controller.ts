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
  type PurgeItemView,
  type QueueItemView,
  type VespryCommand,
  type VespryState,
} from '../messaging';
import type { MediaSelection } from '../engine/checkpoint-types';
import type { RawChannel, RawGuild, RawMessage, Snowflake } from '../engine/types';
import type { DonorFeed } from '../donors';

const EMPTY: VespryState = {
  ready: false,
  error: null,
  userName: null,
  guilds: [],
  queue: [],
  purgeQueue: [],
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
  /** File des purges en cours (Phase 2). Vide tant qu'aucune purge lancée. */
  get purgeQueue(): PurgeItemView[] { return this.state.purgeQueue; }

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

  /**
   * Aperçu des messages d'un salon. `before` = id du plus ancien message déjà
   * affiché → renvoie la page précédente (défilement infini de l'historique).
   */
  async preview(channelId: string, before?: string): Promise<RawMessage[]> {
    const r = await this.send(
      before ? { cmd: 'preview', channelId, before } : { cmd: 'preview', channelId },
    );
    return r.messages ?? [];
  }

  async enqueue(
    guild: RawGuild,
    channels: RawChannel[],
    media: MediaSelection,
    extras: EnqueueExtras,
  ): Promise<void> {
    await this.send({ cmd: 'enqueue', guild, channels, media, ...extras });
  }

  /**
   * Phase 2 — lance une purge de messages dans un salon.
   *
   * `messageIds` doit être la sélection explicite faite par l'utilisateur
   * dans l'aperçu (la modale de confirmation se charge du triple garde-fou
   * côté UI — cf. tâche #6). Le moteur traite la file en arrière-plan,
   * ~5/s, et l'état progresse dans `purgeQueue` via les broadcasts d'état.
   *
   * Renvoie l'id local de la purge — utile à l'overlay pour cibler l'item
   * affiché dans la console.
   */
  async purge(
    guild: RawGuild,
    channelId: Snowflake,
    channelName: string,
    messageIds: Snowflake[],
  ): Promise<string | null> {
    const r = await this.send({
      cmd: 'purge', guild, channelId, channelName, messageIds,
    });
    return r.purgeRunId ?? null;
  }

  /** Flux du mur des soutiens. Renvoie null si le service est indisponible. */
  async getDonors(): Promise<DonorFeed | null> {
    const r = await this.send({ cmd: 'get-donors' });
    return r.donors ?? null;
  }

  /**
   * Demande une session Stripe Checkout pour un don.
   * Renvoie l'URL de paiement, ou null si le service est indisponible.
   */
  async startCheckout(req: {
    amountCents: number;
    donorName: string | null;
    message: string | null;
    isPublic: boolean;
  }): Promise<string | null> {
    const command: VespryCommand = {
      cmd: 'checkout',
      amountCents: req.amountCents,
      isPublic: req.isPublic,
      ...(req.donorName ? { donorName: req.donorName } : {}),
      ...(req.message ? { message: req.message } : {}),
    };
    const r = await this.send(command);
    return r.checkoutUrl ?? null;
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
