/**
 * Préférence de thème — sombre / clair / auto.
 *
 * Par défaut : sombre (Vespry imite Discord, et le mode auto peut surprendre
 * avec un rendu clair). Persistée dans `chrome.storage.local`, partagée entre
 * le popup et l'overlay.
 */
export type ThemePref = 'dark' | 'light' | 'auto';

const KEY = 'vespry.theme';

/** Lit la préférence (défaut : sombre). */
export async function getThemePref(): Promise<ThemePref> {
  try {
    const r = await chrome.storage.local.get(KEY);
    const v = r[KEY];
    return v === 'light' || v === 'auto' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

/** Enregistre la préférence. */
export function setThemePref(pref: ThemePref): void {
  void chrome.storage.local.set({ [KEY]: pref }).catch(() => {});
}

/** Résout `auto` selon le réglage système ; renvoie le thème concret. */
export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref !== 'auto') return pref;
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

/** Ordre de cycle pour le bouton de thème. */
export function nextThemePref(pref: ThemePref): ThemePref {
  return pref === 'dark' ? 'light' : pref === 'light' ? 'auto' : 'dark';
}
