/**
 * Packager — génère le paquet d'export à partir du checkpoint IndexedDB.
 *
 * Sortie (selon les formats choisis) :
 *   json/<salon>.json   un fichier par salon, messages chronologiques
 *   html/<salon>.html   page lisible façon Discord
 *   csv/<salon>.csv     tableur
 *   txt/<salon>.txt     texte brut
 *   media/<salon>/...    images
 *   video/<salon>/...    vidéos
 *   audio/<salon>/...    audio
 *   files/<salon>/...    autres fichiers (docs, txt…)
 *   INDEX.md             mode d'emploi + table des salons
 *   manifest.json        stats machine-readable
 *
 * Le zip est streamé via conflux : les données étant déjà dans IndexedDB, un
 * échec de zip est relançable sans re-fetcher Discord.
 */
import { Writer } from '@transcend-io/conflux';
import type { CheckpointStore } from './checkpoint-store';
import type { AssetKind, ExportFormat } from './checkpoint-types';
import { DEFAULT_FORMATS } from './checkpoint-types';
import {
  toCsv, toHtml, toTxt,
  type ExportContext, type ExportLabels,
} from './exporters';
import { t } from '../ui/i18n';
import type { RawMessage } from './types';

/** Construit le jeu de libellés traduits injectés dans les fichiers exportés. */
function buildLabels(): ExportLabels {
  return {
    messages: t('exp.messages'),
    edited: t('exp.edited'),
    replyTo: t('exp.reply_to'),
    attachment: t('exp.attachment'),
    sticker: t('exp.sticker'),
    embed: t('exp.embed'),
    reactions: t('exp.reactions'),
    systemLabel: t('exp.system_label'),
    systemMessage: (type) => t('exp.system_message', { n: type }),
    exportedBy: t('exp.exported_by'),
    mentions: {
      user: t('mention.user'),
      role: t('mention.role'),
      channel: t('mention.channel'),
    },
  };
}

/** Sous-dossier et extension de chaque format. */
const FORMAT_DIR: Record<ExportFormat, string> = {
  json: 'json', html: 'html', csv: 'csv', txt: 'txt',
};

/** Dossier de sortie selon le type de média. */
const KIND_DIR: Record<AssetKind, string> = {
  image: 'media',
  video: 'video',
  audio: 'audio',
  file: 'files',
  emoji: 'emojis',
  avatar: 'avatars',
};

/**
 * Découpe une liste de messages en partitions de `size` au plus.
 * `size` ≤ 0 → une seule partition (pas de découpage).
 */
function partitionMessages(messages: RawMessage[], size: number): RawMessage[][] {
  if (size <= 0 || messages.length <= size) return [messages];
  const parts: RawMessage[][] = [];
  for (let i = 0; i < messages.length; i += size) {
    parts.push(messages.slice(i, i + size));
  }
  return parts;
}

function safeName(s: string): string {
  const cleaned = s.replace(/[^\w\-. ]/gu, '_').trim().replace(/\s+/g, ' ');
  return cleaned.slice(0, 100) || 'x';
}

/** Message enrichi du chemin local de ses médias. */
function enrichMessage(msg: RawMessage, urlToPath: Map<string, string>): unknown {
  const attachments = msg.attachments.map((a) => {
    const localPath = urlToPath.get(a.url);
    return localPath ? { ...a, localPath } : a;
  });
  const embeds = msg.embeds.map((e) => {
    const patch: Record<string, unknown> = { ...e };
    for (const key of ['thumbnail', 'image', 'video'] as const) {
      const node = e[key];
      const localPath = node?.url ? urlToPath.get(node.url) : undefined;
      if (node && localPath) patch[key] = { ...node, localPath };
    }
    // Icônes auteur / pied de page (champ `icon_url`).
    for (const key of ['author', 'footer'] as const) {
      const node = e[key];
      const localPath = node?.icon_url ? urlToPath.get(node.icon_url) : undefined;
      if (node && localPath) patch[key] = { ...node, localPath };
    }
    return patch;
  });
  return { ...msg, attachments, embeds };
}

interface ChannelStat {
  name: string;
  /** Fichiers générés pour ce salon, un par format choisi. */
  files: string[];
  messages: number;
  media: number;
}

export interface PackageResult {
  blob: Blob;
  manifest: unknown;
}

/** Construit le paquet zip agent-ready pour un run. */
export async function packageRun(
  store: CheckpointStore,
  runId: string,
): Promise<PackageResult> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run introuvable : ${runId}`);
  const channels = await store.getChannels(runId);
  const assets = await store.getAssets(runId);

  const channelSlug = new Map<string, string>();
  for (const ch of channels) channelSlug.set(ch.channelId, safeName(ch.name));

  // Plan des médias : url -> chemin relatif dans le zip.
  const urlToPath = new Map<string, string>();
  const assetEntries: { path: string; blob: Blob }[] = [];
  const mediaPerChannel = new Map<string, number>();
  let assetsDownloaded = 0;
  let assetsFailed = 0;

  for (const asset of assets) {
    if (asset.status === 'failed') assetsFailed += 1;
    if (asset.status !== 'done' || !asset.blob) continue;
    const slug = channelSlug.get(asset.channelId) ?? 'unknown';
    const path = `${KIND_DIR[asset.kind]}/${slug}/${safeName(asset.filename)}`;
    urlToPath.set(asset.url, path);
    assetEntries.push({ path, blob: asset.blob });
    assetsDownloaded += 1;
    mediaPerChannel.set(
      asset.channelId,
      (mediaPerChannel.get(asset.channelId) ?? 0) + 1,
    );
  }

  // Zip streamé.
  const { readable, writable } = new Writer();
  const zipBlobPromise = new Response(readable).blob();
  const writer = writable.getWriter();
  const writeText = async (name: string, text: string): Promise<void> => {
    await writer.write({ name, stream: () => new Blob([text]).stream() });
  };

  // Formats choisis — défaut robuste si un run d'avant cette option est repris.
  const formats = run.options.formats?.length
    ? run.options.formats
    : DEFAULT_FORMATS;

  const stats: ChannelStat[] = [];

  // Découpe en partitions de `partitionSize` messages (0 = pas de découpage).
  const partSize = run.options.partitionSize ?? 0;
  // Libellés traduits — capturés une fois pour tout le run.
  const labels = buildLabels();

  for (const ch of channels) {
    const slug = channelSlug.get(ch.channelId) ?? 'unknown';
    // Messages bruts collectés une fois, réutilisés par tous les formats.
    const raw: RawMessage[] = [];
    await store.forEachMessage(runId, ch.channelId, (sm) => {
      raw.push(sm.message);
    });
    const parts = partitionMessages(raw, partSize);
    const files: string[] = [];

    for (let p = 0; p < parts.length; p += 1) {
      const chunk = parts[p] ?? [];
      // Suffixe `.partN` seulement s'il y a plus d'une partition.
      const suffix = parts.length > 1 ? `.part${p + 1}` : '';
      const ctx: ExportContext = {
        guildName: run.guildName,
        channelName: parts.length > 1
          ? `${ch.name} (${t('exp.part', { n: p + 1, total: parts.length })})`
          : ch.name,
        urlToPath,
        labels,
      };
      for (const format of formats) {
        const file = `${FORMAT_DIR[format]}/${slug}${suffix}.${format}`;
        if (format === 'json') {
          await writeText(file, JSON.stringify(
            {
              channel: { id: ch.channelId, name: ch.name, type: ch.type },
              part: parts.length > 1
                ? { index: p + 1, total: parts.length }
                : undefined,
              messageCount: chunk.length,
              messages: chunk.map((m) => enrichMessage(m, urlToPath)),
            },
            null,
            2,
          ));
        } else if (format === 'html') {
          await writeText(file, toHtml(ctx, chunk));
        } else if (format === 'csv') {
          await writeText(file, toCsv(ctx, chunk));
        } else {
          await writeText(file, toTxt(ctx, chunk));
        }
        files.push(file);
      }
    }

    stats.push({
      name: ch.name,
      files,
      messages: raw.length,
      media: mediaPerChannel.get(ch.channelId) ?? 0,
    });
  }

  // Médias.
  for (const entry of assetEntries) {
    await writer.write({ name: entry.path, stream: () => entry.blob.stream() });
  }

  // manifest.json + INDEX.md
  const totalMessages = stats.reduce((s, c) => s + c.messages, 0);
  const manifest = {
    guild: run.guildName,
    guildId: run.guildId,
    exportedAt: new Date().toISOString(),
    options: run.options,
    totals: {
      channels: stats.length,
      messages: totalMessages,
      assetsDownloaded,
      assetsFailed,
    },
    channels: stats,
  };
  await writeText('manifest.json', JSON.stringify(manifest, null, 2));
  await writeText(
    'INDEX.md',
    buildIndex(run.guildName, stats, totalMessages, assetsDownloaded),
  );

  await writer.close();
  const blob = await zipBlobPromise;
  return { blob, manifest };
}

function buildIndex(
  guild: string,
  stats: ChannelStat[],
  totalMessages: number,
  assets: number,
): string {
  const lines = [
    `# Export Discord — ${guild}`,
    '',
    `- Salons : **${stats.length}**`,
    `- Messages : **${totalMessages}**`,
    `- Médias téléchargés : **${assets}**`,
    '',
    '## Comment lire',
    '',
    '- `html/<salon>.html` — page lisible façon Discord, à ouvrir dans un',
    '  navigateur.',
    '- `json/<salon>.json` — un fichier par salon, messages chronologiques.',
    "  Chaque message : `id`, `timestamp`, `author`, `content`, `attachments`,",
    '  `embeds`, `reactions`, `mentions`, `message_reference` (= réponse à un',
    "  message d'origine). Les médias téléchargés portent un champ `localPath`.",
    '- `csv/<salon>.csv` — tableur. `txt/<salon>.txt` — texte brut.',
    '- `media/` images · `video/` vidéos · `audio/` audio · `files/` autres',
    '  fichiers — rangés par salon.',
    '- `manifest.json` — statistiques.',
    '',
    '## Salons',
    '',
    '| Salon | Messages | Médias | Fichiers |',
    '|---|--:|--:|---|',
    ...stats.map(
      (c) =>
        `| ${c.name} | ${c.messages} | ${c.media} | `
        + `${c.files.map((f) => `\`${f}\``).join(' ')} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
