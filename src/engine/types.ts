/**
 * Types du domaine Discord + types internes Vespry.
 *
 * Les types `Raw*` reflètent la forme JSON renvoyée par l'API Discord v10
 * (snake_case). On ne type QUE les champs qu'on consomme à l'écran ou dans
 * les rendus (HTML/TXT/CSV). Mais le runtime JS ne déclare rien : tous les
 * champs reçus de Discord sont conservés tels quels jusque dans le JSON
 * exporté — c'est la garantie de FORWARD-COMPATIBILITÉ. Si Discord ajoute
 * un champ demain, on ne l'affichera pas (on ne sait pas comment), mais il
 * sera intégralement préservé dans le JSON pour analyse a posteriori.
 *
 * Vérification : `packager.test.ts` → "préserve les champs Discord inconnus".
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
  /** Texte alternatif (accessibilité). */
  description?: string;
  /** Messages vocaux : durée en secondes. */
  duration_secs?: number;
  /** Messages vocaux : forme d'onde encodée (base64). */
  waveform?: string;
}

export interface RawEmbedMedia {
  url?: string;
  proxy_url?: string;
  width?: number;
  height?: number;
}

export interface RawEmbedAuthor {
  name?: string;
  url?: string;
  icon_url?: string;
  proxy_icon_url?: string;
}

export interface RawEmbedFooter {
  text?: string;
  icon_url?: string;
  proxy_icon_url?: string;
}

export interface RawEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface RawEmbedProvider {
  name?: string;
  url?: string;
}

export interface RawEmbed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  thumbnail?: RawEmbedMedia;
  image?: RawEmbedMedia;
  video?: RawEmbedMedia;
  author?: RawEmbedAuthor;
  footer?: RawEmbedFooter;
  fields?: RawEmbedField[];
  provider?: RawEmbedProvider;
}

export interface RawMessageReference {
  /** 0 = Reply (défaut), 1 = Forward. */
  type?: number;
  message_id?: Snowflake;
  channel_id?: Snowflake;
  guild_id?: Snowflake;
}

export interface RawEmoji {
  id: Snowflake | null;
  name: string | null;
  animated?: boolean;
}

export interface RawReaction {
  count: number;
  /** Détail normal vs « super-réactions » (burst). */
  count_details?: { normal: number; burst: number };
  emoji: RawEmoji;
  /**
   * Utilisateurs ayant réagi avec cet emoji. Vide par défaut — rempli
   * seulement si `ExportOptions.includeReactionUsers` est activé (coûteux :
   * un appel API par emoji).
   */
  users?: RawUser[];
}

/**
 * Composant interactif Discord (bouton, menu, etc.). Forme générique :
 * Discord ajoute régulièrement de nouveaux types, on type ce qu'on rend.
 *  - 1  = ActionRow (conteneur d'enfants)
 *  - 2  = Button (label, url, style)
 *  - 3..8 = Select / String / User / Role / Mentionable / Channel
 *  - 4  = TextInput (rare, dans des modales)
 */
export interface RawComponent {
  type: number;
  /** ActionRow : enfants ; SelectMenu : options ; bouton/menu : ignoré. */
  components?: RawComponent[];
  label?: string;
  url?: string;
  /** 5 = lien externe, autres = bouton applicatif. */
  style?: number;
  disabled?: boolean;
  placeholder?: string;
  emoji?: { name?: string };
  /** Options pour les select menus statiques. */
  options?: { label: string; description?: string }[];
}

/** Une réponse à un sondage Discord (option proposée). */
export interface RawPollAnswer {
  answer_id: number;
  poll_media: { text?: string; emoji?: { name?: string; id?: string | null } };
}

/** Résultats d'un sondage (si déjà votés). */
export interface RawPollResults {
  is_finalized?: boolean;
  answer_counts?: { id: number; count: number; me_voted?: boolean }[];
}

/** Sondage Discord (feature « Polls »). */
export interface RawPoll {
  question: { text?: string };
  answers: RawPollAnswer[];
  expiry?: string | null;
  allow_multiselect?: boolean;
  layout_type?: number;
  results?: RawPollResults;
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
  tts?: boolean;
  flags?: number;
  webhook_id?: Snowflake;
  attachments: RawAttachment[];
  embeds: RawEmbed[];
  reactions?: RawReaction[];
  mentions?: RawUser[];
  mention_roles?: Snowflake[];
  mention_everyone?: boolean;
  message_reference?: RawMessageReference;
  referenced_message?: RawMessage | null;
  sticker_items?: { id: Snowflake; name: string; format_type: number }[];
  /** Thread démarré depuis ce message — sert à découvrir les fils. */
  thread?: RawChannel;
  /** Composants interactifs (boutons, menus). Forme libre, conservée telle quelle. */
  components?: RawComponent[];
  /** Sondage Discord attaché. */
  poll?: RawPoll;
  /** Données d'appel (DM vocaux). */
  call?: { participants: Snowflake[]; ended_timestamp?: string | null };
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
