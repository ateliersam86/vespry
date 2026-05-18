import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordApi } from './discord-api';
import { DiscordApiError } from './types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const api = (): DiscordApi => new DiscordApi({ token: 'tok', requestDelayMs: 0 });

describe('DiscordApi', () => {
  it('getGuilds renvoie la liste des serveurs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{ id: '1', name: 'G' }])));
    const guilds = await api().getGuilds();
    expect(guilds).toEqual([{ id: '1', name: 'G' }]);
  });

  it('réessaie après un 429 puis réussit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ retry_after: 0 }, 429))
      .mockResolvedValueOnce(jsonResponse([{ id: '1', name: 'G' }]));
    vi.stubGlobal('fetch', fetchMock);

    const guilds = await api().getGuilds();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(guilds).toHaveLength(1);
  });

  it('lève une erreur typée auth sur 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'no' }, 401)));
    await expect(api().getCurrentUser()).rejects.toMatchObject({
      name: 'DiscordApiError',
      kind: 'auth',
    });
  });

  it('lève une erreur typée forbidden sur 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 403)));
    await expect(api().getGuildChannels('g1')).rejects.toBeInstanceOf(DiscordApiError);
  });

  it('getMessages construit le curseur before', async () => {
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(jsonResponse([])));
    vi.stubGlobal('fetch', fetchMock);
    await api().getMessages('c1', '12345');
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('/channels/c1/messages?limit=100&before=12345');
  });

  it('downloadAsset renvoie null sur échec réseau', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    expect(await api().downloadAsset('https://cdn/x.png')).toBeNull();
  });

  // ─────────────────────────── deleteMessage ───────────────────────────
  // Phase 2 — fonctionnalité de purge. La méthode doit :
  // 1. émettre un DELETE sur le bon endpoint ;
  // 2. accepter un 204 No Content sans tenter de parser un corps vide ;
  // 3. traiter un 404 comme un succès idempotent (message déjà supprimé) ;
  // 4. lever DiscordApiError('forbidden') sur 403 ;
  // 5. réutiliser le back-off 429 partagé avec GET.

  it('deleteMessage envoie un DELETE sur le bon endpoint et accepte 204', async () => {
    // Typage explicite des args : sans ça `mock.calls[0]` est typé `[]`
    // (tuple vide) et l'indexation génère une erreur TS2493 sous
    // `noUncheckedIndexedAccess` strict.
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api().deleteMessage('c1', 'm1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toContain('/channels/c1/messages/m1');
    expect(call?.[1]?.method).toBe('DELETE');
  });

  it('deleteMessage est idempotent sur 404 (message déjà supprimé)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Unknown Message' }, 404)));
    // Ne lève pas — l'effet désiré est atteint.
    await expect(api().deleteMessage('c1', 'm1')).resolves.toBeUndefined();
  });

  it('deleteMessage lève DiscordApiError(forbidden) sur 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Missing Permissions' }, 403)));
    await expect(api().deleteMessage('c1', 'm1')).rejects.toMatchObject({
      name: 'DiscordApiError',
      kind: 'forbidden',
      status: 403,
    });
  });

  it('deleteMessage lève DiscordApiError(auth) sur 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: '401: Unauthorized' }, 401)));
    await expect(api().deleteMessage('c1', 'm1')).rejects.toMatchObject({
      name: 'DiscordApiError',
      kind: 'auth',
    });
  });

  it('deleteMessage réutilise le back-off 429 (retry puis succès)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ retry_after: 0 }, 429))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await api().deleteMessage('c1', 'm1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Les deux appels doivent être des DELETE sur la même URL.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('/channels/c1/messages/m1');
      expect((call[1] as RequestInit | undefined)?.method).toBe('DELETE');
    }
  });

  it('deleteMessage propage les erreurs HTTP inattendues', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Server Error' }, 500)));
    await expect(api().deleteMessage('c1', 'm1')).rejects.toMatchObject({
      name: 'DiscordApiError',
      kind: 'unknown',
      status: 500,
    });
  });
});
