/**
 * Extraction des médias d'un message Discord.
 *
 * Par défaut on récupère TOUT ce que Discord expose : images, vidéos, audio,
 * fichiers. La `MediaSelection` de l'export permet de filtrer par type.
 *
 * En plus des médias filtrables, on collecte TOUJOURS (indépendamment de la
 * sélection) les emojis custom — présents dans le `content` (`<:nom:id>` /
 * `<a:nom:id>`) et dans les réactions — ainsi que l'avatar de l'auteur.
 * Ces assets relèvent de l'identité du message, pas du choix de médias.
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

/** Motif d'emoji custom dans le contenu : `<:nom:id>` / `<a:nom:id>`. */
const CUSTOM_EMOJI_RE = /<(a?):(\w+):(\d+)>/g;

/** Assainit un nom d'emoji pour un nom de fichier (non-`\w` → `_`). */
function sanitizeName(name: string): string {
  return name.replace(/\W/g, '_');
}

/**
 * Construit le descripteur d'un emoji custom Discord.
 * URL CDN : `/emojis/{id}.{gif|png}` selon `animated`.
 */
function emojiAsset(id: string, name: string, animated: boolean): AssetDescriptor {
  const ext = animated ? 'gif' : 'png';
  return {
    assetId: `emoji_${id}`,
    url: `https://cdn.discordapp.com/emojis/${id}.${ext}`,
    kind: 'emoji',
    filename: `emoji_${sanitizeName(name)}_${id}.${ext}`,
  };
}

/**
 * Collecte les médias d'un message selon la sélection. Couvre les pièces
 * jointes, les médias d'embed (thumbnail / image / video), les stickers,
 * les emojis custom (contenu + réactions) et l'avatar de l'auteur.
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
    // Icônes d'embed : auteur + pied de page (présentes sur les embeds de bots).
    for (const icon of [embed.author?.icon_url, embed.footer?.icon_url]) {
      if (!icon) continue;
      const ext = extOf(icon);
      const id = hashUrl(icon);
      add({ assetId: id, url: icon, kind: 'image', filename: `embed_${id}.${ext || 'png'}` });
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

  // Emojis custom du contenu : `<:nom:id>` (statique) / `<a:nom:id>` (animé).
  for (const m of message.content.matchAll(CUSTOM_EMOJI_RE)) {
    const animated = m[1] === 'a';
    const name = m[2] ?? '';
    const id = m[3] ?? '';
    add(emojiAsset(id, name, animated));
  }

  // Emojis custom des réactions : tout `emoji` avec un `id` non null.
  for (const reaction of message.reactions ?? []) {
    const { id, name } = reaction.emoji;
    if (id === null) continue; // emoji Unicode standard : pas de CDN
    add(emojiAsset(id, name ?? '', reaction.emoji.animated ?? false));
  }

  // Avatar de l'auteur (ignoré si avatar par défaut, donc hash absent).
  const { author } = message;
  if (author.avatar) {
    const ext = author.avatar.startsWith('a_') ? 'gif' : 'png';
    add({
      assetId: `avatar_${author.id}`,
      url: `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}`,
      kind: 'avatar',
      filename: `avatar_${author.id}.${ext}`,
    });
  }

  return [...out.values()];
}
