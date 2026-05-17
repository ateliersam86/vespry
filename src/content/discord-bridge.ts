/**
 * Bridge de capture du jeton — content script en monde MAIN.
 *
 * Le jeton de session apparaît dans l'en-tête `authorization` des requêtes que
 * le client Discord émet vers son API. On patche `fetch` et `XMLHttpRequest`
 * pour observer cet en-tête — sans modifier les requêtes — et on relaie le
 * jeton au content script ISOLATED via `window.postMessage`.
 *
 * Monde MAIN (cf. manifest) : accès aux objets de la page, aucun accès aux
 * API `chrome.*`. Des marqueurs `__vespry*` sont posés sur `window` pour le
 * diagnostic automatisé.
 */
import { BRIDGE_SOURCE, type BridgeTokenMessage } from '../messaging';

interface BridgeDebug {
  __vespryBridge?: boolean;
  __vespryFetch?: number;
  __vespryXhr?: number;
  __vesprySawAuth?: number;
  __vespryPosted?: number;
}
const dbg = window as unknown as BridgeDebug;
dbg.__vespryBridge = true;

let lastSent = '';

function publishToken(token: string): void {
  dbg.__vesprySawAuth = (dbg.__vesprySawAuth ?? 0) + 1;
  if (!token || token === lastSent) return;
  // Heuristique : un jeton utilisateur Discord fait > 50 caractères et n'est
  // pas un en-tête "Bot ..." / "Bearer ...".
  if (token.length < 50 || /^(Bot|Bearer)\s/i.test(token)) return;
  lastSent = token;
  dbg.__vespryPosted = (dbg.__vespryPosted ?? 0) + 1;
  const msg: BridgeTokenMessage = { source: BRIDGE_SOURCE, type: 'token', token };
  window.postMessage(msg, window.location.origin);
}

function extractFromHeaders(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get('authorization');
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      if (k.toLowerCase() === 'authorization') return v;
    }
    return null;
  }
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'authorization') {
      return (headers as Record<string, string>)[k] ?? null;
    }
  }
  return null;
}

// --- Patch de fetch ---
const originalFetch = window.fetch;
window.fetch = function patchedFetch(
  this: typeof window,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  dbg.__vespryFetch = (dbg.__vespryFetch ?? 0) + 1;
  try {
    let token: string | null = null;
    if (input instanceof Request) token = input.headers.get('authorization');
    if (!token) token = extractFromHeaders(init?.headers);
    if (token) publishToken(token);
  } catch {
    /* l'observation ne doit jamais casser la requête de Discord */
  }
  return originalFetch.call(this, input as RequestInfo, init);
};

// --- Patch de XMLHttpRequest.setRequestHeader ---
const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(
  this: XMLHttpRequest,
  name: string,
  value: string,
): void {
  dbg.__vespryXhr = (dbg.__vespryXhr ?? 0) + 1;
  try {
    if (name.toLowerCase() === 'authorization') publishToken(value);
  } catch {
    /* idem : ne jamais perturber Discord */
  }
  return originalSetRequestHeader.call(this, name, value);
};
