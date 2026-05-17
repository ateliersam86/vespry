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
});
