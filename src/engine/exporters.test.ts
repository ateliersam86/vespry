import { describe, expect, it } from 'vitest';
import { toCsv, toHtml, toTxt, type ExportContext } from './exporters';
import type { RawMessage } from './types';

const ctx: ExportContext = {
  guildName: 'Groupe avec Sora',
  channelName: 'questions-sam',
  urlToPath: new Map([['https://cdn/x.png', 'media/questions-sam/x.png']]),
};

function msg(over: Partial<RawMessage> = {}): RawMessage {
  return {
    id: '1',
    type: 0,
    channel_id: 'c1',
    author: { id: 'u1', username: 'sam', global_name: 'Sam' },
    content: 'bonjour',
    timestamp: '2026-01-02T09:30:00.000Z',
    attachments: [],
    embeds: [],
    ...over,
  };
}

describe('toTxt', () => {
  it('inclut en-tête, auteur, date et contenu', () => {
    const out = toTxt(ctx, [msg()]);
    expect(out).toContain('Groupe avec Sora — #questions-sam');
    expect(out).toContain('1 message(s)');
    expect(out).toContain('Sam');
    expect(out).toContain('bonjour');
  });

  it('liste les pièces jointes et les réactions', () => {
    const out = toTxt(ctx, [msg({
      attachments: [{ id: 'a', filename: 'photo.png', size: 1, url: 'https://cdn/x.png', proxy_url: '' }],
      reactions: [{ count: 3, emoji: { id: null, name: '👍' } }],
    })]);
    expect(out).toContain('photo.png');
    expect(out).toContain('média'.length > 0 ? 'media/questions-sam/x.png' : '');
    expect(out).toContain('👍 ×3');
  });

  it('humanise les balises Discord brutes', () => {
    expect(toTxt(ctx, [msg({ content: 'salut <@123> !' })])).toContain('@membre');
  });
});

describe('toCsv', () => {
  it('produit un en-tête et une ligne par message', () => {
    const out = toCsv(ctx, [msg(), msg({ id: '2' })]);
    const lines = out.trimEnd().split('\r\n');
    expect(lines[0]).toBe('AuthorID,Author,Date,Content,Attachments,Reactions');
    expect(lines).toHaveLength(3);
  });

  it('échappe les virgules, guillemets et sauts de ligne', () => {
    const out = toCsv(ctx, [msg({ content: 'a,b "c"\nd' })]);
    // le contenu doit être entre guillemets, les " internes doublés
    expect(out).toContain('"a,b ""c""\nd"');
  });

  it('liste les pièces jointes via leur chemin local', () => {
    const out = toCsv(ctx, [msg({
      attachments: [{ id: 'a', filename: 'x.png', size: 1, url: 'https://cdn/x.png', proxy_url: '' }],
    })]);
    expect(out).toContain('media/questions-sam/x.png');
  });
});

describe('toHtml', () => {
  it('produit un document HTML complet', () => {
    const out = toHtml(ctx, [msg()]);
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('#questions-sam');
    expect(out).toContain('bonjour');
  });

  it('échappe le HTML du contenu (anti-injection)', () => {
    const out = toHtml(ctx, [msg({ content: '<script>alert(1)</script>' })]);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('rend le markdown gras et le code', () => {
    const out = toHtml(ctx, [msg({ content: '**fort** et `code`' })]);
    expect(out).toContain('<strong>fort</strong>');
    expect(out).toContain('<code>code</code>');
  });

  it('rend une image attachée vers son chemin local', () => {
    const out = toHtml(ctx, [msg({
      attachments: [{
        id: 'a', filename: 'x.png', size: 1,
        url: 'https://cdn/x.png', proxy_url: '', content_type: 'image/png',
      }],
    })]);
    expect(out).toContain('../media/questions-sam/x.png');
    expect(out).toContain('<img');
  });

  it('groupe les messages consécutifs du même auteur', () => {
    const out = toHtml(ctx, [
      msg({ id: '1', timestamp: '2026-01-02T09:30:00.000Z' }),
      msg({ id: '2', timestamp: '2026-01-02T09:31:00.000Z' }),
    ]);
    expect(out).toContain('msg grouped');
  });
});
