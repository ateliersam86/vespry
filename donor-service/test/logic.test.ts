/**
 * Tests unitaires de la logique pure du Worker (hors D1) :
 * paliers, modération, parsing Ko-Fi, signature GitHub.
 */
import { describe, expect, it } from 'vitest';
import { milestoneFor, nextMilestone, TIERS } from '../src/milestones';
import { cleanText, MAX_MESSAGE, MAX_NAME } from '../src/moderation';
import { parseKofi } from '../src/kofi';
import { parseGithub, verifyGithubSignature } from '../src/github';

describe('milestones', () => {
  it('reconnaît un palier exact', () => {
    expect(milestoneFor(1)).toBe('m.first');
    expect(milestoneFor(10)).toBe('m.ten');
    expect(milestoneFor(100)).toBe('m.hundred');
  });

  it('renvoie null hors palier', () => {
    expect(milestoneFor(2)).toBeNull();
    expect(milestoneFor(99)).toBeNull();
    expect(milestoneFor(0)).toBeNull();
  });

  it('calcule le prochain palier atteignable', () => {
    expect(nextMilestone(0)).toEqual({ key: 'm.first', seq: 1, remaining: 1 });
    expect(nextMilestone(7)).toEqual({ key: 'm.ten', seq: 10, remaining: 3 });
    expect(nextMilestone(10)).toEqual({ key: 'm.twentyfive', seq: 25, remaining: 15 });
  });

  it('renvoie null une fois tous les paliers franchis', () => {
    const last = TIERS[TIERS.length - 1]!;
    expect(nextMilestone(last.seq)).toBeNull();
  });
});

describe('moderation', () => {
  it('garde un texte propre et compacte les espaces', () => {
    expect(cleanText('  Merci   beaucoup ! ', MAX_MESSAGE)).toBe('Merci beaucoup !');
  });

  it('renvoie null pour un texte vide', () => {
    expect(cleanText('', MAX_NAME)).toBeNull();
    expect(cleanText('   ', MAX_NAME)).toBeNull();
    expect(cleanText(null, MAX_NAME)).toBeNull();
  });

  it('retire un texte contenant une insulte (même accentuée)', () => {
    expect(cleanText('espèce de connard', MAX_MESSAGE)).toBeNull();
    expect(cleanText('enculé', MAX_MESSAGE)).toBeNull();
    expect(cleanText('FUCK this', MAX_MESSAGE)).toBeNull();
  });

  it('ne déclenche pas sur une sous-chaîne légitime (Scunthorpe)', () => {
    expect(cleanText('Cuntis Scunthorpe', MAX_NAME)).toBe('Cuntis Scunthorpe');
  });

  it('coupe à la longueur maximale', () => {
    expect(cleanText('x'.repeat(500), MAX_MESSAGE)?.length).toBe(MAX_MESSAGE);
  });
});

describe('parseKofi', () => {
  const wrap = (obj: unknown): string =>
    `data=${encodeURIComponent(JSON.stringify(obj))}`;

  it('parse un don public', () => {
    const p = parseKofi(
      wrap({
        verification_token: 'tok',
        message_id: 'abc-123',
        timestamp: '2026-05-17T10:00:00Z',
        type: 'Donation',
        is_public: true,
        from_name: 'Marie',
        message: 'Bravo !',
      }),
    );
    expect(p?.messageId).toBe('abc-123');
    expect(p?.fromName).toBe('Marie');
    expect(p?.isPublic).toBe(true);
    expect(p?.message).toBe('Bravo !');
  });

  it('repère un renouvellement d’abonnement', () => {
    const p = parseKofi(
      wrap({
        message_id: 'sub-1',
        is_subscription_payment: true,
        is_first_subscription_payment: false,
      }),
    );
    expect(p?.isSubscriptionPayment).toBe(true);
    expect(p?.isFirstSubscriptionPayment).toBe(false);
  });

  it('renvoie null sur un corps invalide', () => {
    expect(parseKofi('')).toBeNull();
    expect(parseKofi('data=not-json')).toBeNull();
    expect(parseKofi(wrap({ no_id: true }))).toBeNull();
  });
});

describe('parseGithub', () => {
  it('extrait un nouveau parrainage public', () => {
    const s = parseGithub(
      JSON.stringify({
        action: 'created',
        sponsorship: {
          created_at: '2026-05-17T09:00:00Z',
          privacy_level: 'public',
          sponsor: { login: 'octocat', name: 'The Octocat' },
        },
      }),
    );
    expect(s?.login).toBe('octocat');
    expect(s?.name).toBe('The Octocat');
    expect(s?.isPublic).toBe(true);
  });

  it('ignore les événements non « created »', () => {
    expect(
      parseGithub(JSON.stringify({ action: 'cancelled', sponsorship: {} })),
    ).toBeNull();
  });
});

describe('verifyGithubSignature', () => {
  const secret = 'super-secret';
  const body = '{"action":"created"}';

  async function sign(s: string, payload: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(s),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(payload),
    );
    const hex = [...new Uint8Array(mac)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `sha256=${hex}`;
  }

  it('accepte une signature valide', async () => {
    expect(await verifyGithubSignature(secret, body, await sign(secret, body)))
      .toBe(true);
  });

  it('rejette une mauvaise signature', async () => {
    expect(await verifyGithubSignature(secret, body, await sign('wrong', body)))
      .toBe(false);
    expect(await verifyGithubSignature(secret, body, 'sha256=deadbeef'))
      .toBe(false);
    expect(await verifyGithubSignature(secret, body, '')).toBe(false);
  });
});
