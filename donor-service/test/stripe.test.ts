/**
 * Tests unitaires de l'intégration Stripe (logique pure, hors réseau) :
 * validation de montant, corps de session Checkout, parsing d'événement,
 * vérification de signature de webhook.
 */
import { describe, expect, it } from 'vitest';
import {
  checkoutSessionBody,
  MAX_CENTS,
  MIN_CENTS,
  parseStripeEvent,
  validAmount,
  verifyStripeSignature,
} from '../src/stripe';
import { hmacSha256Hex } from '../src/hmac';

describe('validAmount', () => {
  it('accepte les montants dans la plage', () => {
    expect(validAmount(MIN_CENTS)).toBe(true);
    expect(validAmount(500)).toBe(true);
    expect(validAmount(MAX_CENTS)).toBe(true);
  });

  it('rejette hors plage, non-entier, non-nombre', () => {
    expect(validAmount(MIN_CENTS - 1)).toBe(false);
    expect(validAmount(MAX_CENTS + 1)).toBe(false);
    expect(validAmount(5.5)).toBe(false);
    expect(validAmount('500')).toBe(false);
    expect(validAmount(undefined)).toBe(false);
  });
});

describe('checkoutSessionBody', () => {
  it('encode le montant, le mode don et les URLs de retour', () => {
    const body = checkoutSessionBody({
      amountCents: 500,
      donorName: 'Marie',
      message: 'Bravo',
      isPublic: true,
      origin: 'https://w.example.com',
    });
    const p = new URLSearchParams(body);
    expect(p.get('mode')).toBe('payment');
    expect(p.get('submit_type')).toBe('donate');
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe('500');
    expect(p.get('line_items[0][price_data][currency]')).toBe('eur');
    expect(p.get('success_url')).toContain('https://w.example.com/checkout/success');
    expect(p.get('cancel_url')).toBe('https://w.example.com/checkout/cancel');
    expect(p.get('metadata[isPublic]')).toBe('true');
    expect(p.get('metadata[donorName]')).toBe('Marie');
    expect(p.get('metadata[message]')).toBe('Bravo');
  });

  it('omet nom et message quand ils sont absents', () => {
    const p = new URLSearchParams(
      checkoutSessionBody({
        amountCents: 300,
        donorName: null,
        message: null,
        isPublic: false,
        origin: 'https://w.example.com',
      }),
    );
    expect(p.has('metadata[donorName]')).toBe(false);
    expect(p.has('metadata[message]')).toBe(false);
    expect(p.get('metadata[isPublic]')).toBe('false');
  });
});

describe('parseStripeEvent', () => {
  const completed = (payment_status: string, metadata: unknown): string =>
    JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1', payment_status, metadata } },
    });

  it('extrait un don payé avec métadonnées', () => {
    const e = parseStripeEvent(
      completed('paid', { donorName: 'Léa', message: 'Merci', isPublic: 'true' }),
    );
    expect(e?.sessionId).toBe('cs_test_1');
    expect(e?.paid).toBe(true);
    expect(e?.donorName).toBe('Léa');
    expect(e?.isPublic).toBe(true);
  });

  it('signale un paiement non confirmé', () => {
    expect(parseStripeEvent(completed('unpaid', {}))?.paid).toBe(false);
  });

  it('renvoie null pour un autre type d’événement ou un corps invalide', () => {
    expect(parseStripeEvent(JSON.stringify({ type: 'payment_intent.created' })))
      .toBeNull();
    expect(parseStripeEvent('pas du json')).toBeNull();
  });
});

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test';
  const body = '{"type":"checkout.session.completed"}';

  const header = async (ts: number, payload = body, sigSecret = secret): Promise<string> => {
    const sig = await hmacSha256Hex(sigSecret, `${ts}.${payload}`);
    return `t=${ts},v1=${sig}`;
  };

  it('accepte une signature fraîche et valide', async () => {
    const t = Math.floor(Date.now() / 1000);
    expect(await verifyStripeSignature(secret, body, await header(t))).toBe(true);
  });

  it('rejette une signature périmée (anti-rejeu)', async () => {
    const old = Math.floor(Date.now() / 1000) - 10_000;
    expect(await verifyStripeSignature(secret, body, await header(old))).toBe(false);
  });

  it('rejette une mauvaise signature ou un en-tête vide', async () => {
    const t = Math.floor(Date.now() / 1000);
    expect(await verifyStripeSignature(secret, body, await header(t, body, 'wrong')))
      .toBe(false);
    expect(await verifyStripeSignature(secret, body, `t=${t},v1=deadbeef`)).toBe(false);
    expect(await verifyStripeSignature(secret, body, '')).toBe(false);
  });
});
