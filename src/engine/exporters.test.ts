import { describe, expect, it } from 'vitest';
import {
  ENGLISH_LABELS, toCsv, toHtml, toTxt, type ExportContext,
} from './exporters';
import type { RawMessage } from './types';

const ctx: ExportContext = {
  guildName: 'Groupe avec Sora',
  guildId: '1467246938280952014',
  channelName: 'questions-sam',
  channel: { id: 'c1', name: 'questions-sam', type: 0 },
  urlToPath: new Map([['https://cdn/x.png', 'media/questions-sam/x.png']]),
  labels: ENGLISH_LABELS,
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
    expect(out).toContain('Groupe avec Sora · #questions-sam');
    expect(out).toContain('1 messages');
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
    expect(toTxt(ctx, [msg({ content: 'salut <@123> !' })])).toContain('@member');
  });
});

describe('toCsv', () => {
  it('produit un en-tête et une ligne par message (avec BOM UTF-8 et colonnes Channel)', () => {
    const out = toCsv(ctx, [msg(), msg({ id: '2' })]);
    // Le BOM UTF-8 (`﻿`) est obligatoire pour qu'Excel Windows
    // n'interprète pas le fichier en latin-1 (sinon accents/emojis cassés).
    expect(out.startsWith('﻿')).toBe(true);
    const lines = out.slice(1).trimEnd().split('\r\n');
    // Colonnes Channel{ID,Name,Type} ajoutées pour exploiter un CSV
    // concaténé sur plusieurs salons (BI / pivot tableur).
    expect(lines[0]).toBe(
      'ChannelID,Channel,ChannelType,AuthorID,Author,Date,Edited,Content,Attachments,Reactions',
    );
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

  it('rend les stickers', () => {
    const out = toHtml(ctx, [msg({
      sticker_items: [{ id: '999', name: 'hibou', format_type: 1 }],
    })]);
    expect(out).toContain('class="sticker"');
    expect(out).toContain('hibou');
  });

  it('rend un embed riche : champs, image, footer', () => {
    const out = toHtml(ctx, [msg({
      content: '',
      embeds: [{
        title: 'Titre', description: 'Desc',
        fields: [{ name: 'Champ', value: 'Valeur' }],
        image: { url: 'https://cdn/e.png' },
        footer: { text: 'pied' },
        color: 0x6c5ce0,
      }],
    })]);
    expect(out).toContain('embed-field');
    expect(out).toContain('Champ');
    expect(out).toContain('embed-img');
    expect(out).toContain('pied');
  });

  it('rend le message cité d une réponse', () => {
    const ref = msg({ id: '0', content: 'message original',
      author: { id: 'u9', username: 'bob' } });
    const out = toHtml(ctx, [msg({ id: '1', type: 19, referenced_message: ref })]);
    expect(out).toContain('class="reply"');
    expect(out).toContain('message original');
    expect(out).toContain('bob');
  });

  it('marque les messages modifiés', () => {
    const out = toHtml(ctx, [msg({ edited_timestamp: '2026-01-02T10:00:00.000Z' })]);
    expect(out).toContain('(edited)');
  });

  it('rend les messages système sur une ligne à part', () => {
    const out = toHtml(ctx, [msg({ type: 7, content: '' })]);
    expect(out).toContain('class="sys"');
  });

  it('rend les spoilers et le souligné', () => {
    const out = toHtml(ctx, [msg({ content: '||caché|| et __souligné__' })]);
    expect(out).toContain('<span class="spoiler">caché</span>');
    expect(out).toContain('<u>souligné</u>');
  });

  it('rend titres, citations et listes', () => {
    const out = toHtml(ctx, [msg({ content: '# Titre\n> citation\n- un\n- deux' })]);
    expect(out).toContain('<h1 class="md-h1">Titre</h1>');
    expect(out).toContain('<blockquote>citation</blockquote>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>un</li>');
  });

  it('résout les mentions @<id> via message.mentions', () => {
    const out = toHtml(ctx, [msg({
      content: 'salut <@42> !',
      mentions: [{ id: '42', username: 'sora', global_name: 'Sora' }],
    })]);
    expect(out).toContain('@Sora');
    expect(out).not.toContain('@member');
  });

  it('rend un sondage Discord avec question et options', () => {
    const out = toHtml(ctx, [msg({
      poll: {
        question: { text: 'Quel hibou ?' },
        answers: [
          { answer_id: 1, poll_media: { text: 'Hibou grand-duc' } },
          { answer_id: 2, poll_media: { text: 'Chouette effraie' } },
        ],
        results: { answer_counts: [{ id: 1, count: 3 }, { id: 2, count: 7 }] },
      },
    })]);
    expect(out).toContain('Quel hibou ?');
    expect(out).toContain('Hibou grand-duc');
    expect(out).toContain('3 votes');
    expect(out).toContain('7 votes');
  });
});

/**
 * Audit final 2026-05-19, finding #1 (major) : sans filtrage, un embed
 * Discord avec `url: "javascript:..."` produisait un <a href="javascript:...">
 * cliquable dans l'archive HTML — RCE locale en contexte file://.
 */
describe('toHtml — securite (XSS protocole)', () => {
  function embedded(url: string): RawMessage {
    return msg({ embeds: [{ title: 'click me', url } as any] });
  }
  it('neutralise un embed avec url javascript: -> href="#"', () => {
    const out = toHtml(ctx, [embedded('javascript:alert(1)')]);
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain('href="#"');
  });
  it('neutralise un embed avec url data: -> href="#"', () => {
    const out = toHtml(ctx, [embedded('data:text/html,<script>')]);
    expect(out).not.toContain('href="data:');
  });
  it('preserve un embed avec url https:// — pas de faux positif', () => {
    const out = toHtml(ctx, [embedded('https://example.com/safe')]);
    expect(out).toContain('href="https://example.com/safe"');
  });
});

/**
 * Tests des features livrées en session 2026-05-19 (audit finding #4) :
 * avatars réels téléchargés, emojis custom rendus en image, mentions
 * pill colorée, bot tag, vidéo/audio inline.
 */
describe('toHtml — features 2026-05-19', () => {
  // urlToPath qui simule les médias téléchargés dans le zip.
  const ctxWithAvatar: ExportContext = {
    ...ctx,
    urlToPath: new Map([
      ['https://cdn.discordapp.com/avatars/u1/abc123.png', 'avatars/u1.png'],
      ['https://cdn.discordapp.com/emojis/999.png', 'emojis/999.png'],
    ]),
  };

  it('avatar réel — utilise l\'image locale si urlToPath contient le CDN', () => {
    const out = toHtml(ctxWithAvatar, [msg({
      author: { id: 'u1', username: 'sora', global_name: 'Sora', avatar: 'abc123' } as any,
    })]);
    expect(out).toContain('class="av av-img"');
    expect(out).toContain('../avatars/u1.png');
  });

  it('avatar fallback — pastille HSL si pas d\'avatar custom', () => {
    const out = toHtml(ctx, [msg({
      author: { id: 'u1', username: 'sora' } as any,
    })]);
    expect(out).toContain('background:hsl');
    expect(out).not.toContain('class="av av-img"');
  });

  it('emoji custom — rendu en <img> si téléchargé', () => {
    const out = toHtml(ctxWithAvatar, [msg({ content: 'Salut <:hibou:999> !' })]);
    expect(out).toContain('class="emoji"');
    expect(out).toContain('../emojis/999.png');
    expect(out).toContain('alt=":hibou:"');
  });

  it('emoji custom — fallback texte :nom: si pas téléchargé', () => {
    const out = toHtml(ctx, [msg({ content: 'Salut <:absent:42> !' })]);
    expect(out).toContain(':absent:');
    expect(out).not.toContain('<img class="emoji"');
  });

  it('mention user — span.mention avec data-user-id', () => {
    const out = toHtml(ctx, [msg({
      content: 'salut <@42> !',
      mentions: [{ id: '42', username: 'sora', global_name: 'Sora' }] as any,
    })]);
    expect(out).toContain('class="mention mention--user"');
    expect(out).toContain('data-user-id="42"');
    expect(out).toContain('@Sora');
  });

  it('mention role — span.mention--role avec data-role-id', () => {
    const out = toHtml(ctx, [msg({ content: 'cc <@&77>' })]);
    expect(out).toContain('class="mention mention--role"');
    expect(out).toContain('data-role-id="77"');
  });

  it('mention channel — span.mention--channel avec data-channel-id', () => {
    const out = toHtml(ctx, [msg({ content: 'rejoignez <#88>' })]);
    expect(out).toContain('class="mention mention--channel"');
    expect(out).toContain('data-channel-id="88"');
  });

  it('bot tag — badge BOT à côté du nom si author.bot=true', () => {
    const out = toHtml(ctx, [msg({
      author: { id: 'b1', username: 'helper', bot: true } as any,
    })]);
    expect(out).toContain('class="bot-tag"');
    expect(out).toContain('BOT');
  });

  it('pas de bot tag pour un utilisateur normal', () => {
    const out = toHtml(ctx, [msg({
      author: { id: 'u1', username: 'sam' } as any,
    })]);
    expect(out).not.toContain('class="bot-tag"');
  });

  it('vidéo — rendue en <video controls preload=none>', () => {
    const out = toHtml(ctx, [msg({
      attachments: [{
        id: 'a', filename: 'demo.mp4', size: 1000,
        url: 'https://cdn/v.mp4', proxy_url: '', content_type: 'video/mp4',
      }] as any,
    })]);
    expect(out).toContain('<video class="att-video"');
    expect(out).toContain('controls');
    expect(out).toContain('preload="none"');
    expect(out).toContain('type="video/mp4"');
  });

  it('audio — rendu en <audio controls preload=none>', () => {
    const out = toHtml(ctx, [msg({
      attachments: [{
        id: 'a', filename: 'demo.mp3', size: 1000,
        url: 'https://cdn/a.mp3', proxy_url: '', content_type: 'audio/mpeg',
      }] as any,
    })]);
    expect(out).toContain('<audio class="att-audio"');
    expect(out).toContain('controls');
    expect(out).toContain('type="audio/mpeg"');
  });
});
