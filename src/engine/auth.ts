/**
 * Stockage et récupération du jeton de session Discord.
 *
 * Le jeton est capté par le bridge (monde MAIN) puis écrit ici, dans
 * `chrome.storage.local` — partagé par tous les contextes de l'extension
 * (popup, content scripts). Le service worker le relit pour le compte de
 * l'offscreen, qui n'a pas accès à `chrome.storage`.
 */

const TOKEN_KEY = 'vespry.discordToken';

export interface StoredToken {
  token: string;
  capturedAt: number;
}

/** Enregistre un jeton fraîchement capté. No-op si identique au précédent. */
export async function saveToken(token: string): Promise<void> {
  const existing = await getStoredToken();
  if (existing?.token === token) return;
  const entry: StoredToken = { token, capturedAt: Date.now() };
  await chrome.storage.local.set({ [TOKEN_KEY]: entry });
}

/** Renvoie le jeton stocké, ou null. */
export async function getStoredToken(): Promise<StoredToken | null> {
  const result = await chrome.storage.local.get(TOKEN_KEY);
  const entry = result[TOKEN_KEY] as StoredToken | undefined;
  return entry ?? null;
}

/** Raccourci : la valeur du jeton seule, ou null. */
export async function getToken(): Promise<string | null> {
  return (await getStoredToken())?.token ?? null;
}

/** Efface le jeton (déconnexion / révocation). */
export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}

/** S'abonne aux changements du jeton (capture, effacement). */
export function onTokenChange(cb: (token: string | null) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'local' || !(TOKEN_KEY in changes)) return;
    const next = changes[TOKEN_KEY]?.newValue as StoredToken | undefined;
    cb(next?.token ?? null);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
