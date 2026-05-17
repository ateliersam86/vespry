/**
 * Primitives HMAC-SHA256 — partagées par la vérification des webhooks
 * GitHub (`github.ts`) et Stripe (`stripe.ts`).
 */

const enc = new TextEncoder();

/** HMAC-SHA256 du `payload` avec le `secret`, rendu en hexadécimal minuscule. */
export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Comparaison à temps constant — évite les attaques temporelles sur les signatures. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
