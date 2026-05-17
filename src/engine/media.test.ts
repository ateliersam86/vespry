import { describe, expect, it } from 'vitest';
import { classifyExt, collectAssets, hashUrl } from './media';
import { ALL_MEDIA, type MediaSelection } from './checkpoint-types';
import type { RawMessage } from './types';

function msg(partial: Partial<RawMessage>): RawMessage {
  return {
    id: '1',
    type: 0,
    channel_id: 'c1',
    author: { id: 'u1', username: 'sam' },
    content: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    attachments: [],
    embeds: [],
    ...partial,
  };
}

const att = (id: string, filename: string, url = `https://cdn/${filename}`) => ({
  id,
  filename,
  size: 1,
  url,
  proxy_url: url,
});

const NONE: MediaSelection = { images: false, videos: false, audio: false, files: false };

describe('classifyExt', () => {
  it('classe les extensions', () => {
    expect(classifyExt('png')).toBe('image');
    expect(classifyExt('mp4')).toBe('video');
    expect(classifyExt('mp3')).toBe('audio');
    expect(classifyExt('pdf')).toBe('file');
  });
});

describe('collectAssets', () => {
  it('par défaut (ALL_MEDIA) prend tout : image, vidéo, audio, fichier', () => {
    const m = msg({
      attachments: [
        att('a1', 'photo.png'),
        att('a2', 'clip.mp4'),
        att('a3', 'voix.mp3'),
        att('a4', 'notes.txt'),
      ],
    });
    const got = collectAssets(m, ALL_MEDIA);
    expect(got.map((a) => a.kind).sort()).toEqual(['audio', 'file', 'image', 'video']);
  });

  it('respecte la sélection : vidéos désactivées → vidéo ignorée', () => {
    const m = msg({ attachments: [att('a1', 'photo.png'), att('a2', 'clip.mp4')] });
    const got = collectAssets(m, { ...ALL_MEDIA, videos: false });
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe('image');
  });

  it('ne collecte rien si tout est désactivé', () => {
    const m = msg({ attachments: [att('a1', 'photo.png'), att('a2', 'clip.mp4')] });
    expect(collectAssets(m, NONE)).toHaveLength(0);
  });

  it('collecte les images et vidéos d\'embed', () => {
    const m = msg({
      embeds: [
        { thumbnail: { url: 'https://cdn/e.png' } },
        { video: { url: 'https://cdn/v.mp4' } },
      ],
    });
    const got = collectAssets(m, ALL_MEDIA);
    expect(got.map((a) => a.kind).sort()).toEqual(['image', 'video']);
  });

  it('collecte les stickers rasterisables comme images', () => {
    const m = msg({ sticker_items: [{ id: '999', name: 'fox', format_type: 1 }] });
    const got = collectAssets(m, ALL_MEDIA);
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe('image');
    expect(got[0]?.url).toContain('/stickers/999.png');
  });

  it('ignore les stickers Lottie (vectoriels)', () => {
    const m = msg({ sticker_items: [{ id: '1', name: 'x', format_type: 3 }] });
    expect(collectAssets(m, ALL_MEDIA)).toHaveLength(0);
  });

  it('déduplique par assetId', () => {
    const a = att('a1', 'photo.png');
    const m = msg({ attachments: [a, a] });
    expect(collectAssets(m, ALL_MEDIA)).toHaveLength(1);
  });
});

describe('hashUrl', () => {
  it('est stable et déterministe', () => {
    expect(hashUrl('https://x/y')).toBe(hashUrl('https://x/y'));
    expect(hashUrl('https://x/y')).not.toBe(hashUrl('https://x/z'));
  });
});
