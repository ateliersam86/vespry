/**
 * Types du domaine Discord + types internes Vespry.
 *
 * Les types `Raw*` reflètent la forme JSON renvoyée par l'API Discord v10
 * (snake_case). On ne type que les champs qu'on consomme.
 */

export type Snowflake = string;

// --- Formes brutes de l'API Discord ---

export interface RawUser {
  id: Snowflake;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
  bot?: boolean;
}

export interface RawGuild {
  id: Snowflake;
  name: string;
  icon?: string | null;
}

/** Types de salon Discord pertinents pour l'export. */
export enum ChannelType {
  GUILD_TEXT = 0,
  DM = 1,
  GUILD_VOICE = 2,
  GROUP_DM = 3,
  GUILD_CATEGORY = 4,
  GUILD_ANNOUNCEMENT = 5,
  ANNOUNCEMENT_THREAD = 10,
  PUBLIC_THREAD = 11,
  PRIVATE_THREAD = 12,
  GUILD_FORUM = 15,
}

export interface RawChannel {
  id: Snowflake;
  type: ChannelType;
  name?: string | null;
  topic?: string | null;
  parent_id?: Snowflake | null;
  position?: number;
  guild_id?: Snowflake;
  /** Présent sur les DM / group DM. */
  recipients?: RawUser[];
}

export interface RawAttachment {
  id: Snowflake;
  filename: string;
  size: number;
  url: string;
  proxy_url: string;
  content_type?: string;
  width?: number;
  height?: number;
}

export interface RawEmbedMedia {
  url?: string;
  proxy_url?: string;
  width?: number;
  height?: number;
}

export interface RawEmbed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  thumbnail?: RawEmbedMedia;
  image?: RawEmbedMedia;
  video?: RawEmbedMedia;
}

export interface RawMessageReference {
  message_id?: Snowflake;
  channel_id?: Snowflake;
  guild_id?: Snowflake;
}

export interface RawReaction {
  count: number;
  emoji: { id: Snowflake | null; name: string | null };
}

export interface RawMessage {
  id: Snowflake;
  type: number;
  channel_id: Snowflake;
  author: RawUser;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  pinned?: boolean;
  attachments: RawAttachment[];
  embeds: RawEmbed[];
  reactions?: RawReaction[];
  mentions?: RawUser[];
  message_reference?: RawMessageReference;
  referenced_message?: RawMessage | null;
  sticker_items?: { id: Snowflake; name: string; format_type: number }[];
}

/** Réponse de GET /guilds/{id}/threads/active. */
export interface ActiveThreadsResponse {
  threads: RawChannel[];
}

// --- Erreurs ---

export type DiscordErrorKind = 'auth' | 'forbidden' | 'not_found' | 'network' | 'unknown';

export class DiscordApiError extends Error {
  constructor(
    public readonly kind: DiscordErrorKind,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}
