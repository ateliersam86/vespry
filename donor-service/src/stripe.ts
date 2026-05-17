/**
 * Intégration Stripe — création de sessions Checkout + vérification des
 * webhooks.
 *
 * L'API REST de Stripe est appelée en `fetch` brut : le SDK Node officiel
 * n'est pas adapté au runtime Workers, et un don n'a besoin que de deux
 * appels. Aucune carte ne transite jamais par ce code — Stripe Checkout
 * héberge la saisie. Aucun montant n'est stocké.
 */
import { hmacSha256Hex, timingSafeEqual } from './hmac';

/** Montant minimal d'un don, en centimes (1 €). */
export const MIN_CENTS = 100;
/** Montant maximal d'un don, en centimes (1000 €) — garde-fou anti-erreur. */
export const MAX_CENTS = 100_000;

/** Vrai si `cents` est un entier dans la plage de don autorisée. */
export function validAmount(cents: unknown): cents is number {
  return (
    typeof cents === 'number'
    && Number.isInteger(cents)
    && cents >= MIN_CENTS
    && cents <= MAX_CENTS
  );
}

export interface CheckoutParams {
  /** Montant du don, en centimes. */
  amountCents: number;
  donorName: string | null;
  message: string | null;
  isPublic: boolean;
  /** Origine publique du Worker — base des URLs de retour. */
  origin: string;
}

/**
 * Construit le corps urlencodé d'une création de session Checkout.
 * Fonction pure (testable sans réseau) ; `createCheckoutSession` l'utilise.
 */
export function checkoutSessionBody(p: CheckoutParams): string {
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('submit_type', 'donate'); // bouton « Faire un don » côté Stripe
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', 'eur');
  body.set('line_items[0][price_data][unit_amount]', String(p.amountCents));
  body.set('line_items[0][price_data][product_data][name]', 'Soutien à Vespry');
  body.set(
    'success_url',
    `${p.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
  );
  body.set('cancel_url', `${p.origin}/checkout/cancel`);
  body.set('metadata[isPublic]', p.isPublic ? 'true' : 'false');
  if (p.donorName) body.set('metadata[donorName]', p.donorName);
  if (p.message) body.set('metadata[message]', p.message);
  return body.toString();
}

/**
 * Crée une session Stripe Checkout. Renvoie l'URL de paiement, ou null si
 * Stripe refuse la requête.
 */
export async function createCheckoutSession(
  secretKey: string,
  p: CheckoutParams,
): Promise<string | null> {
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: checkoutSessionBody(p),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { url?: unknown };
  return typeof data.url === 'string' ? data.url : null;
}

/** Découpe l'en-tête `Stripe-Signature` : `t=...,v1=...`. */
function parseSigHeader(header: string): { t: string; v1: string[] } {
  let t = '';
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (key === 't') t = value;
    else if (key === 'v1' && value) v1.push(value);
  }
  return { t, v1 };
}

/**
 * Vérifie la signature d'un webhook Stripe.
 * Contrôle aussi la fraîcheur de l'horodatage (anti-rejeu) : un événement
 * plus vieux que `toleranceSec` est rejeté.
 */
export async function verifyStripeSignature(
  secret: string,
  body: string,
  header: string,
  toleranceSec = 300,
): Promise<boolean> {
  if (!secret || !header) return false;
  const { t, v1 } = parseSigHeader(header);
  if (!t || v1.length === 0) return false;
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  return v1.some((sig) => timingSafeEqual(sig, expected));
}

export interface StripeCheckoutEvent {
  sessionId: string;
  /** Vrai si le paiement est confirmé (`payment_status === 'paid'`). */
  paid: boolean;
  donorName: string | null;
  message: string | null;
  isPublic: boolean;
}

/**
 * Extrait un événement `checkout.session.completed` du corps d'un webhook
 * Stripe. Null si l'événement n'est pas pertinent.
 */
export function parseStripeEvent(body: string): StripeCheckoutEvent | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (j['type'] !== 'checkout.session.completed') return null;
  const data = j['data'] as Record<string, unknown> | undefined;
  const session = data?.['object'] as Record<string, unknown> | undefined;
  if (!session || typeof session['id'] !== 'string') return null;
  const meta = (session['metadata'] as Record<string, unknown> | undefined) ?? {};
  return {
    sessionId: session['id'],
    paid: session['payment_status'] === 'paid',
    donorName: typeof meta['donorName'] === 'string' ? meta['donorName'] : null,
    message: typeof meta['message'] === 'string' ? meta['message'] : null,
    isPublic: meta['isPublic'] === 'true',
  };
}
