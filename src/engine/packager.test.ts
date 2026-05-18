import { beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from './checkpoint-store';
import { packageRun } from './packager';
import { profileForTier } from './perf-profile';
import { ALL_MEDIA } from './checkpoint-types';
import type { ChannelProgress, ExportRun, StoredAsset, StoredMessage } from './checkpoint-types';
import type { RawMessage } from './types';

function run(id: string): ExportRun {
  return {
    id,
    guildId: 'g1',
    guildName: 'Groupe Test',
    status: 'completed',
    options: {
      includeThreads: false,
      media: ALL_MEDIA,
      zones: [],
      zoneMode: 'any',
      formats: ['json', 'html', 'csv', 'txt'],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function channel(runId: string, id: string, name: string): ChannelProgress {
  return {
    runId, channelId: id, name, category: null, type: 0,
    status: 'done', cursor: null, messageCount: 0,
  };
}

function message(runId: string, channelId: string, id: string): StoredMessage {
  const m: RawMessage = {
    id, type: 0, channel_id: channelId,
    author: { id: 'u1', username: 'sam' },
    content: `msg ${id}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    attachments: [], embeds: [],
  };
  return { runId, channelId, messageId: id, message: m };
}

let store: CheckpointStore;
let n = 0;

beforeEach(async () => {
  n += 1;
  store = new CheckpointStore(`pkg-test-${n}`);
  await store.init();
});

describe('packageRun', () => {
  it('produit un zip non vide et un manifeste correct', async () => {
    await store.putRun(run('r1'));
    await store.putChannel(channel('r1', 'c1', 'général'));
    await store.appendMessages([
      message('r1', 'c1', '1'),
      message('r1', 'c1', '2'),
    ]);

    const { blob, manifest } = await packageRun(store, 'r1');

    expect(blob.size).toBeGreaterThan(0);
    const m = manifest as { totals: { messages: number; channels: number } };
    expect(m.totals.messages).toBe(2);
    expect(m.totals.channels).toBe(1);
  });

  it('compte les médias téléchargés dans le manifeste', async () => {
    await store.putRun(run('r2'));
    await store.putChannel(channel('r2', 'c1', 'général'));
    await store.appendMessages([message('r2', 'c1', '1')]);
    const asset: StoredAsset = {
      runId: 'r2', assetId: 'a1', channelId: 'c1',
      url: 'https://cdn/x.png', kind: 'image', filename: 'x.png',
      status: 'done', blob: new Blob(['img-bytes']),
    };
    await store.putAsset(asset);

    const { manifest } = await packageRun(store, 'r2');
    const m = manifest as { totals: { assetsDownloaded: number } };
    expect(m.totals.assetsDownloaded).toBe(1);
  });

  it('découpe un gros salon en partitions', async () => {
    const r = run('r3');
    r.options.partitionSize = 2;
    r.options.formats = ['json'];
    await store.putRun(r);
    await store.putChannel(channel('r3', 'c1', 'general'));
    await store.appendMessages([
      message('r3', 'c1', '1'), message('r3', 'c1', '2'),
      message('r3', 'c1', '3'), message('r3', 'c1', '4'),
      message('r3', 'c1', '5'),
    ]);

    const { manifest } = await packageRun(store, 'r3');
    const m = manifest as { channels: { files: string[]; messages: number }[] };
    // 5 messages / 2 → 3 partitions, un fichier JSON chacune.
    expect(m.channels[0]?.files).toHaveLength(3);
    expect(m.channels[0]?.files.some((f) => /\.part1\.json$/.test(f))).toBe(true);
    expect(m.channels[0]?.files.some((f) => /\.part3\.json$/.test(f))).toBe(true);
    expect(m.channels[0]?.messages).toBe(5);
  });

  it('lève une erreur si le run est introuvable', async () => {
    await expect(packageRun(store, 'inexistant')).rejects.toThrow();
  });

  it('préserve les champs Discord inconnus dans le JSON (forward-compat)', async () => {
    await store.putRun(run('rfc'));
    await store.putChannel(channel('rfc', 'c1', 'general'));
    // simule un message contenant un champ Discord futur que Vespry ne type pas.
    const enriched = message('rfc', 'c1', '1');
    (enriched.message as unknown as Record<string, unknown>)['future_discord_field']
      = { kind: 'voice_note_v2', secret: 42 };
    await store.appendMessages([enriched]);

    const { blob } = await packageRun(store, 'rfc');
    const buf = await blob.arrayBuffer();
    // le contenu du zip est binaire, mais la chaîne du JSON apparaît telle quelle
    // dans le flux non compressé (nos JSON sont sans STORED compression).
    const ascii = new TextDecoder().decode(new Uint8Array(buf));
    expect(ascii).toContain('future_discord_field');
    expect(ascii).toContain('voice_note_v2');
  });

  it('mode bulk (fast) — comportement historique préservé', async () => {
    await store.putRun(run('rfast'));
    await store.putChannel(channel('rfast', 'c1', 'général'));
    await store.appendMessages([
      message('rfast', 'c1', '1'),
      message('rfast', 'c1', '2'),
    ]);

    const { blob, manifest } = await packageRun(store, 'rfast', {
      profile: profileForTier('fast'),
    });
    expect(blob.size).toBeGreaterThan(0);
    const m = manifest as { totals: { messages: number } };
    expect(m.totals.messages).toBe(2);

    // En mode bulk le JSON contient bien le tableau `messages` au sens classique.
    const ascii = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
    expect(ascii).toContain('"messages"');
    expect(ascii).toContain('"msg 1"');
  });

  it('mode streaming (low) — exporte 1 000 messages sans tout charger', async () => {
    // Profil `low` : `bufferMessagesPerPage = 0` ; le packager clampe à un
    // plancher interne pour ne pas saturer le pipeline conflux. On vérifie
    // que le chemin streaming traite un salon dont les messages dépassent
    // largement la taille d'un fichier d'export courant, et que le JSON
    // produit est intègre. 1 000 messages × 4 formats reste rapide en
    // fake-indexeddb (Chromium natif est ordre de grandeur plus rapide).
    const N = 1_000;
    await store.putRun(run('rbig'));
    await store.putChannel(channel('rbig', 'c1', 'général'));
    for (let i = 0; i < N; i += 500) {
      const batch: StoredMessage[] = [];
      for (let j = 0; j < 500 && i + j < N; j += 1) {
        const id = String(i + j + 1).padStart(7, '0');
        batch.push(message('rbig', 'c1', id));
      }
      await store.appendMessages(batch);
    }

    const { blob, manifest } = await packageRun(store, 'rbig', {
      profile: profileForTier('low'),
    });
    expect(blob.size).toBeGreaterThan(0);
    const m = manifest as { totals: { messages: number } };
    expect(m.totals.messages).toBe(N);

    // Le JSON streamé contient bien le compteur et les bornes du salon.
    const ascii = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
    expect(ascii).toContain(`"messageCount": ${N}`);
    expect(ascii).toContain('"msg 0000001"');
    expect(ascii).toContain(`"msg ${String(N).padStart(7, '0')}"`);
  }, 60_000);

  it('mode streaming respecte le partitionnement utilisateur', async () => {
    const r = run('rstreampart');
    r.options.partitionSize = 2;
    r.options.formats = ['json'];
    await store.putRun(r);
    await store.putChannel(channel('rstreampart', 'c1', 'general'));
    await store.appendMessages([
      message('rstreampart', 'c1', '1'),
      message('rstreampart', 'c1', '2'),
      message('rstreampart', 'c1', '3'),
      message('rstreampart', 'c1', '4'),
      message('rstreampart', 'c1', '5'),
    ]);

    const { manifest } = await packageRun(store, 'rstreampart', {
      profile: profileForTier('low'),
    });
    const m = manifest as { channels: { files: string[]; messages: number }[] };
    expect(m.channels[0]?.files).toHaveLength(3);
    expect(m.channels[0]?.files.some((f) => /\.part1\.json$/.test(f))).toBe(true);
    expect(m.channels[0]?.files.some((f) => /\.part3\.json$/.test(f))).toBe(true);
    expect(m.channels[0]?.messages).toBe(5);
  });

  it('chiffrement AES — zipPassword renseigné produit un zip déchiffrable', async () => {
    const { BlobReader, ZipReader } = await import('@zip.js/zip.js');

    const r = run('renc');
    r.options.zipPassword = 'correct-horse-battery-staple';
    r.options.formats = ['json'];
    await store.putRun(r);
    await store.putChannel(channel('renc', 'c1', 'general'));
    await store.appendMessages([
      message('renc', 'c1', '1'),
      message('renc', 'c1', '2'),
    ]);

    const { blob, manifest } = await packageRun(store, 'renc');

    // Le manifest reflète bien le drapeau encrypted, SANS exposer le mdp.
    const m = manifest as { encrypted: boolean; options: Record<string, unknown> };
    expect(m.encrypted).toBe(true);
    expect(m.options['zipPassword']).toBeUndefined();

    // Le zip extérieur (wrapper AES) est lisible sans mot de passe — il
    // contient UNE entrée unique chiffrée. La lecture du contenu de cette
    // entrée exige le bon mot de passe.
    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();
    expect(entries).toHaveLength(1);
    const inner = entries[0];
    expect(inner?.encrypted).toBe(true);
    await reader.close();

    // Mauvais mot de passe → la lecture échoue. On accède via `getData` qui
    // est défini sur les entrées fichier (pas répertoire) — le wrapper
    // n'ajoute qu'une entrée fichier, donc cette voie est sûre.
    const wrongReader = new ZipReader(new BlobReader(blob), { password: 'wrong' });
    const wrongEntries = await wrongReader.getEntries();
    const wrongInner = wrongEntries[0];
    const { BlobWriter } = await import('@zip.js/zip.js');
    await expect(async () => {
      const getData = (wrongInner as { getData?: (w: unknown) => Promise<unknown> }).getData;
      if (!getData) throw new Error('entry has no getData (DirectoryEntry?)');
      await getData(new BlobWriter());
    }).rejects.toBeDefined();
    await wrongReader.close();
  });

  it('chiffrement AES — pas de mdp → comportement non chiffré', async () => {
    await store.putRun(run('rclear'));
    await store.putChannel(channel('rclear', 'c1', 'general'));
    await store.appendMessages([message('rclear', 'c1', '1')]);

    const { blob, manifest } = await packageRun(store, 'rclear');
    const m = manifest as { encrypted: boolean };
    expect(m.encrypted).toBe(false);
    // Le contenu du zip non chiffré est lisible directement — un message
    // apparaît tel quel dans le flux (STORED = pas de compression sur JSON).
    const ascii = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
    expect(ascii).toContain('"msg 1"');
  });
});
