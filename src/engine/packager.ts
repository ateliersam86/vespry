/**
 * Packager — génère le paquet agent-ready à partir du checkpoint IndexedDB.
 *
 * Sortie (cf. design doc) :
 *   json/<salon>.json   un fichier par salon, messages chronologiques
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
import type { AssetKind } from './checkpoint-types';
import type { RawMessage } from './types';

/** Dossier de sortie selon le type de média. */
const KIND_DIR: Record<AssetKind, string> = {
  image: 'media',
  video: 'video',
  audio: 'audio',
  file: 'files',
  emoji: 'emojis',
  avatar: 'avatars',
};

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
  file: string;
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

  const stats: ChannelStat[] = [];

  for (const ch of channels) {
    const slug = channelSlug.get(ch.channelId) ?? 'unknown';
    const messages: unknown[] = [];
    await store.forEachMessage(runId, ch.channelId, (sm) => {
      messages.push(enrichMessage(sm.message, urlToPath));
    });
    const fileName = `${slug}.json`;
    await writeText(
      `json/${fileName}`,
      JSON.stringify(
        {
          channel: { id: ch.channelId, name: ch.name, type: ch.type },
          messageCount: messages.length,
          messages,
        },
        null,
        2,
      ),
    );
    stats.push({
      name: ch.name,
      file: `json/${fileName}`,
      messages: messages.length,
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
    '- `json/<salon>.json` — un fichier par salon, messages chronologiques.',
    "  Chaque message : `id`, `timestamp`, `author`, `content`, `attachments`,",
    '  `embeds`, `reactions`, `mentions`, `message_reference` (= réponse à un',
    "  message d'origine). Les médias téléchargés portent un champ `localPath`.",
    '- `media/` images · `video/` vidéos · `audio/` audio · `files/` autres',
    '  fichiers — rangés par salon.',
    '- `manifest.json` — statistiques.',
    '',
    'Fils de réponses : suivre `message_reference.message_id` vers le message',
    'portant cet `id` dans le JSON du salon `message_reference.channel_id`.',
    '',
    '## Salons',
    '',
    '| Salon | Messages | Médias | JSON |',
    '|---|--:|--:|---|',
    ...stats.map(
      (c) => `| ${c.name} | ${c.messages} | ${c.media} | \`${c.file}\` |`,
    ),
    '',
  ];
  return lines.join('\n');
}
