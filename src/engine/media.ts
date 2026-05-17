/**
 * Extraction des médias d'un message Discord.
 *
 * Par défaut on récupère TOUT ce que Discord expose : images, vidéos, audio,
 * fichiers. La `MediaSelection` de l'export permet de filtrer par type.
 */
import type { AssetKind, MediaSelection } from './checkpoint-types';
import type { RawMessage } from './types';

const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif',
  'tiff', 'tif', 'svg', 'apng', 'avif', 'ico',
]);
const VIDEO_EXTS = new Set([
  'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'flv', 'wmv', 'mpeg', 'mpg',
]);
const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'opus', 'aac', 'wma',
]);

export interface AssetDescriptor {
  /** Clé unique stable (id d'attachment, ou hash d'URL pour les embeds). */
  assetId: string;
  url: string;
  kind: AssetKind;
  filename: string;
}

function extOf(s: string): string {
  const m = /\.([A-Za-z0-9]{1,6})(?:$|\?)/.exec(s);
  return m?.[1]?.toLowerCase() ?? '';
}

/** Classe une extension de fichier en type de média. */
export function classifyExt(ext: string): AssetKind {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'file';
}

/**
 * Médias filtrables par la sélection. `emoji` et `avatar` n'y figurent pas :
 * ils sont toujours récupérés (identité du message, indépendante du choix
 * de médias).
 */
const SELECTION_KEY: Partial<Record<AssetKind, keyof MediaSelection>> = {
  image: 'images',
  video: 'videos',
  audio: 'audio',
  file: 'files',
};

/** Hash court et stable d'une URL (pour les médias d'embed sans id). */
export function hashUrl(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i += 1) {
    h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Vrai si ce type de média est demandé. `emoji`/`avatar` : toujours pris. */
function wanted(kind: AssetKind, sel: MediaSelection): boolean {
  const key = SELECTION_KEY[kind];
  return key ? sel[key] : true;
}

/**
 * Collecte les médias d'un message selon la sélection. Couvre les pièces
 * jointes, les médias d'embed (thumbnail / image / video) et les stickers.
 * Dédupliqué par `assetId`.
 */
export function collectAssets(
  message: RawMessage,
  sel: MediaSelection,
): AssetDescriptor[] {
  const out = new Map<string, AssetDescriptor>();
  const add = (d: AssetDescriptor): void => {
    if (wanted(d.kind, sel)) out.set(d.assetId, d);
  };

  for (const att of message.attachments) {
    const ext = extOf(att.filename) || extOf(att.url);
    add({
      assetId: att.id,
      url: att.url,
      kind: classifyExt(ext),
      filename: att.filename || `${att.id}.${ext || 'bin'}`,
    });
  }

  for (const embed of message.embeds) {
    for (const node of [embed.thumbnail, embed.image]) {
      if (!node?.url) continue;
      const ext = extOf(node.url);
      const id = hashUrl(node.url);
      add({ assetId: id, url: node.url, kind: 'image', filename: `embed_${id}.${ext || 'png'}` });
    }
    if (embed.video?.url) {
      const ext = extOf(embed.video.url);
      const id = hashUrl(embed.video.url);
      add({ assetId: id, url: embed.video.url, kind: 'video', filename: `embed_${id}.${ext || 'mp4'}` });
    }
  }

  for (const sticker of message.sticker_items ?? []) {
    // format_type : 1 PNG · 2 APNG · 3 LOTTIE · 4 GIF. On prend les rasterisables.
    const ext = sticker.format_type === 4 ? 'gif' : 'png';
    if (sticker.format_type === 3) continue; // Lottie (vectoriel) : ignoré
    add({
      assetId: `sticker_${sticker.id}`,
      url: `https://media.discordapp.net/stickers/${sticker.id}.${ext}`,
      kind: 'image',
      filename: `sticker_${sticker.id}.${ext}`,
    });
  }

  return [...out.values()];
}
