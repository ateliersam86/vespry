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

export interface GithubSponsorship {
  login: string;
  name: string | null;
  /** `privacy_level === 'public'`. */
  isPublic: boolean;
  /** Epoch millisecondes. */
  createdAt: number;
}

const enc = new TextEncoder();

/** Comparaison à temps constant — évite les attaques temporelles sur la signature. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Vérifie la signature HMAC-SHA256 d'un webhook GitHub. */
export async function verifyGithubSignature(
  secret: string,
  body: string,
  header: string,
): Promise<boolean> {
  if (!secret || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
