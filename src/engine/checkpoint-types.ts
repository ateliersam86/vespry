/**
 * Types du checkpoint — l'état persistant d'un export dans IndexedDB.
 *
 * IndexedDB est la source de vérité : chaque lot de 100 messages y est écrit
 * immédiatement, ce qui rend l'export resumable après crash/reboot.
 */
import type { RawMessage, Snowflake } from './types';

export type RunStatus =
  | 'in_progress'
  | 'paused' // interrompu (401, quota, fermeture) — reprenable
  | 'completed'
  | 'partial' // terminé mais des salons/médias ont échoué
  | 'failed';

export type ChannelStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'partial' // accès perdu en cours de route
  | 'skipped';

export type AssetStatus = 'pending' | 'done' | 'failed';
export type AssetKind = 'image' | 'video' | 'audio' | 'file' | 'emoji' | 'avatar';

/**
 * Sélection des médias à télécharger — personnalisable.
 * Par défaut on prend TOUT ce que Discord expose (cf. `ALL_MEDIA`).
 */
export interface MediaSelection {
  images: boolean;
  videos: boolean;
  audio: boolean;
  /** Documents et autres fichiers (txt, pdf, zip…). */
  files: boolean;
}

/** Défaut : tout récupérer. */
export const ALL_MEDIA: MediaSelection = {
  images: true,
  videos: true,
  audio: true,
  files: true,
};

/** Ce que l'utilisateur a choisi d'exporter (modes simple/avancé). */
export interface ExportOptions {
  includeThreads: boolean;
  /** Quels types de médias télécharger. Défaut : `ALL_MEDIA`. */
  media: MediaSelection;
  /**
   * Récupérer la liste des utilisateurs ayant réagi à chaque message.
   * Coûteux (un appel API par emoji distinct) — désactivé par défaut.
   */
  includeReactionUsers?: boolean;
  /** Bornes de date optionnelles (timestamp ms). */
  afterMs?: number;
  beforeMs?: number;
}

/** Un export. */
export interface ExportRun {
  id: string;
  guildId: Snowflake;
  guildName: string;
  status: RunStatus;
  options: ExportOptions;
  createdAt: number;
  updatedAt: number;
  /** Message d'erreur si `status` vaut `failed`/`paused`. */
  error?: string;
}

/** Progression d'un salon dans un run — porte le curseur de reprise. */
export interface ChannelProgress {
  runId: string;
  channelId: Snowflake;
  name: string;
  category: string | null;
  /** ChannelType numérique. */
  type: number;
  status: ChannelStatus;
  /** Id du plus ancien message déjà récupéré = prochain `before`. */
  cursor: Snowflake | null;
  messageCount: number;
  error?: string;
}

/** Un message persisté. Clé composite [runId, channelId, messageId]. */
export interface StoredMessage {
  runId: string;
  channelId: Snowflake;
  messageId: Snowflake;
  message: RawMessage;
}

/** Un média en file de téléchargement (clé composite [runId, assetId]). */
export interface StoredAsset {
  runId: string;
  /** Clé unique : id d'attachment, ou hash d'URL pour les médias d'embed. */
  assetId: string;
  channelId: Snowflake;
  url: string;
  kind: AssetKind;
  filename: string;
  status: AssetStatus;
  /** Blob téléchargé (présent quand `status` vaut `done`). */
  blob?: Blob;
  error?: string;
}
