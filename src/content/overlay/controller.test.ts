/**
 * Tests du contrôleur d'overlay — fonctions pures uniquement.
 *
 * Le `VespryController` complet dépend de chrome.runtime, IndexedDB et de
 * la session Discord ; on évite de le piloter en test direct (le moteur
 * d'export est déjà couvert par `export-runner.test.ts`). Ici on cible
 * la logique extraite en fonctions pures — actuellement `collectDmThreads`.
 */
import { describe, expect, it, vi } from 'vitest';
import { collectDmThreads, type DmThreadProbe } from './controller';
import type { RawChannel, RawMessage } from '../../engine/types';

/** Crée un message minimal avec un thread optionnel. */
function makeMessage(id: string, thread?: RawChannel): RawMessage {
  return {
    id,
    type: 0,
    channel_id: 'dm-1',
    author: { id: 'u1', username: 'sam' },
    content: `m${id}`,
    timestamp: '2026-05-01T00:00:00.000Z',
    attachments: [],
    embeds: [],
    ...(thread ? { thread } : {}),
  };
}

/** Fabrique un thread RawChannel (type 11 = public thread, type 12 = private). */
function makeThread(id: string, name: string, parentId = 'dm-1'): RawChannel {
  return { id, type: 11, name, parent_id: parentId };
}

/** Mock minimal d'API Discord — retourne les messages prédéfinis par salon. */
function fakeApi(byChannel: Record<string, RawMessage[]>): DmThreadProbe {
  return {
    getMessages: vi.fn(async (channelId: string) => byChannel[channelId] ?? []),
  };
}

describe('collectDmThreads', () => {
  it('un DM avec 5 messages dont 2 portent un thread → 3 salons (DM + 2 threads)', async () => {
    // Cas spec : la sélection d'origine = un seul DM. Sur ses 5 derniers
    // messages, deux ont ouvert un thread. La méthode doit renvoyer
    // [DM, thread1, thread2] — soit 3 « salons » exportables.
    const dm: RawChannel = { id: 'dm-1', type: 1, name: 'sam <> alice' };
    const t1 = makeThread('th-1', 'idée projet');
    const t2 = makeThread('th-2', 'liens utiles');
    const api = fakeApi({
      'dm-1': [
        makeMessage('5', t1),
        makeMessage('4'),
        makeMessage('3', t2),
        makeMessage('2'),
        makeMessage('1'),
      ],
    });

    const expanded = await collectDmThreads(api, [dm]);

    expect(expanded).toHaveLength(3);
    expect(expanded[0]).toBe(dm);
    const ids = expanded.slice(1).map((c) => c.id).sort();
    expect(ids).toEqual(['th-1', 'th-2']);
  });

  it('déduplique les threads par id (deux messages pointant le même thread)', async () => {
    const dm: RawChannel = { id: 'dm-1', type: 1, name: 'sam <> alice' };
    const shared = makeThread('th-shared', 'fil partagé');
    const api = fakeApi({
      'dm-1': [
        makeMessage('3', shared),
        makeMessage('2'),
        makeMessage('1', shared),
      ],
    });

    const expanded = await collectDmThreads(api, [dm]);

    // Un seul thread malgré deux références — la Map dédoublonne par id.
    expect(expanded).toHaveLength(2);
    expect(expanded[1]?.id).toBe('th-shared');
  });

  it('couvre les DM (type 1) et les group DM (type 3)', async () => {
    const dm: RawChannel = { id: 'dm-1', type: 1, name: 'alice' };
    const groupDm: RawChannel = { id: 'gdm-1', type: 3, name: 'amis' };
    const t1 = makeThread('th-1', 'idée', 'dm-1');
    const t2 = makeThread('th-2', 'plan', 'gdm-1');
    const api = fakeApi({
      'dm-1': [makeMessage('1', t1)],
      'gdm-1': [makeMessage('1', t2)],
    });

    const expanded = await collectDmThreads(api, [dm, groupDm]);

    const ids = expanded.map((c) => c.id);
    expect(ids).toContain('th-1');
    expect(ids).toContain('th-2');
    expect(expanded).toHaveLength(4);
  });

  it('saute les salons non-DM (guild text) — on ne fetch pas inutilement', async () => {
    const guildText: RawChannel = { id: 'g-1', type: 0, name: 'général' };
    const getMessages = vi.fn(async () => []);
    const api: DmThreadProbe = { getMessages };

    const expanded = await collectDmThreads(api, [guildText]);

    expect(expanded).toEqual([guildText]);
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('tolère un DM qui throw (révoqué / vidé) — pas de propagation', async () => {
    const dm: RawChannel = { id: 'dm-bad', type: 1, name: 'inaccessible' };
    const api: DmThreadProbe = {
      getMessages: vi.fn(async () => { throw new Error('403 forbidden'); }),
    };

    // Ne lève pas — le DM cassé est ignoré, la liste retourne le salon seul.
    const expanded = await collectDmThreads(api, [dm]);
    expect(expanded).toEqual([dm]);
  });

  it('aucun thread → retourne la liste d\'origine inchangée', async () => {
    const dm: RawChannel = { id: 'dm-1', type: 1, name: 'sam <> alice' };
    const api = fakeApi({
      'dm-1': [makeMessage('1'), makeMessage('2')],
    });

    const expanded = await collectDmThreads(api, [dm]);

    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toBe(dm);
  });
});
