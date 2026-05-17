/**
 * Liens de soutien & contributeurs — module de configuration.
 *
 * Les URLs et la liste des contributeurs vivent dans `credits.json` sur le
 * dépôt GitHub. L'extension les lit en direct (Sam peut les actualiser sans
 * publier de nouvelle version) ; à défaut, elle utilise la copie embarquée.
 *
 * Les soutiens eux-mêmes ne sont PAS ici : ils viennent en direct du service
 * `vespry-donors` via `donorApiUrl` (cf. `src/donors.ts`).
 *
 * Champs vides = fonctionnalité non encore configurée (bouton désactivé).
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
  /** URL GitHub Sponsors (vide = pas encore configurée). */
  gitHubSponsorsUrl: string;
  /** URL du service du mur des soutiens (Worker `vespry-donors`). */
  donorApiUrl: string;
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
          gitHubSponsorsUrl: data.gitHubSponsorsUrl ?? '',
          donorApiUrl: data.donorApiUrl ?? '',
          contributors: data.contributors ?? [],
        };
      }
    } catch {
      /* hors-ligne ou dépôt indisponible — on retombe sur le bundle */
    }
  }
  return bundled as Credits;
}
