/**
 * Soutiens & contributeurs — module de reconnaissance.
 *
 * Sans backend : la liste vit dans `credits.json` sur le dépôt GitHub.
 * L'extension la lit en direct (Sam peut l'actualiser sans publier de
 * nouvelle version) ; à défaut, elle utilise la copie embarquée au build.
 *
 * `koFiUrl` est vide tant que la page Ko-Fi n'est pas créée — le bouton de
 * don est alors désactivé.
 */
import bundled from './credits.json';
import { GITHUB_REPO } from './version';

export interface Contributor {
  name: string;
  role: string;
}

export interface Credits {
  /** URL de la page Ko-Fi (vide = pas encore configurée). */
  koFiUrl: string;
  /** Donateurs ayant consenti à être nommés. */
  supporters: string[];
  /** Personnes qui ont fait avancer le projet (code, traductions, bugs…). */
  contributors: Contributor[];
}

/**
 * Charge les crédits : version live depuis GitHub si le dépôt est configuré,
 * sinon la copie embarquée. Ne lève jamais — renvoie au pire le bundle.
 */
export async function loadCredits(): Promise<Credits> {
  if (GITHUB_REPO) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${GITHUB_REPO}/main/credits.json`,
        { cache: 'no-cache' },
      );
      if (res.ok) {
        const data = (await res.json()) as Partial<Credits>;
        return {
          koFiUrl: data.koFiUrl ?? '',
          supporters: data.supporters ?? [],
          contributors: data.contributors ?? [],
        };
      }
    } catch {
      /* hors-ligne ou dépôt indisponible — on retombe sur le bundle */
    }
  }
  return bundled as Credits;
}
