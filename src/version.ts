/**
 * Version de l'extension.
 *
 * Source de vérité unique : la version du `manifest.json` que Chrome a chargé
 * (`chrome.runtime.getManifest()`). En CI, cette version est dérivée du tag de
 * release GitHub — jamais saisie à la main (voir .github/workflows/release.yml).
 *
 * `checkForUpdate()` interroge l'API GitHub pour signaler une release plus
 * récente — utile surtout pour la distribution hors Chrome Web Store.
 */

// Dépôt GitHub du projet (owner/repo) — alimente checkForUpdate() et loadCredits().
export const GITHUB_REPO = 'ateliersam86/vespry';

/** Version actuellement exécutée (canonique). */
export function getVersion(): string {
  return chrome.runtime.getManifest().version;
}

/** Compare deux versions semver. true si `a` est plus récente que `b`. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

/**
 * Renvoie la version de la dernière release GitHub si elle est plus récente
 * que la version courante, sinon null. L'API GitHub autorise le CORS, donc
 * aucune permission d'hôte n'est requise.
 */
export async function checkForUpdate(): Promise<string | null> {
  if (!GITHUB_REPO) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    const latest = (data.tag_name ?? '').replace(/^v/, '');
    return latest && isNewer(latest, getVersion()) ? latest : null;
  } catch {
    return null;
  }
}
