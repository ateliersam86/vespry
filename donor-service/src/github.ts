/**
 * Webhook GitHub Sponsors.
 *
 * GitHub POST un JSON signé : en-tête `X-Hub-Signature-256: sha256=<hmac>`,
 * HMAC-SHA256 du corps avec le secret partagé. On ne retient que l'événement
 * `action: "created"` (nouveau parrainage) ; les changements de palier et les
 * annulations sont ignorés.
 *
 * Référence : https://docs.github.com/sponsors/integrating-with-github-sponsors
 */
import { hmacSha256Hex, timingSafeEqual } from './hmac';

export interface GithubSponsorship {
  login: string;
  name: string | null;
  /** `privacy_level === 'public'`. */
  isPublic: boolean;
  /** Epoch millisecondes. */
  createdAt: number;
}

/** Vérifie la signature HMAC-SHA256 d'un webhook GitHub. */
export async function verifyGithubSignature(
  secret: string,
  body: string,
  header: string,
): Promise<boolean> {
  if (!secret || !header.startsWith('sha256=')) return false;
  const hex = await hmacSha256Hex(secret, body);
  return timingSafeEqual(`sha256=${hex}`, header);
}

/**
 * Extrait un nouveau parrainage du payload GitHub Sponsors.
 * Null si ce n'est pas un événement `created` exploitable.
 */
export function parseGithub(body: string): GithubSponsorship | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (j['action'] !== 'created') return null;
  const s = j['sponsorship'] as Record<string, unknown> | undefined;
  if (!s) return null;
  const sponsor = s['sponsor'] as Record<string, unknown> | undefined;
  if (!sponsor || typeof sponsor['login'] !== 'string') return null;
  const created = s['created_at'];
  return {
    login: sponsor['login'],
    name: typeof sponsor['name'] === 'string' ? sponsor['name'] : null,
    isPublic: s['privacy_level'] === 'public',
    createdAt:
      typeof created === 'string' ? Date.parse(created) || Date.now() : Date.now(),
  };
}
