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
  type ExportRunSummary,
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
  /**
   * Port persistant nommé `vespry-keepalive` (Firefox uniquement, mais
   * inoffensif sur Chrome — le SW broker l'ignore). Empêche l'event page
   * Firefox de s'endormir entre deux batchs API pendant un export long.
   *
   * Sans ce port côté UI, l'event page peut être tuée par le scheduler
   * Firefox dans les fenêtres `await sleep(700)` du back-off Discord, et
   * l'export se fige silencieusement à mi-parcours (checkpoint IndexedDB
   * sauvé mais run jamais relancé sans intervention utilisateur).
   *
   * Découvert lors de l'audit ship-readiness pré-publication
   * (2026-05-18) — code mort jusque-là malgré les commentaires dans
   * `firefox/background.ts` qui en parlaient.
   */
  private keepalivePort: chrome.runtime.Port | null = null;

  constructor() {
    chrome.runtime.onMessage.addListener((m: unknown) => {
      if (isStateBroadcast(m)) {
        this.state = m.state;
        this.notify();
      }
      return undefined;
    });
    this.openKeepalive();
  }

  /**
   * Ouvre le port `vespry-keepalive` vers le background. Si le background
   * n'écoute pas (cas Chrome service-worker pur, ou erreur de chargement),
   * `chrome.runtime.connect` ne lève pas mais le port émettra `onDisconnect`
   * immédiatement — on l'absorbe en silence (`undefined` côté Chrome SW).
   * Le port reçoit aussi un push d'état initial depuis l'event page Firefox
   * (cf. `firefox/background.ts:387` `port.postMessage`).
   */
  private openKeepalive(): void {
    try {
      this.keepalivePort = chrome.runtime.connect({ name: 'vespry-keepalive' });
      this.keepalivePort.onMessage.addListener((m: unknown) => {
        if (isStateBroadcast(m)) {
          this.state = m.state;
          this.notify();
        }
      });
      this.keepalivePort.onDisconnect.addListener(() => {
        // Reconnecte après un court délai — Firefox peut couper le port
        // si l'event page redémarre (mise à jour de l'extension, etc.).
        // On évite la boucle serrée par un sleep modéré.
        this.keepalivePort = null;
        setTimeout(() => this.openKeepalive(), 2000);
      });
    } catch {
      this.keepalivePort = null;
    }
  }

  /**
   * Ferme le port keepalive — appelé par les vues qui ont un cycle de
   * vie défini (overlay au démontage). Sur popup, on laisse Chrome
   * faire le GC ; sur content-script l'overlay peut être démonté/remonté
   * (toggle), et on évite alors d'empiler les ports.
   */
  destroy(): void {
    if (this.keepalivePort) {
      try { this.keepalivePort.disconnect(); } catch { /* déjà fermé */ }
      this.keepalivePort = null;
    }
  }

  get ready(): boolean { return this.state.ready; }
  get error(): string | null { return this.state.error; }
  get guilds(): RawGuild[] { return this.state.guilds; }
  get queue(): QueueItemView[] { return this.state.queue; }
  /** File des opérations de purge (Phase 2). */
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
   * Estimation rapide du nombre de messages totaux pour un ensemble de
   * salons (avant lancement d'un export). Sert à l'overlay pour décider
   * d'afficher la modale « gros export ». `null` si toutes les
   * recherches ont échoué. Cf. controller.ts.estimateMessages.
   */
  async estimate(guildId: string, channelIds: string[]): Promise<number | null> {
    const r = await this.send({ cmd: 'estimate', guildId, channelIds });
    return r.estimatedTotal ?? null;
  }

  /** Historique des runs (popup → section Historique). */
  async listRuns(): Promise<ExportRunSummary[]> {
    const r = await this.send({ cmd: 'list-runs' });
    return r.runs ?? [];
  }

  /** Supprime un run de l'historique IDB (irréversible). */
  async deleteRun(runId: string): Promise<void> {
    await this.send({ cmd: 'delete-run', runId });
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

  /**
   * `filename` est calculé côté UI à partir du template utilisateur
   * (Phase 3 — templates de zip). Absent → le moteur applique son défaut.
   */
  downloadZip(runId: string, filename?: string): void {
    void this.send(filename
      ? { cmd: 'download', runId, filename }
      : { cmd: 'download', runId });
  }

  /**
   * Lance une purge (suppression série) des messages dont les ids sont
   * fournis dans le salon ciblé. Retourne l'id local de la `PurgeItem`
   * créée — l'avancement se suit ensuite via `purgeQueue` (broadcast d'état).
   * Renvoie `null` si l'offscreen n'a pas pu prendre la commande.
   */
  async purge(
    guild: RawGuild,
    channelId: Snowflake,
    channelName: string,
    messageIds: Snowflake[],
  ): Promise<string | null> {
    const r = await this.send({
      cmd: 'purge',
      guild,
      channelId,
      channelName,
      messageIds,
    });
    return r.purgeRunId ?? null;
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
