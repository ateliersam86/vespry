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
 * Comment combiner les zones de critères :
 * - `any` : un message passe s'il satisfait AU MOINS UNE zone (OU).
 * - `all` : un message passe s'il satisfait TOUTES les zones (ET).
 * Les zones manuelles, elles, s'ajoutent toujours en plus (cf. plus bas).
 */
export type ZoneMode = 'any' | 'all';

/** Type d'une attachment, déduit du content-type ou de l'extension. */
function attachmentKind(content_type: string | undefined, url: string): AssetKind {
  const ct = content_type ?? '';
  if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp)(\?|$)/i.test(url)) {
    return 'image';
  }
  if (ct.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)(\?|$)/i.test(url)) {
    return 'video';
  }
  if (ct.startsWith('audio/') || /\.(mp3|ogg|oga|wav|m4a|flac|opus)(\?|$)/i.test(url)) {
    return 'audio';
  }
  return 'file';
}

/** Cœur d'une zone — le critère, sans le drapeau de négation. */
type ZoneCore =
  | { kind: 'period'; afterMs?: number; beforeMs?: number }
  | { kind: 'author'; query: string }
  | { kind: 'content'; query: string }
  | { kind: 'mention'; query: string }
  | { kind: 'pinned' }
  | { kind: 'attachment' }
  | { kind: 'link' }
  | { kind: 'image' }
  | { kind: 'video' }
  | { kind: 'audio' }
  | { kind: 'sticker' }
  | { kind: 'embed' }
  | { kind: 'manual'; channelId: Snowflake; ids: Snowflake[] };

/**
 * Une zone de sélection — un critère qui désigne un ensemble de messages.
 *
 * - `period`   : messages dans une plage de dates.
 * - `author`   : messages dont le nom d'auteur contient `query`.
 * - `content`  : messages dont le texte contient `query`.
 * - `mention`  : messages mentionnant un utilisateur dont le nom contient `query`.
 * - `pinned`   : messages épinglés.
 * - `attachment` : avec une pièce jointe (de n'importe quel type).
 * - `image`/`video`/`audio` : avec une pièce jointe de ce type précis.
 * - `sticker`  : avec un sticker. `embed` : avec un embed.
 * - `link`     : dont le texte contient un lien.
 * - `manual`   : messages choisis un par un dans un salon donné.
 *
 * `negate` inverse le critère (NON logique).
 */
export type SelectionZone = ZoneCore & { negate?: boolean };

/** Vrai si le message satisfait le CRITÈRE d'une zone (négation non appliquée). */
function zoneCriterion(
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
    case 'image':
    case 'video':
    case 'audio':
      return m.attachments.some(
        (a) => attachmentKind(a.content_type, a.url) === zone.kind,
      );
    case 'sticker':
      return (m.sticker_items ?? []).length > 0;
    case 'embed':
      return m.embeds.length > 0;
    case 'link':
      return /https?:\/\//i.test(m.content);
    case 'manual':
      return zone.channelId === channelId && zone.ids.includes(m.id);
  }
}

/** Vrai si le message satisfait UNE zone, négation comprise. */
export function zoneMatches(
  zone: SelectionZone,
  m: RawMessage,
  channelId: string,
): boolean {
  const hit = zoneCriterion(zone, m, channelId);
  return zone.negate ? !hit : hit;
}

/**
 * Vrai si le message doit être exporté, selon les zones et le mode.
 *
 * Règle : les zones `manual` (messages cochés à la main) s'ajoutent TOUJOURS
 * en plus — un message coché passe quoi qu'il arrive. Les autres zones (les
 * critères) sont combinées selon `mode` : `any` = OU, `all` = ET.
 *
 * Aucune zone du tout → tout passe.
 */
export function messageMatchesZones(
  m: RawMessage,
  zones: SelectionZone[],
  channelId: string,
  mode: ZoneMode = 'any',
): boolean {
  if (zones.length === 0) return true;
  const manual = zones.filter((z) => z.kind === 'manual');
  const criteria = zones.filter((z) => z.kind !== 'manual');
  // Un message coché à la main passe toujours.
  if (manual.some((z) => zoneMatches(z, m, channelId))) return true;
  if (criteria.length === 0) return false; // que des zones manuelles
  return mode === 'all'
    ? criteria.every((z) => zoneMatches(z, m, channelId))
    : criteria.some((z) => zoneMatches(z, m, channelId));
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
  /** Zones de sélection. Vide = tout le salon. */
  zones: SelectionZone[];
  /** Combinaison des zones de critères : `any` = OU, `all` = ET. */
  zoneMode: ZoneMode;
  /**
   * Plancher temporel absolu (epoch ms) — export incrémental. Les messages
   * antérieurs sont exclus, en ET par-dessus les zones (indépendant du mode).
   * Calculé depuis le dernier export du même serveur.
   */
  sinceMs?: number;
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
