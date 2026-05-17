import { beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from './checkpoint-store';
import { packageRun } from './packager';
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

  it('lève une erreur si le run est introuvable', async () => {
    await expect(packageRun(store, 'inexistant')).rejects.toThrow();
  });
});
