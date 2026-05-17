import { beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from './checkpoint-store';
import { ALL_MEDIA } from './checkpoint-types';
import type {
  ChannelProgress,
  ExportRun,
  StoredAsset,
  StoredMessage,
} from './checkpoint-types';
import type { RawMessage } from './types';

function makeRun(id: string, status: ExportRun['status'] = 'in_progress'): ExportRun {
  return {
    id,
    guildId: 'g1',
    guildName: 'Test',
    status,
    options: {
      includeThreads: false, media: ALL_MEDIA, zones: [],
      zoneMode: 'any', formats: ['json'],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeChannel(runId: string, channelId: string): ChannelProgress {
  return {
    runId,
    channelId,
    name: `chan-${channelId}`,
    category: null,
    type: 0,
    status: 'pending',
    cursor: null,
    messageCount: 0,
  };
}

function makeMessage(runId: string, channelId: string, id: string): StoredMessage {
  const message: RawMessage = {
    id,
    type: 0,
    channel_id: channelId,
    author: { id: 'u1', username: 'sam' },
    content: `msg ${id}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    attachments: [],
    embeds: [],
  };
  return { runId, channelId, messageId: id, message };
}

let store: CheckpointStore;
let dbCounter = 0;

beforeEach(async () => {
  // Une DB neuve par test pour l'isolation.
  dbCounter += 1;
  store = new CheckpointStore(`vespry-test-${dbCounter}`);
  await store.init();
});

describe('CheckpointStore — runs', () => {
  it('persiste et relit un run', async () => {
    await store.putRun(makeRun('r1'));
    const got = await store.getRun('r1');
    expect(got?.guildName).toBe('Test');
  });

  it('patchRun met à jour le statut', async () => {
    await store.putRun(makeRun('r1'));
    await store.patchRun('r1', { status: 'completed' });
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });

  it('getResumableRun renvoie le run in_progress le plus récent', async () => {
    await store.putRun(makeRun('r1', 'completed'));
    await store.putRun(makeRun('r2', 'paused'));
    const resumable = await store.getResumableRun();
    expect(resumable?.id).toBe('r2');
  });

  it('getResumableRun renvoie undefined si rien à reprendre', async () => {
    await store.putRun(makeRun('r1', 'completed'));
    expect(await store.getResumableRun()).toBeUndefined();
  });
});

describe('CheckpointStore — channels & messages', () => {
  it('écrit un lot de messages et les compte', async () => {
    await store.putChannel(makeChannel('r1', 'c1'));
    await store.appendMessages([
      makeMessage('r1', 'c1', '100'),
      makeMessage('r1', 'c1', '101'),
    ]);
    expect(await store.countMessages('r1', 'c1')).toBe(2);
  });

  it('forEachMessage parcourt dans l\'ordre des ids', async () => {
    await store.appendMessages([
      makeMessage('r1', 'c1', '300'),
      makeMessage('r1', 'c1', '100'),
      makeMessage('r1', 'c1', '200'),
    ]);
    const seen: string[] = [];
    await store.forEachMessage('r1', 'c1', (m) => seen.push(m.messageId));
    expect(seen).toEqual(['100', '200', '300']);
  });

  it('isole les messages par salon', async () => {
    await store.appendMessages([
      makeMessage('r1', 'c1', '1'),
      makeMessage('r1', 'c2', '2'),
    ]);
    expect(await store.countMessages('r1', 'c1')).toBe(1);
    expect(await store.countMessages('r1', 'c2')).toBe(1);
  });

  it('patchChannel met à jour le curseur', async () => {
    await store.putChannel(makeChannel('r1', 'c1'));
    await store.patchChannel('r1', 'c1', { cursor: '999', messageCount: 5 });
    const ch = await store.getChannel('r1', 'c1');
    expect(ch?.cursor).toBe('999');
    expect(ch?.messageCount).toBe(5);
  });
});

describe('CheckpointStore — assets & cleanup', () => {
  it('liste les assets en attente', async () => {
    const a: StoredAsset = {
      runId: 'r1',
      assetId: 'a1',
      channelId: 'c1',
      url: 'https://x',
      kind: 'image',
      filename: 'x.png',
      status: 'pending',
    };
    await store.putAsset(a);
    await store.putAsset({ ...a, assetId: 'a2', status: 'done' });
    expect(await store.getPendingAssets('r1')).toHaveLength(1);
  });

  it('deleteRun supprime run, salons, messages et assets', async () => {
    await store.putRun(makeRun('r1'));
    await store.putChannel(makeChannel('r1', 'c1'));
    await store.appendMessages([makeMessage('r1', 'c1', '1')]);
    await store.putAsset({
      runId: 'r1',
      assetId: 'a1',
      channelId: 'c1',
      url: 'u',
      kind: 'image',
      filename: 'f',
      status: 'done',
    });
    await store.deleteRun('r1');
    expect(await store.getRun('r1')).toBeUndefined();
    expect(await store.getChannels('r1')).toHaveLength(0);
    expect(await store.countMessages('r1', 'c1')).toBe(0);
    expect(await store.getAssets('r1')).toHaveLength(0);
  });
});
