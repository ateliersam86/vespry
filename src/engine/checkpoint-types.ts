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

/**
 * Une zone de sélection — un critère qui désigne un ensemble de messages.
 * L'export d'un salon = l'UNION de toutes ses zones (aucune zone = tout).
 *
 * - `period`   : messages dans une plage de dates.
 * - `author`   : messages dont le nom d'auteur contient `query`.
 * - `content`  : messages dont le texte contient `query`.
 * - `mention`  : messages mentionnant un utilisateur dont le nom contient `query`.
 * - `pinned`/`attachment`/`link` : messages épinglés / avec pièce jointe / avec lien.
 * - `manual`   : messages choisis un par un dans un salon donné.
 */
export type SelectionZone =
  | { kind: 'period'; afterMs?: number; beforeMs?: number }
  | { kind: 'author'; query: string }
  | { kind: 'content'; query: string }
  | { kind: 'mention'; query: string }
  | { kind: 'pinned' }
  | { kind: 'attachment' }
  | { kind: 'link' }
  | { kind: 'manual'; channelId: Snowflake; ids: Snowflake[] };

/** Vrai si le message satisfait UNE zone de sélection donnée. */
export function zoneMatches(
  zone: SelectionZone,
  m: RawMessage,
  channelId: string,
): boolean {
  switch (zone.kind) {
    case 'period': {
      const t = Date.parse(m.timestamp);
      if (zone.afterMs !== undefined && t < zone.afterMs) return false;
      if (zone.beforeMs !== undefined && t > zone.beforeMs) return false;
      return true;
    }
    case 'author': {
      const q = zone.query.trim().toLowerCase();
      if (!q) return false;
      return `${m.author.username} ${m.author.global_name ?? ''}`
        .toLowerCase().includes(q);
    }
    case 'content': {
      const q = zone.query.trim().toLowerCase();
      return q ? m.content.toLowerCase().includes(q) : false;
    }
    case 'mention': {
      const q = zone.query.trim().toLowerCase();
      if (!q) return false;
      return (m.mentions ?? []).some((u) =>
        `${u.username} ${u.global_name ?? ''}`.toLowerCase().includes(q));
    }
    case 'pinned':
      return m.pinned === true;
    case 'attachment':
      return m.attachments.length > 0;
    case 'link':
      return /https?:\/\//i.test(m.content);
    case 'manual':
      return zone.channelId === channelId && zone.ids.includes(m.id);
  }
}

/**
 * Vrai si le message appartient à l'UNION des zones de sélection.
 * Aucune zone → tout passe.
 */
export function messageMatchesZones(
  m: RawMessage,
  zones: SelectionZone[],
  channelId: string,
): boolean {
  if (zones.length === 0) return true;
  return zones.some((z) => zoneMatches(z, m, channelId));
}

/**
 * Format d'un fichier d'export, généré par le packager.
 * - `json` : structuré, fidèle, idéal pour l'archivage et l'analyse.
 * - `html` : page lisible façon Discord, ouvrable dans un navigateur.
 * - `csv`  : tableur (Excel, LibreOffice…).
 * - `txt`  : texte brut, le plus léger.
 */
export type ExportFormat = 'json' | 'html' | 'csv' | 'txt';

/** Tous les formats, dans l'ordre d'affichage. */
export const ALL_FORMATS: ExportFormat[] = ['json', 'html', 'csv', 'txt'];

/** Défaut : JSON (archivage) + HTML (lecture). */
export const DEFAULT_FORMATS: ExportFormat[] = ['json', 'html'];

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
  /** Zones de sélection. Vide = tout le salon ; sinon = union des zones. */
  zones: SelectionZone[];
  /** Formats de fichier à générer. Défaut : `DEFAULT_FORMATS`. */
  formats: ExportFormat[];
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
