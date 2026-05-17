import { beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from './checkpoint-store';
import { ExportRunner, planGuildExport } from './export-runner';
import type { DiscordApi } from './discord-api';
import {
  ChannelType,
  DiscordApiError,
  type RawChannel,
  type RawMessage,
} from './types';
import { ALL_MEDIA, type ExportOptions } from './checkpoint-types';

const OPTS: ExportOptions = { includeThreads: false, media: ALL_MEDIA };

function fakeMessage(id: string, withImage = false): RawMessage {
  return {
    id,
    type: 0,
    channel_id: 'c1',
    author: { id: 'u1', username: 'sam' },
    content: `m${id}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    attachments: withImage
      ? [{ id: `att${id}`, filename: 'p.png', size: 1, url: `https://cdn/${id}.png`, proxy_url: '' }]
      : [],
    embeds: [],
  };
}

function batch(start: number, count: number): RawMessage[] {
  return Array.from({ length: count }, (_, i) => fakeMessage(String(start + i)));
}

const channel: RawChannel = { id: 'c1', type: 0, name: 'général' };

/** Faux DiscordApi : sert des lots prédéfinis. */
function fakeApi(batches: RawMessage[][]): DiscordApi {
  let call = 0;
  return {
    getMessages: async (): Promise<RawMessage[]> => batches[call++] ?? [],
    downloadAsset: async (): Promise<Blob> => new Blob(['img']),
  } as unknown as DiscordApi;
}

let store: CheckpointStore;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  store = new CheckpointStore(`runner-test-${counter}`);
  await store.init();
});

describe('ExportRunner', () => {
  it('pagine et persiste tous les messages', async () => {
    const runId = await planGuildExport(store, { id: 'g1', name: 'G' }, [channel], OPTS);
    const runner = new ExportRunner(fakeApi([batch(1, 100), batch(101, 30)]), store);

    const status = await runner.run(runId);

    expect(status).toBe('completed');
    expect(await store.countMessages(runId, 'c1')).toBe(130);
    const ch = await store.getChannel(runId, 'c1');
    expect(ch?.status).toBe('done');
    expect(ch?.cursor).toBe('130'); // id du plus ancien message du dernier lot
  });

  it('reprend un salon depuis son curseur', async () => {
    const runId = await planGuildExport(store, { id: 'g1', name: 'G' }, [channel], OPTS);
    // Le salon a déjà 100 messages et un curseur — un seul lot reste.
    await store.patchChannel(runId, 'c1', { cursor: '100', messageCount: 100, status: 'in_progress' });
    const runner = new ExportRunner(fakeApi([batch(101, 20)]), store);

    await runner.run(runId);

    expect(await store.countMessages(runId, 'c1')).toBe(20);
    expect((await store.getChannel(runId, 'c1'))?.messageCount).toBe(120);
  });

  it('met le run en pause sur une erreur d\'authentification', async () => {
    const runId = await planGuildExport(store, { id: 'g1', name: 'G' }, [channel], OPTS);
    const api = {
      getMessages: async (): Promise<RawMessage[]> => {
        throw new DiscordApiError('auth', 401, 'expirée');
      },
      downloadAsset: async (): Promise<Blob | null> => null,
    } as unknown as DiscordApi;

    const status = await new ExportRunner(api, store).run(runId);

    expect(status).toBe('paused');
    expect((await store.getRun(runId))?.status).toBe('paused');
  });

  it('marque un salon partial sur accès refusé et finit en partial', async () => {
    const runId = await planGuildExport(store, { id: 'g1', name: 'G' }, [channel], OPTS);
    const api = {
      getMessages: async (): Promise<RawMessage[]> => {
        throw new DiscordApiError('forbidden', 403, 'refusé');
      },
      downloadAsset: async (): Promise<Blob | null> => null,
    } as unknown as DiscordApi;

    const status = await new ExportRunner(api, store).run(runId);

    expect(status).toBe('partial');
    expect((await store.getChannel(runId, 'c1'))?.status).toBe('partial');
  });

  it('télécharge les images au fil de l\'eau', async () => {
    const runId = await planGuildExport(store, { id: 'g1', name: 'G' }, [channel], OPTS);
    const runner = new ExportRunner(fakeApi([[fakeMessage('1', true)]]), store);

    await runner.run(runId);

    const assets = await store.getAssets(runId);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.status).toBe('done');
    expect(assets[0]?.blob).toBeInstanceOf(Blob);
  });

  it('saute un forum sans appeler getMessages (conteneur de posts)', async () => {
    const forum: RawChannel = { id: 'f1', type: ChannelType.GUILD_FORUM, name: 'forum' };
    const runId = await planGuildExport(store, { id: 'g1', name: 'G' }, [forum], OPTS);
    let called = false;
    const api = {
      getMessages: async (): Promise<RawMessage[]> => {
        called = true;
        return [];
      },
      downloadAsset: async (): Promise<Blob | null> => null,
    } as unknown as DiscordApi;

    const status = await new ExportRunner(api, store).run(runId);

    expect(status).toBe('completed');
    expect(called).toBe(false); // un forum n'a pas de messages propres
    expect((await store.getChannel(runId, 'f1'))?.status).toBe('done');
  });

  it('enrichit les réactions avec les utilisateurs si l\'option est activée', async () => {
    const reacted: RawMessage = {
      ...fakeMessage('1'),
      reactions: [{ count: 2, emoji: { id: null, name: '👍' } }],
    };
    let batchCall = 0;
    const api = {
      getMessages: async (): Promise<RawMessage[]> => (batchCall++ === 0 ? [reacted] : []),
      downloadAsset: async (): Promise<Blob | null> => null,
      getReactions: async (): Promise<{ id: string; username: string }[]> => [
        { id: 'u1', username: 'a' },
        { id: 'u2', username: 'b' },
      ],
    } as unknown as DiscordApi;

    const runId = await planGuildExport(
      store,
      { id: 'g1', name: 'G' },
      [channel],
      { ...OPTS, includeReactionUsers: true },
    );
    await new ExportRunner(api, store).run(runId);

    const msgs: RawMessage[] = [];
    await store.forEachMessage(runId, 'c1', (sm) => msgs.push(sm.message));
    expect(msgs[0]?.reactions?.[0]?.users).toHaveLength(2);
  });
});
