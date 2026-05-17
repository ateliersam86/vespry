/**
 * Client API Discord — `engine/discord-api.ts`.
 *
 * Dérivé de `discord-service.ts` de Discrub Classic (MIT), réécrit en module
 * autonome (sans Redux), typé strict, avec gestion explicite du 401.
 *
 * Appelé depuis `export.html` (origine chrome-extension://). Les
 * `host_permissions` du manifeste autorisent les requêtes cross-origin vers
 * discord.com ; le jeton passe dans l'en-tête `authorization`. Aucun cookie
 * n'est nécessaire — c'est le même modèle que DiscordChatExporter.
 */
import {
  DiscordApiError,
  type ActiveThreadsResponse,
  type RawChannel,
  type RawGuild,
  type RawMessage,
  type RawUser,
  type Snowflake,
} from './types';

const API_BASE = 'https://discord.com/api/v10';
/** Sécurité : nombre max de 429 consécutifs avant d'abandonner une requête. */
const MAX_RATE_LIMIT_RETRIES = 12;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface DiscordApiOptions {
  token: string;
  /** Délai appliqué avant chaque requête paginée — réduit les 429. */
  requestDelayMs?: number;
}

export class DiscordApi {
  private readonly token: string;
  private readonly requestDelayMs: number;

  constructor(opts: DiscordApiOptions) {
    this.token = opts.token;
    this.requestDelayMs = opts.requestDelayMs ?? 700;
  }

  /**
   * Exécute une requête API avec retry sur 429 et erreurs typées.
   * `throttle` applique le délai inter-requêtes (pour les boucles de fetch).
   */
  private async request<T>(path: string, throttle = false): Promise<T> {
    if (throttle && this.requestDelayMs > 0) await sleep(this.requestDelayMs);

    let rateLimitHits = 0;
    for (;;) {
      let res: Response;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        res = await fetch(`${API_BASE}${path}`, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            authorization: this.token,
          },
          signal: ctrl.signal,
        });
      } catch (e) {
        // Inclut le cas timeout (abort) — évite qu'une requête pende à l'infini.
        throw new DiscordApiError('network', 0, `Échec réseau : ${String(e)}`);
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        return (await res.json()) as T;
      }

      if (res.status === 429) {
        rateLimitHits += 1;
        if (rateLimitHits > MAX_RATE_LIMIT_RETRIES) {
          throw new DiscordApiError('unknown', 429, 'Rate limit persistant');
        }
        const retryAfterSec = await this.readRetryAfter(res);
        await sleep(retryAfterSec * 1000 + 250);
        continue;
      }

      if (res.status === 401) {
        throw new DiscordApiError('auth', 401, 'Session Discord expirée ou invalide');
      }
      if (res.status === 403) {
        throw new DiscordApiError('forbidden', 403, `Accès refusé : ${path}`);
      }
      if (res.status === 404) {
        throw new DiscordApiError('not_found', 404, `Ressource introuvable : ${path}`);
      }
      throw new DiscordApiError('unknown', res.status, `Erreur HTTP ${res.status} sur ${path}`);
    }
  }

  /** Lit `retry_after` (secondes) depuis le corps JSON ou l'en-tête. */
  private async readRetryAfter(res: Response): Promise<number> {
    try {
      const body = (await res.clone().json()) as { retry_after?: number };
      if (typeof body.retry_after === 'number') return body.retry_after;
    } catch {
      /* corps non-JSON — on retombe sur l'en-tête */
    }
    const header = res.headers.get('retry-after');
    const parsed = header ? Number(header) : NaN;
    return Number.isFinite(parsed) ? parsed : 1;
  }

  /** Compte connecté (GET /users/@me). */
  getCurrentUser(): Promise<RawUser> {
    return this.request<RawUser>('/users/@me');
  }

  /** Serveurs du compte (GET /users/@me/guilds). */
  getGuilds(): Promise<RawGuild[]> {
    return this.request<RawGuild[]>('/users/@me/guilds');
  }

  /** Salons d'un serveur (GET /guilds/{id}/channels). */
  getGuildChannels(guildId: Snowflake): Promise<RawChannel[]> {
    return this.request<RawChannel[]>(`/guilds/${guildId}/channels`);
  }

  /** Un salon précis (GET /channels/{id}). */
  getChannel(channelId: Snowflake): Promise<RawChannel> {
    return this.request<RawChannel>(`/channels/${channelId}`);
  }

  /** Conversations privées et group DM (GET /users/@me/channels). */
  getDmChannels(): Promise<RawChannel[]> {
    return this.request<RawChannel[]>('/users/@me/channels');
  }

  /**
   * Un lot de 100 messages d'un salon, du plus récent au plus ancien.
   * `before` = id du plus ancien message déjà récupéré (curseur de pagination).
   */
  getMessages(channelId: Snowflake, before?: Snowflake): Promise<RawMessage[]> {
    const cursor = before ? `&before=${before}` : '';
    return this.request<RawMessage[]>(
      `/channels/${channelId}/messages?limit=100${cursor}`,
      true,
    );
  }

  /** Threads archivés d'un salon (`public` ou `private`). */
  async getArchivedThreads(
    channelId: Snowflake,
    kind: 'public' | 'private',
  ): Promise<RawChannel[]> {
    const res = await this.request<{ threads: RawChannel[] }>(
      `/channels/${channelId}/threads/archived/${kind}`,
      true,
    );
    return res.threads;
  }

  /** Threads actifs d'un serveur (GET /guilds/{id}/threads/active). */
  async getActiveThreads(guildId: Snowflake): Promise<RawChannel[]> {
    const res = await this.request<ActiveThreadsResponse>(
      `/guilds/${guildId}/threads/active`,
    );
    return res.threads;
  }

  /**
   * Télécharge un média depuis le CDN Discord. Pas d'en-tête `authorization` :
   * l'URL CDN est elle-même signée. Renvoie le Blob, ou null sur échec.
   */
  async downloadAsset(url: string): Promise<Blob | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await res.blob();
    } catch {
      return null;
    }
  }
}
