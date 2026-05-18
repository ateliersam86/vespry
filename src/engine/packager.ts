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
 *
 * Performance adaptative (Phase 1) — le packager consulte `detectPerfProfile()`
 * au démarrage et choisit entre deux chemins :
 *
 * - **Bulk** (profil `fast`) — comportement historique : pour chaque salon on
 *   matérialise le rendu complet (HTML/CSV/TXT/JSON) en RAM puis on l'écrit
 *   d'un coup. Plus rapide quand la RAM est large.
 *
 * - **Streaming** (profils `balanced` et `low`) — on charge les messages bruts
 *   du salon en RAM (N × ~500 octets, supportable même à 100 000 messages),
 *   mais le RENDU est produit par chunks via un `ReadableStream`. C'est ce
 *   rendu qui peut multiplier la taille par 5-10× en HTML : ÇA, on ne le
 *   matérialise jamais. `profile.bufferMessagesPerPage` fixe la granularité
 *   des chunks émis (250 en balanced, ≤ 64 en low).
 */
import { Writer } from '@transcend-io/conflux';
import type { CheckpointStore } from './checkpoint-store';
import type { AssetKind, ExportFormat } from './checkpoint-types';
import { DEFAULT_FORMATS } from './checkpoint-types';
import {
  toCsv, toHtml, toTxt,
  csvHeader, csvMessage,
  createStreamState, htmlFooter, htmlHeader, htmlMessage,
  txtHeader, txtMessage,
  type ExportContext, type ExportLabels,
} from './exporters';
import { detectPerfProfile, type PerfProfile } from './perf-profile';
import { encryptZipBlob } from './encrypt-zip';
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
    poll: t('exp.poll'),
    pollVotes: (n) => t('exp.poll_votes', { n }),
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
 * `size` ≤ 0 → une seule partition (pas de découpage). Utilisé seulement en
 * mode bulk (profil `fast`) ; le streaming gère le partitionnement par slicing
 * du tableau `messages` une fois drainé.
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

/**
 * Mapping enum lisible des `RawMessage.type` numériques Discord.
 * Permet à un agent IA "froid" d'avoir directement `"REPLY"` plutôt qu'à
 * deviner `19`. Le numérique reste dans `type` (forward-compat API).
 *
 * Valeurs : https://discord.com/developers/docs/resources/message#message-object-message-types
 */
const MESSAGE_TYPE_NAMES: Record<number, string> = {
  0: 'DEFAULT',
  1: 'RECIPIENT_ADD',
  2: 'RECIPIENT_REMOVE',
  3: 'CALL',
  4: 'CHANNEL_NAME_CHANGE',
  5: 'CHANNEL_ICON_CHANGE',
  6: 'CHANNEL_PINNED_MESSAGE',
  7: 'USER_JOIN',
  8: 'GUILD_BOOST',
  9: 'GUILD_BOOST_TIER_1',
  10: 'GUILD_BOOST_TIER_2',
  11: 'GUILD_BOOST_TIER_3',
  12: 'CHANNEL_FOLLOW_ADD',
  14: 'GUILD_DISCOVERY_DISQUALIFIED',
  15: 'GUILD_DISCOVERY_REQUALIFIED',
  16: 'GUILD_DISCOVERY_GRACE_PERIOD_INITIAL_WARNING',
  17: 'GUILD_DISCOVERY_GRACE_PERIOD_FINAL_WARNING',
  18: 'THREAD_CREATED',
  19: 'REPLY',
  20: 'CHAT_INPUT_COMMAND',
  21: 'THREAD_STARTER_MESSAGE',
  22: 'GUILD_INVITE_REMINDER',
  23: 'CONTEXT_MENU_COMMAND',
  24: 'AUTO_MODERATION_ACTION',
  25: 'ROLE_SUBSCRIPTION_PURCHASE',
  26: 'INTERACTION_PREMIUM_UPSELL',
  27: 'STAGE_START',
  28: 'STAGE_END',
  29: 'STAGE_SPEAKER',
  31: 'STAGE_TOPIC',
  32: 'GUILD_APPLICATION_PREMIUM_SUBSCRIPTION',
  36: 'GUILD_INCIDENT_ALERT_MODE_ENABLED',
  37: 'GUILD_INCIDENT_ALERT_MODE_DISABLED',
  38: 'GUILD_INCIDENT_REPORT_RAID',
  39: 'GUILD_INCIDENT_REPORT_FALSE_ALARM',
  46: 'PURCHASE_NOTIFICATION',
};

/**
 * Mapping enum lisible des `RawChannel.type` numériques Discord.
 * Permet de mettre `"GUILD_TEXT"` à côté de `0` dans l'enveloppe JSON.
 */
const CHANNEL_TYPE_NAMES: Record<number, string> = {
  0: 'GUILD_TEXT',
  1: 'DM',
  2: 'GUILD_VOICE',
  3: 'GROUP_DM',
  4: 'GUILD_CATEGORY',
  5: 'GUILD_ANNOUNCEMENT',
  10: 'ANNOUNCEMENT_THREAD',
  11: 'PUBLIC_THREAD',
  12: 'PRIVATE_THREAD',
  13: 'GUILD_STAGE_VOICE',
  14: 'GUILD_DIRECTORY',
  15: 'GUILD_FORUM',
  16: 'GUILD_MEDIA',
};

/**
 * URL du schéma JSON publié (placeholder — à mettre derrière une vraie
 * page une fois v0.1.0 publiée). Inclus dans chaque fichier JSON pour
 * permettre à un agent IA / outil de validation de connaître le contrat.
 */
const JSON_SCHEMA_URL = 'https://github.com/ateliersam86/vespry/blob/main/docs/SCHEMA.md';

/**
 * Version Vespry à embarquer dans le JSON. `chrome.runtime.getManifest()`
 * en runtime, fallback statique pour les tests (vitest n'a pas `chrome`).
 */
function vespryVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.1.0';
  }
}

/**
 * Construit l'enveloppe JSON d'un fichier d'export. Cohérente entre les
 * chemins bulk (ligne ~300) et streaming (`jsonHeader` plus bas) —
 * AVANT, le shape était dupliqué et les deux pouvaient diverger
 * silencieusement (cf. note de l'audit B+C, 2026-05-18).
 *
 * Schéma volontairement enrichi par rapport à l'API Discord brute :
 *   - `$schema`, `vespryVersion`, `exportedAt`           → traçabilité
 *   - `guild { id, name }`                               → fichier autoportant
 *   - `channel { id, name, type, typeName }`             → enum lisible
 *   - `messages[].typeName`                              → enum lisible
 *
 * Les champs Discord originaux (snake_case, `type` numérique, etc.) sont
 * conservés intacts — forward-compat sur les futurs champs API.
 */
export function buildJsonEnvelope(args: {
  guildId: string;
  guildName: string;
  channel: { id: string; name: string; type: number };
  part?: { index: number; total: number };
  messages: unknown[];
}): Record<string, unknown> {
  // On enrichit chaque message d'un `typeName` lisible (le `type` numérique
  // reste pour la fidélité API). On évite Object.assign sur des messages
  // déjà passés par enrichMessage — on caste pour ajouter une clé.
  const messages = args.messages.map((m): unknown => {
    const msg = m as { type?: number };
    const t = typeof msg.type === 'number' ? msg.type : 0;
    return { ...msg, typeName: MESSAGE_TYPE_NAMES[t] ?? `UNKNOWN_${t}` };
  });
  const envelope: Record<string, unknown> = {
    $schema: JSON_SCHEMA_URL,
    vespryVersion: vespryVersion(),
    exportedAt: new Date().toISOString(),
    guild: { id: args.guildId, name: args.guildName },
    channel: {
      id: args.channel.id,
      name: args.channel.name,
      type: args.channel.type,
      typeName: CHANNEL_TYPE_NAMES[args.channel.type] ?? `UNKNOWN_${args.channel.type}`,
    },
    messageCount: messages.length,
    messages,
  };
  if (args.part) envelope['part'] = args.part;
  return envelope;
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

/** Options optionnelles pour `packageRun` — surtout pour les tests. */
export interface PackageOptions {
  /**
   * Profil de performance à utiliser. En production on laisse undefined : le
   * packager détecte la machine via `detectPerfProfile()`. Les tests peuvent
   * passer un profil forgé (`'low'`) pour vérifier le chemin streaming.
   */
  profile?: PerfProfile;
}

/** Encode une chaîne UTF-8 — partagé entre tous les helpers de stream. */
const ENCODER = new TextEncoder();

/**
 * Crée un `ReadableStream<Uint8Array>` qui appelle un async generator pour
 * produire ses chunks (chaînes ASCII/UTF-8). On encode dans le stream pour
 * que Conflux reçoive directement des octets.
 */
function streamFromGenerator(
  gen: () => AsyncGenerator<string, void, void>,
): ReadableStream<Uint8Array> {
  let iter: AsyncGenerator<string, void, void> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!iter) iter = gen();
      const { value, done } = await iter.next();
      if (done) {
        controller.close();
        return;
      }
      if (value.length > 0) controller.enqueue(ENCODER.encode(value));
    },
    async cancel() {
      if (iter) await iter.return();
    },
  });
}

/** Sérialise un message JSON (enrichi) avec une indentation deux espaces. */
function jsonMessage(msg: RawMessage, urlToPath: Map<string, string>): string {
  // Ré-indentation pour matcher la mise en forme historique (élément indenté
  // de 4 espaces dans `JSON.stringify(..., 2)` à l'intérieur d'un tableau).
  return JSON.stringify(enrichMessage(msg, urlToPath), null, 2)
    .replace(/\n/g, '\n    ');
}

/** Construit le paquet zip agent-ready pour un run. */
export async function packageRun(
  store: CheckpointStore,
  runId: string,
  opts: PackageOptions = {},
): Promise<PackageResult> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run introuvable : ${runId}`);
  const channels = await store.getChannels(runId);
  const assets = await store.getAssets(runId);

  // Profil performance : choisi par l'appelant (tests) ou détecté depuis la
  // machine courante. Sur `fast` on garde le chemin bulk historique.
  const profile = opts.profile ?? detectPerfProfile();

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
  const writeStream = async (
    name: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> => {
    await writer.write({ name, stream: () => stream });
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
    const files: string[] = [];
    let totalMessages = 0;

    if (profile.streaming) {
      // ─── Mode streaming (balanced / low) ──────────────────────────────
      const written = await packageChannelStreaming({
        store,
        runId,
        channel: ch,
        slug,
        guildName: run.guildName,
        guildId: run.guildId,
        formats,
        partSize,
        labels,
        urlToPath,
        profile,
        writeStream,
        files,
      });
      totalMessages = written;
    } else {
      // ─── Mode bulk (fast) ─────────────────────────────────────────────
      const raw: RawMessage[] = [];
      await store.forEachMessage(runId, ch.channelId, (sm) => {
        raw.push(sm.message);
      });
      totalMessages = raw.length;
      const parts = partitionMessages(raw, partSize);

      for (let p = 0; p < parts.length; p += 1) {
        const chunk = parts[p] ?? [];
        const suffix = parts.length > 1 ? `.part${p + 1}` : '';
        const ctx: ExportContext = {
          guildName: run.guildName,
          guildId: run.guildId,
          channelName: parts.length > 1
            ? `${ch.name} (${t('exp.part', { n: p + 1, total: parts.length })})`
            : ch.name,
          channel: { id: ch.channelId, name: ch.name, type: ch.type },
          urlToPath,
          labels,
        };
        for (const format of formats) {
          const file = `${FORMAT_DIR[format]}/${slug}${suffix}.${format}`;
          if (format === 'json') {
            const envArgs: {
              guildId: string;
              guildName: string;
              channel: { id: string; name: string; type: number };
              part?: { index: number; total: number };
              messages: unknown[];
            } = {
              guildId: run.guildId,
              guildName: run.guildName,
              channel: { id: ch.channelId, name: ch.name, type: ch.type },
              messages: chunk.map((m) => enrichMessage(m, urlToPath)),
            };
            if (parts.length > 1) {
              envArgs.part = { index: p + 1, total: parts.length };
            }
            await writeText(file, JSON.stringify(buildJsonEnvelope(envArgs), null, 2));
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
    }

    stats.push({
      name: ch.name,
      files,
      messages: totalMessages,
      media: mediaPerChannel.get(ch.channelId) ?? 0,
    });
  }

  // Médias.
  for (const entry of assetEntries) {
    await writer.write({ name: entry.path, stream: () => entry.blob.stream() });
  }

  // manifest.json + INDEX.md
  const totalMessages = stats.reduce((s, c) => s + c.messages, 0);
  // Scrub du mot de passe : il ne doit JAMAIS apparaître dans un artefact
  // sérialisé. On garde le drapeau `encrypted` pour que l'utilisateur sache
  // si son zip est chiffré sans avoir à le deviner.
  const willEncrypt = typeof run.options.zipPassword === 'string'
    && run.options.zipPassword.length > 0;
  const safeOptions: Record<string, unknown> = { ...run.options };
  delete safeOptions['zipPassword'];
  const manifest = {
    guild: run.guildName,
    guildId: run.guildId,
    exportedAt: new Date().toISOString(),
    options: safeOptions,
    encrypted: willEncrypt,
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
  let blob = await zipBlobPromise;

  // Phase 4 — chiffrement AES-256 (opt-in). On encapsule le zip Conflux dans
  // un second zip qui contient une unique entrée chiffrée. Le `Blob` final a
  // toujours `application/zip` ; l'utilisateur ouvre avec 7-Zip / Keka, tape
  // son mot de passe, et obtient le zip métier d'origine.
  if (willEncrypt) {
    blob = await encryptZipBlob(blob, run.options.zipPassword as string);
  }
  return { blob, manifest };
}

/**
 * Implémente le chemin streaming : draine les messages bruts du salon en RAM
 * via le curseur IndexedDB (peu coûteux : N × ~500 octets/message), puis émet
 * chaque fichier d'export comme un `ReadableStream` qui produit le rendu par
 * chunks de `profile.bufferMessagesPerPage` messages.
 *
 * L'invariant Phase 1 protégé ici : on ne matérialise JAMAIS le rendu complet
 * du salon (le HTML peut représenter 5-10× la taille des messages bruts).
 */
async function packageChannelStreaming(args: {
  store: CheckpointStore;
  runId: string;
  channel: { channelId: string; name: string; type: number };
  slug: string;
  guildName: string;
  guildId: string;
  formats: ExportFormat[];
  partSize: number;
  labels: ExportLabels;
  urlToPath: Map<string, string>;
  profile: PerfProfile;
  writeStream: (name: string, stream: ReadableStream<Uint8Array>) => Promise<void>;
  files: string[];
}): Promise<number> {
  const {
    store, runId, channel: ch, slug, guildName, guildId, formats, partSize, labels,
    urlToPath, profile, writeStream, files,
  } = args;

  // Drain du curseur en une seule passe (transaction unique). C'est le RENDU
  // (HTML/CSV/TXT) qu'on évite de matérialiser, pas les messages bruts.
  const all: RawMessage[] = [];
  await store.forEachMessage(runId, ch.channelId, (sm) => {
    all.push(sm.message);
  });
  const total = all.length;

  const partitions = partitionMessages(all, partSize);
  const multiPart = partitions.length > 1;

  for (let p = 0; p < partitions.length; p += 1) {
    const chunk = partitions[p] ?? [];
    const partSuffix = multiPart ? `.part${p + 1}` : '';
    const channelDisplayName = multiPart
      ? `${ch.name} (${t('exp.part', { n: p + 1, total: partitions.length })})`
      : ch.name;
    await writeAllStreams({
      channel: ch, slug, guildName, guildId,
      formats, labels, urlToPath, profile, writeStream, files,
      partSuffix,
      channelDisplayName,
      messages: chunk,
    });
  }
  return total;
}

/**
 * Émet tous les formats d'un salon (ou d'une partition) en streaming —
 * `messages[]` est en RAM, mais le rendu n'est jamais matérialisé en entier :
 * le générateur yield par chunks de `profile.bufferMessagesPerPage` messages.
 */
async function writeAllStreams(args: {
  channel: { channelId: string; name: string; type: number };
  slug: string;
  guildName: string;
  guildId: string;
  formats: ExportFormat[];
  labels: ExportLabels;
  urlToPath: Map<string, string>;
  profile: PerfProfile;
  writeStream: (name: string, stream: ReadableStream<Uint8Array>) => Promise<void>;
  files: string[];
  partSuffix: string;
  channelDisplayName: string;
  messages: RawMessage[];
}): Promise<void> {
  const {
    channel: ch, slug, guildName, guildId, formats, labels, urlToPath, profile,
    writeStream, files, partSuffix, channelDisplayName, messages,
  } = args;
  const ctx: ExportContext = {
    guildName,
    guildId,
    channelName: channelDisplayName,
    channel: { id: ch.channelId, name: ch.name, type: ch.type },
    urlToPath,
    labels,
  };

  for (const format of formats) {
    const file = `${FORMAT_DIR[format]}/${slug}${partSuffix}.${format}`;
    files.push(file);
    const stream = streamFromGenerator(() =>
      generateFormat({ ch, format, ctx, urlToPath, profile, messages }),
    );
    await writeStream(file, stream);
  }
}

/**
 * Génère le contenu d'un fichier d'export par chunks. Le buffer
 * `profile.bufferMessagesPerPage` (clampé à un plancher minimum) fixe le
 * nombre de messages rendus avant chaque yield.
 */
async function* generateFormat(args: {
  ch: { channelId: string; name: string; type: number };
  format: ExportFormat;
  ctx: ExportContext;
  urlToPath: Map<string, string>;
  profile: PerfProfile;
  messages: RawMessage[];
}): AsyncGenerator<string, void, void> {
  const { ch, format, ctx, urlToPath, profile, messages } = args;
  // `bufferMessagesPerPage = 0` (profil `low`) signifie « le plus strict
  // possible » côté mémoire ; flusher message-par-message saturerait conflux
  // pour aucun gain réel, on garde un plancher (64 chunks rendus ≈ 32 ko).
  const MIN_BUFFER_LOW = 64;
  const buffer = profile.bufferMessagesPerPage <= 0
    ? MIN_BUFFER_LOW
    : profile.bufferMessagesPerPage;
  const expectedCount = messages.length;

  const flush = (parts: string[]): string => {
    const out = parts.join('');
    parts.length = 0;
    return out;
  };

  if (format === 'json') {
    // Streaming JSON : on émet la MÊME enveloppe que le chemin bulk
    // (cf. buildJsonEnvelope) en deux temps — l'en-tête, puis les
    // messages ligne par ligne. Sans ça, les deux chemins divergeaient
    // silencieusement (audit B+C, 2026-05-18).
    const tType = ch.type;
    const cType = CHANNEL_TYPE_NAMES[tType] ?? `UNKNOWN_${tType}`;
    yield '{\n'
      + `  "$schema": ${JSON.stringify(JSON_SCHEMA_URL)},\n`
      + `  "vespryVersion": ${JSON.stringify(vespryVersion())},\n`
      + `  "exportedAt": ${JSON.stringify(new Date().toISOString())},\n`
      + `  "guild": ${JSON.stringify({ id: ctx.guildId, name: ctx.guildName })},\n`
      + `  "channel": ${JSON.stringify({ id: ch.channelId, name: ch.name, type: tType, typeName: cType })},\n`
      + `  "messageCount": ${expectedCount},\n`
      + '  "messages": [';
    const acc: string[] = [];
    let first = true;
    let count = 0;
    for (const m of messages) {
      const sep = first ? '\n    ' : ',\n    ';
      first = false;
      // Injecte `typeName` au message en streaming aussi.
      const enriched = JSON.parse(jsonMessage(m, urlToPath)) as { type?: number };
      const tname = MESSAGE_TYPE_NAMES[enriched.type ?? 0] ?? `UNKNOWN_${enriched.type ?? 0}`;
      acc.push(`${sep}${JSON.stringify({ ...enriched, typeName: tname })}`);
      count += 1;
      if (count >= buffer) {
        yield flush(acc);
        count = 0;
      }
    }
    if (acc.length > 0) yield flush(acc);
    yield '\n  ]\n}\n';
    return;
  }

  if (format === 'html') {
    yield htmlHeader(ctx, expectedCount);
    const state = createStreamState();
    const acc: string[] = [];
    let count = 0;
    for (const m of messages) {
      acc.push(htmlMessage(ctx, state, m));
      count += 1;
      if (count >= buffer) {
        yield flush(acc);
        count = 0;
      }
    }
    if (acc.length > 0) yield flush(acc);
    yield htmlFooter();
    return;
  }

  if (format === 'csv') {
    yield csvHeader();
    const acc: string[] = [];
    let count = 0;
    for (const m of messages) {
      acc.push(csvMessage(ctx, m));
      count += 1;
      if (count >= buffer) {
        yield flush(acc);
        count = 0;
      }
    }
    if (acc.length > 0) yield flush(acc);
    return;
  }

  // txt
  yield txtHeader(ctx, expectedCount);
  const acc: string[] = [];
  let count = 0;
  for (const m of messages) {
    acc.push(txtMessage(ctx, m));
    count += 1;
    if (count >= buffer) {
      yield flush(acc);
      count = 0;
    }
  }
  if (acc.length > 0) yield flush(acc);
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
