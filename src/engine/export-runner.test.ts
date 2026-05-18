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
import {
  ALL_MEDIA,
  messageMatchesZones,
  type ExportOptions,
  type SelectionZone,
} from './checkpoint-types';

const OPTS: ExportOptions = {
  includeThreads: false, media: ALL_MEDIA, zones: [],
  zoneMode: 'any', formats: ['json'],
};

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

/** Faux DiscordApi : lots prédéfinis par salon + trace des salons appelés. */
function perChannelApi(
  byChannel: Record<string, RawMessage[][]>,
): { api: DiscordApi; calls: string[] } {
  const idx: Record<string, number> = {};
  const calls: string[] = [];
  const api = {
    getMessages: async (channelId: string): Promise<RawMessage[]> => {
      calls.push(channelId);
      const i = idx[channelId] ?? 0;
      idx[channelId] = i + 1;
      return byChannel[channelId]?.[i] ?? [];
    },
    downloadAsset: async (): Promise<Blob | null> => null,
  } as unknown as DiscordApi;
  return { api, calls };
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

  it('reprend un run multi-salons interrompu et le termine', async () => {
    // Scénario réel : le navigateur a été tué en plein export. À la
    // relance, une instance NEUVE du runner repart du même IndexedDB.
    const c1: RawChannel = { id: 'c1', type: 0, name: 'fini' };
    const c2: RawChannel = { id: 'c2', type: 0, name: 'interrompu' };
    const c3: RawChannel = { id: 'c3', type: 0, name: 'pas-commence' };
    const runId = await planGuildExport(
      store,
      { id: 'g1', name: 'G' },
      [c1, c2, c3],
      OPTS,
    );

    // État laissé par l'interruption : c1 terminé, c2 à moitié (curseur
    // posé), c3 jamais touché.
    await store.patchChannel(runId, 'c1', {
      status: 'done', cursor: '50', messageCount: 50,
    });
    await store.patchChannel(runId, 'c2', {
      status: 'in_progress', cursor: '200', messageCount: 100,
    });

    // Instance neuve (= après redémarrage), même store.
    const { api, calls } = perChannelApi({
      c2: [batch(201, 15), []],
      c3: [batch(1, 30), []],
    });
    const status = await new ExportRunner(api, store).run(runId);

    expect(status).toBe('completed');
    // le salon déjà terminé n'est jamais re-téléchargé
    expect(calls).not.toContain('c1');
    // le salon interrompu reprend à son curseur : 100 déjà là + 15 restants
    expect((await store.getChannel(runId, 'c2'))?.messageCount).toBe(115);
    expect((await store.getChannel(runId, 'c2'))?.status).toBe('done');
    // le salon jamais commencé est traité entièrement
    expect(await store.countMessages(runId, 'c3')).toBe(30);
    expect((await store.getChannel(runId, 'c3'))?.status).toBe('done');
    // le run entier finit terminé
    expect((await store.getRun(runId))?.status).toBe('completed');
  });

  it('export incrémental — n\'exporte que les messages après sinceMs', async () => {
    const dated = (id: string, iso: string): RawMessage => ({
      ...fakeMessage(id), timestamp: iso,
    });
    const runId = await planGuildExport(
      store,
      { id: 'g1', name: 'G' },
      [channel],
      { ...OPTS, sinceMs: Date.parse('2026-03-01T00:00:00.000Z') },
    );
    // lot trié récent → ancien ; le dernier est antérieur au plancher.
    const api = fakeApi([[
      dated('3', '2026-03-10T00:00:00.000Z'),
      dated('2', '2026-03-05T00:00:00.000Z'),
      dated('1', '2026-02-01T00:00:00.000Z'),
    ]]);

    await new ExportRunner(api, store).run(runId);

    // seuls les 2 messages postés après le plancher sont conservés.
    expect(await store.countMessages(runId, 'c1')).toBe(2);
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

  it('concurrence salons — traite N salons en parallèle quand concurrency > 1', async () => {
    // 5 salons, concurrency=2 : à un instant T au moins 2 doivent être en
    // cours simultanément. On instrumente `getMessages` pour mesurer le pic
    // d'activité (entrée incrémente un compteur, sortie le décrémente).
    const channels: RawChannel[] = [
      { id: 'c1', type: 0, name: 'a' },
      { id: 'c2', type: 0, name: 'b' },
      { id: 'c3', type: 0, name: 'c' },
      { id: 'c4', type: 0, name: 'd' },
      { id: 'c5', type: 0, name: 'e' },
    ];
    const runId = await planGuildExport(store, { id: 'g1', name: 'G' }, channels, OPTS);

    let inFlight = 0;
    let peak = 0;
    const api = {
      getMessages: async (channelId: string): Promise<RawMessage[]> => {
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        // Yield à l'event loop pour laisser un autre worker démarrer son
        // propre `getMessages` avant qu'on rende notre lot.
        await new Promise<void>((r) => setTimeout(r, 5));
        inFlight -= 1;
        // Un lot puis vide : un seul appel par salon.
        return [fakeMessage(`${channelId}-1`)];
      },
      downloadAsset: async (): Promise<Blob | null> => null,
    } as unknown as DiscordApi;

    const status = await new ExportRunner(api, store, {}, { channelConcurrency: 2 }).run(runId);

    expect(status).toBe('completed');
    expect(peak).toBeGreaterThanOrEqual(2);
    // Cap rate-limit : on n'a JAMAIS dépassé la concurrence demandée.
    expect(peak).toBeLessThanOrEqual(2);
    for (const ch of channels) {
      expect((await store.getChannel(runId, ch.id))?.status).toBe('done');
    }
  });

  it('concurrence salons — fallback séquentiel quand concurrency=1', async () => {
    const channels: RawChannel[] = [
      { id: 'c1', type: 0, name: 'a' },
      { id: 'c2', type: 0, name: 'b' },
      { id: 'c3', type: 0, name: 'c' },
    ];
    const runId = await planGuildExport(store, { id: 'g1', name: 'G' }, channels, OPTS);

    let inFlight = 0;
    let peak = 0;
    const api = {
      getMessages: async (channelId: string): Promise<RawMessage[]> => {
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        await new Promise<void>((r) => setTimeout(r, 5));
        inFlight -= 1;
        return [fakeMessage(`${channelId}-1`)];
      },
      downloadAsset: async (): Promise<Blob | null> => null,
    } as unknown as DiscordApi;

    await new ExportRunner(api, store, {}, { channelConcurrency: 1 }).run(runId);

    expect(peak).toBe(1);
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

describe('messageMatchesZones', () => {
  const base = fakeMessage('1');
  const CH = 'c1';

  it('aucune zone → tout passe', () => {
    expect(messageMatchesZones(base, [], CH)).toBe(true);
  });

  it('zone contenu (insensible à la casse)', () => {
    const m: RawMessage = { ...base, content: 'Hello World' };
    expect(messageMatchesZones(m, [{ kind: 'content', query: 'hello' }], CH)).toBe(true);
    expect(messageMatchesZones(m, [{ kind: 'content', query: 'absent' }], CH)).toBe(false);
  });

  it('zone auteur', () => {
    const m: RawMessage = { ...base, author: { id: 'u', username: 'SamMuselet' } };
    expect(messageMatchesZones(m, [{ kind: 'author', query: 'sam' }], CH)).toBe(true);
    expect(messageMatchesZones(m, [{ kind: 'author', query: 'bob' }], CH)).toBe(false);
  });

  it('zone période', () => {
    const m: RawMessage = { ...base, timestamp: '2026-03-10T00:00:00.000Z' };
    const inRange: SelectionZone = {
      kind: 'period',
      afterMs: Date.parse('2026-03-01'),
      beforeMs: Date.parse('2026-03-20'),
    };
    const outRange: SelectionZone = { kind: 'period', afterMs: Date.parse('2026-04-01') };
    expect(messageMatchesZones(m, [inRange], CH)).toBe(true);
    expect(messageMatchesZones(m, [outRange], CH)).toBe(false);
  });

  it('zone épinglés / pièce jointe / lien', () => {
    expect(messageMatchesZones({ ...base, pinned: true }, [{ kind: 'pinned' }], CH)).toBe(true);
    expect(messageMatchesZones(base, [{ kind: 'pinned' }], CH)).toBe(false);
    expect(messageMatchesZones(fakeMessage('2', true), [{ kind: 'attachment' }], CH)).toBe(true);
    expect(messageMatchesZones(
      { ...base, content: 'voir https://x.com' }, [{ kind: 'link' }], CH,
    )).toBe(true);
  });

  it('zone manuelle — limitée à son salon', () => {
    const zone: SelectionZone = { kind: 'manual', channelId: CH, ids: ['1', '9'] };
    expect(messageMatchesZones(base, [zone], CH)).toBe(true);
    expect(messageMatchesZones(fakeMessage('2'), [zone], CH)).toBe(false);
    expect(messageMatchesZones(base, [zone], 'autre-salon')).toBe(false);
  });

  it('union des zones (OU logique)', () => {
    const m: RawMessage = { ...base, content: 'rien', pinned: true };
    // ne matche pas « contenu » mais matche « épinglés » → union vraie
    expect(messageMatchesZones(
      m, [{ kind: 'content', query: 'absent' }, { kind: 'pinned' }], CH,
    )).toBe(true);
    expect(messageMatchesZones(
      m, [{ kind: 'content', query: 'absent' }, { kind: 'link' }], CH,
    )).toBe(false);
  });

  it('zones has: granulaires (image / sticker / embed)', () => {
    const withImg = fakeMessage('2', true); // pièce jointe .png
    expect(messageMatchesZones(withImg, [{ kind: 'image' }], CH)).toBe(true);
    expect(messageMatchesZones(withImg, [{ kind: 'video' }], CH)).toBe(false);
    const withSticker: RawMessage = {
      ...base, sticker_items: [{ id: 's', name: 'x', format_type: 1 }],
    };
    expect(messageMatchesZones(withSticker, [{ kind: 'sticker' }], CH)).toBe(true);
    const withEmbed: RawMessage = { ...base, embeds: [{ title: 'e' }] };
    expect(messageMatchesZones(withEmbed, [{ kind: 'embed' }], CH)).toBe(true);
  });

  it('négation d une zone (NON logique)', () => {
    const pinned: RawMessage = { ...base, pinned: true };
    expect(messageMatchesZones(pinned, [{ kind: 'pinned', negate: true }], CH))
      .toBe(false);
    expect(messageMatchesZones(base, [{ kind: 'pinned', negate: true }], CH))
      .toBe(true);
  });

  it('mode ET — toutes les zones doivent matcher', () => {
    const m: RawMessage = {
      ...base, content: 'salut', author: { id: 'u', username: 'sam' },
    };
    const zones: SelectionZone[] = [
      { kind: 'author', query: 'sam' },
      { kind: 'content', query: 'salut' },
    ];
    expect(messageMatchesZones(m, zones, CH, 'all')).toBe(true);
    // une seule échoue → faux en mode ET, vrai en mode OU
    const zones2: SelectionZone[] = [
      { kind: 'author', query: 'sam' },
      { kind: 'content', query: 'absent' },
    ];
    expect(messageMatchesZones(m, zones2, CH, 'all')).toBe(false);
    expect(messageMatchesZones(m, zones2, CH, 'any')).toBe(true);
  });

  it('une zone manuelle s ajoute toujours, même en mode ET', () => {
    const m: RawMessage = { ...base, content: 'rien' };
    const zones: SelectionZone[] = [
      { kind: 'content', query: 'absent' },
      { kind: 'manual', channelId: CH, ids: ['1'] },
    ];
    // le critère échoue, mais le message est coché → passe quand même
    expect(messageMatchesZones(m, zones, CH, 'all')).toBe(true);
  });
});
