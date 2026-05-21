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
import { recordEvent } from '../diagnostics';
import {
  DiscordApiError,
  type ActiveThreadsResponse,
  type RawChannel,
  type RawEmoji,
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
   * Options de bas niveau pour `request()`. Permet d'étendre la méthode sans
   * dédoubler la mécanique de back-off 429 (utile pour `deleteMessage` qui
   * sort du verbe GET).
   *
   * `tolerate404` — résout avec `null` au lieu de lever `DiscordApiError('not_found')`.
   * Cas typique : DELETE d'un message déjà supprimé par ailleurs, qu'on
   * considère comme un succès idempotent.
   *
   * `expectEmpty` — la réponse 2xx n'est pas du JSON (typiquement un 204
   * No Content). On évite de tenter un `res.json()` qui jetterait sur un
   * corps vide ; on résout avec `null`.
   */
  private async request<T>(
    path: string,
    opts: {
      method?: 'GET' | 'DELETE';
      throttle?: boolean;
      tolerate404?: boolean;
      expectEmpty?: boolean;
    } = {},
  ): Promise<T | null> {
    const { method = 'GET', throttle = false, tolerate404 = false, expectEmpty = false } = opts;
    if (throttle && this.requestDelayMs > 0) await sleep(this.requestDelayMs);

    let rateLimitHits = 0;
    for (;;) {
      let res: Response;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      try {
        res = await fetch(`${API_BASE}${path}`, {
          method,
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
        // 204 No Content (typique de DELETE) ou autre 2xx sans corps : on
        // évite le json() qui jetterait. L'appelant sait quoi attendre.
        if (expectEmpty || res.status === 204) return null;
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
        // L'appelant peut considérer un 404 comme succès idempotent — c'est
        // le cas pour DELETE d'un message déjà disparu.
        if (tolerate404) return null;
        throw new DiscordApiError('not_found', 404, `Ressource introuvable : ${path}`);
      }
      throw new DiscordApiError('unknown', res.status, `Erreur HTTP ${res.status} sur ${path}`);
    }
  }

  /**
   * Surcharge interne : appelle `request()` en GET classique et garantit un
   * résultat non-null. Tous les appelants historiques (getGuilds, getMessages,
   * etc.) passent par ici — pas de cast `as T` côté chacun d'eux.
   */
  private async get<T>(path: string, throttle = false): Promise<T> {
    const r = await this.request<T>(path, { method: 'GET', throttle });
    // GET ne demande jamais `tolerate404` ni `expectEmpty` — un null serait
    // un bug du wrapper, pas un cas légitime.
    if (r === null) {
      throw new DiscordApiError('unknown', 0, `Réponse vide inattendue : ${path}`);
    }
    return r;
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
    return this.get<RawUser>('/users/@me');
  }

  /** Serveurs du compte (GET /users/@me/guilds). */
  getGuilds(): Promise<RawGuild[]> {
    return this.get<RawGuild[]>('/users/@me/guilds');
  }

  /** Salons d'un serveur (GET /guilds/{id}/channels). */
  getGuildChannels(guildId: Snowflake): Promise<RawChannel[]> {
    return this.get<RawChannel[]>(`/guilds/${guildId}/channels`);
  }

  /** Un salon précis (GET /channels/{id}). */
  getChannel(channelId: Snowflake): Promise<RawChannel> {
    return this.get<RawChannel>(`/channels/${channelId}`);
  }

  /** Conversations privées et group DM (GET /users/@me/channels). */
  getDmChannels(): Promise<RawChannel[]> {
    return this.get<RawChannel[]>('/users/@me/channels');
  }

  /**
   * Un lot de 100 messages d'un salon, du plus récent au plus ancien.
   * `before` = id du plus ancien message déjà récupéré (curseur de pagination).
   */
  getMessages(channelId: Snowflake, before?: Snowflake): Promise<RawMessage[]> {
    const cursor = before ? `&before=${before}` : '';
    return this.get<RawMessage[]>(
      `/channels/${channelId}/messages?limit=100${cursor}`,
      true,
    );
  }

  /**
   * Nombre estimé de messages dans un salon — sert au pré-comptage pour la
   * barre de progression fluide. Discord renvoie `total_results` plafonné
   * à 8000 (limite de son index Elasticsearch).
   *
   * `maxId` / `minId` (optionnels) bornent la recherche temporellement —
   * utilisés par le pré-comptage en dichotomie quand le compte global
   * est plafonné (cf. `preCount` dans export-runner.ts).
   *
   * Renvoie `null` si l'appel échoue (perms manquantes, salon vide,
   * erreur réseau) — l'appelant retombe sur l'ancien calcul par salons.
   */
  async searchMessageCount(
    guildId: Snowflake,
    channelId: Snowflake,
    maxId?: Snowflake,
    minId?: Snowflake,
  ): Promise<number | null> {
    try {
      const params = [`channel_id=${channelId}`, 'limit=1'];
      if (maxId) params.push(`max_id=${maxId}`);
      if (minId) params.push(`min_id=${minId}`);
      const res = await this.get<{ total_results?: number }>(
        `/guilds/${guildId}/messages/search?${params.join('&')}`,
        true,
      );
      const n = res.total_results;
      return typeof n === 'number' && n >= 0 ? n : null;
    } catch (e) {
      // 403 (pas la permission de chercher), 404 (salon inaccessible),
      // 429 (rate-limit excédé) — tous non-fatals pour l'export lui-même.
      // Traçé pour qu'un utilisateur dont l'estimation foire en masse puisse
      // ouvrir un rapport éclairant.
      recordEvent('warn', `searchMessageCount(${channelId}) a échoué : ${String(e)}`);
      return null;
    }
  }

  /**
   * Variante DM : l'API search guild n'existe pas pour les DMs. Discord
   * expose `/channels/{id}/messages/search?limit=1` qui marche aussi pour
   * les channels DM/group. Supporte aussi `max_id`/`min_id` pour la
   * dichotomie en cas de plafonnement à 8000.
   */
  async searchDmMessageCount(
    channelId: Snowflake,
    maxId?: Snowflake,
    minId?: Snowflake,
  ): Promise<number | null> {
    try {
      const params = ['limit=1'];
      if (maxId) params.push(`max_id=${maxId}`);
      if (minId) params.push(`min_id=${minId}`);
      const res = await this.get<{ total_results?: number }>(
        `/channels/${channelId}/messages/search?${params.join('&')}`,
        true,
      );
      const n = res.total_results;
      return typeof n === 'number' && n >= 0 ? n : null;
    } catch (e) {
      // Même logique que searchMessageCount — non-fatal, mais on trace pour
      // pouvoir investiguer si l'estimation foire systématiquement sur les DMs.
      recordEvent('warn', `searchDmMessageCount(${channelId}) a échoué : ${String(e)}`);
      return null;
    }
  }

  /** Threads archivés d'un salon (`public` ou `private`). */
  async getArchivedThreads(
    channelId: Snowflake,
    kind: 'public' | 'private',
  ): Promise<RawChannel[]> {
    const res = await this.get<{ threads: RawChannel[] }>(
      `/channels/${channelId}/threads/archived/${kind}`,
      true,
    );
    return res.threads;
  }

  /** Threads actifs d'un serveur (GET /guilds/{id}/threads/active). */
  async getActiveThreads(guildId: Snowflake): Promise<RawChannel[]> {
    const res = await this.get<ActiveThreadsResponse>(
      `/guilds/${guildId}/threads/active`,
    );
    return res.threads;
  }

  /**
   * Tous les utilisateurs ayant réagi à un message avec un emoji donné.
   *
   * L'`emojiParam` de l'URL diffère selon la nature de l'emoji :
   * - unicode  → le `name` brut (ex. `👍`), URL-encodé ;
   * - custom   → `name:id` (ex. `vespry:123456789`), URL-encodé.
   *
   * Discord distingue deux familles de réactions : normales (`type=0`) et
   * « super-réactions » burst (`type=1`). On interroge les DEUX, puis on
   * fusionne en dédupliquant par `user.id` — un même utilisateur peut figurer
   * dans les deux familles.
   *
   * Chaque famille est paginée par lots de 100 via le curseur `after`.
   */
  async getReactions(
    channelId: Snowflake,
    messageId: Snowflake,
    emoji: RawEmoji,
  ): Promise<RawUser[]> {
    // Emoji custom : `name:id`. Emoji unicode : `name` seul. Sans l'un ni
    // l'autre, l'emoji n'est pas adressable — on renvoie une liste vide.
    let emojiKey: string;
    if (emoji.id) {
      if (!emoji.name) return [];
      emojiKey = `${emoji.name}:${emoji.id}`;
    } else if (emoji.name) {
      emojiKey = emoji.name;
    } else {
      return [];
    }
    const emojiParam = encodeURIComponent(emojiKey);
    const basePath = `/channels/${channelId}/messages/${messageId}/reactions/${emojiParam}`;

    const byId = new Map<Snowflake, RawUser>();
    // type 0 = réactions normales, type 1 = super-réactions « burst ».
    for (const type of [0, 1] as const) {
      let after: Snowflake | undefined;
      for (;;) {
        const cursor = after ? `&after=${after}` : '';
        const page = await this.get<RawUser[]>(
          `${basePath}?limit=100&type=${type}${cursor}`,
          true,
        );
        for (const user of page) {
          if (!byId.has(user.id)) byId.set(user.id, user);
        }
        // Page incomplète → plus rien à paginer pour cette famille.
        if (page.length < 100) break;
        after = page[page.length - 1]?.id;
        if (!after) break;
      }
    }
    return [...byId.values()];
  }

  /**
   * Supprime un message Discord (`DELETE /channels/{}/messages/{}`).
   *
   * Discord renvoie un 204 No Content en cas de succès. La méthode résout
   * sans valeur — appel impératif uniquement.
   *
   * Gestion d'erreurs :
   * - **204** → succès, on résout.
   * - **404** → le message n'existe plus (déjà supprimé par l'utilisateur,
   *   par un modérateur, par Vespry lui-même dans une exécution précédente).
   *   On considère ça comme un **succès idempotent** : l'effet désiré est
   *   atteint. On log un avertissement console, on ne lève pas.
   * - **403** → permission refusée (ce n'est pas notre message et on n'est
   *   pas modérateur du salon). Lève `DiscordApiError('forbidden')` —
   *   l'appelant peut décider d'ignorer ou de remonter à l'utilisateur.
   * - **401** → session expirée. Lève `DiscordApiError('auth')`.
   * - **429** → géré par le back-off `request()` (même mécanique que GET).
   *
   * On ne supporte PAS `bulk-delete` (POST /messages/bulk-delete) :
   * l'API exige des messages de moins de 14 jours, 2 à 100 par lot — trop
   * spécifique pour gagner. On supprime un par un avec back-off, à ~5/sec
   * (le rate-limit Discord pour DELETE message est gracieux).
   */
  async deleteMessage(
    channelId: Snowflake,
    messageId: Snowflake,
  ): Promise<void> {
    const path = `/channels/${channelId}/messages/${messageId}`;
    const result = await this.request<null>(path, {
      method: 'DELETE',
      // Délai inter-requêtes appliqué — protège du rate-limit DELETE.
      throttle: true,
      // 404 = idempotence : un message déjà supprimé est un succès.
      tolerate404: true,
      // 204 No Content → pas de corps à parser.
      expectEmpty: true,
    });
    // `result === null` est le seul cas attendu (204 ou 404 toléré).
    // On le signale uniquement quand c'est un 404 — pas moyen de le savoir
    // ici sans changer la signature de `request()`. On log au niveau
    // appelant si besoin (la PurgeQueue saura distinguer).
    void result;
  }

  /**
   * Télécharge un média depuis le CDN Discord. Pas d'en-tête `authorization` :
   * l'URL CDN est elle-même signée. Renvoie le Blob, ou null sur échec.
   */
  async downloadAsset(url: string): Promise<Blob | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // 403 / 404 sur lien CDN signé typiquement = URL expirée (~24 h).
        // L'asset reste marqué `failed` dans le store, on note la raison.
        recordEvent('warn', `downloadAsset ${res.status} ${res.statusText} ${url.slice(0, 80)}`);
        return null;
      }
      return await res.blob();
    } catch (e) {
      // Erreur réseau / CSP / lien malformé — l'export continue mais l'asset
      // manquera dans le zip. Sam doit voir ces lignes dans le rapport.
      recordEvent('warn', `downloadAsset a échoué : ${String(e)} sur ${url.slice(0, 80)}`);
      return null;
    }
  }
}
