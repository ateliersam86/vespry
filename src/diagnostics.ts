/**
 * Diagnostic & remontée d'erreurs.
 *
 * - Capture les erreurs non gérées dans un buffer circulaire (par contexte).
 * - Assemble un rapport technique (version, navigateur, OS, logs récents).
 * - Ouvre une issue GitHub pré-remplie, ou copie le rapport si le dépôt n'est
 *   pas encore configuré.
 *
 * IMPORTANT — vie privée : le rapport n'inclut JAMAIS le jeton Discord ni le
 * contenu des messages. Uniquement du contexte technique.
 */
import { GITHUB_REPO, getVersion } from './version';
import { getDetectedUnknowns } from './engine/schema-watch';

const MAX_EVENTS = 60;
const events: string[] = [];

/** Ajoute une ligne au buffer de diagnostic. */
export function recordEvent(level: 'info' | 'warn' | 'error', message: string): void {
  events.push(`${new Date().toISOString()} [${level}] ${message}`);
  if (events.length > MAX_EVENTS) events.shift();
}

/** Branche la capture des erreurs non gérées du contexte courant. */
export function installGlobalHandlers(context: string): void {
  self.addEventListener('error', (e) => {
    const ev = e as ErrorEvent;
    recordEvent('error', `${context}: ${ev.message || String(ev.error)}`);
  });
  self.addEventListener('unhandledrejection', (e) => {
    const ev = e as PromiseRejectionEvent;
    recordEvent('error', `${context}: rejet non géré — ${String(ev.reason)}`);
  });
}

/**
 * Assemble un rapport Markdown. `extraLines` = lignes spécifiques (ex. le
 * journal d'une tâche d'export échouée).
 */
export function buildReport(summary: string, extraLines: string[] = []): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const lines = [
    `**Résumé** : ${summary}`,
    '',
    '### Environnement',
    `- Vespry : v${getVersion()}`,
    `- Navigateur : ${navigator.userAgent}`,
    `- Plateforme : ${nav.userAgentData?.platform ?? 'inconnue'}`,
    `- Langue : ${navigator.language}`,
    '',
    '### Journal',
    '```',
    ...(extraLines.length > 0 ? extraLines : ['(aucun journal de tâche)']),
    '```',
  ];
  if (events.length > 0) {
    lines.push('', '### Erreurs captées', '```', ...events, '```');
  }
  // Champs Discord inconnus rencontrés — signal qu'une évolution de l'API
  // a peut-être eu lieu et que Vespry pourrait avoir besoin d'une mise à jour.
  const unknowns = getDetectedUnknowns();
  if (unknowns.length > 0) {
    lines.push(
      '',
      '### Champs Discord inconnus rencontrés',
      'Ces champs ne sont pas rendus par Vespry mais restent préservés dans',
      'le JSON exporté. Une nouvelle évolution de l\'API Discord est probable :',
      '```',
      ...unknowns,
      '```',
    );
  }
  lines.push(
    '',
    '_Rapport généré par Vespry. Ne contient ni jeton Discord ni contenu de messages._',
  );
  return lines.join('\n');
}

/**
 * Ouvre une issue GitHub pré-remplie. Si le dépôt n'est pas encore configuré
 * (`GITHUB_REPO` vide), copie le rapport dans le presse-papier à la place.
 * Renvoie `'issue'` ou `'clipboard'` selon l'action effectuée.
 */
export async function reportProblem(
  summary: string,
  extraLines: string[] = [],
): Promise<'issue' | 'clipboard'> {
  const body = buildReport(summary, extraLines);
  if (GITHUB_REPO) {
    const url =
      `https://github.com/${GITHUB_REPO}/issues/new`
      + `?title=${encodeURIComponent(`[bug] ${summary}`)}`
      + `&body=${encodeURIComponent(body)}`;
    window.open(url, '_blank', 'noopener');
    return 'issue';
  }
  try {
    await navigator.clipboard.writeText(body);
  } catch {
    /* presse-papier indisponible — sans gravité */
  }
  return 'clipboard';
}

/**
 * Ouvre une discussion GitHub (catégorie « Ideas ») pré-remplie pour que
 * l'utilisateur propose une amélioration. Différent de `reportProblem` :
 *
 *   - Cible Discussions, pas Issues (votes, threading, conversation).
 *   - Aucun rapport technique automatique (env, journal, etc.) — c'est
 *     une suggestion produit, pas un bug. Seule la version est passée
 *     pour aider à savoir quelle release l'a inspirée.
 *   - Le template `.github/DISCUSSION_TEMPLATE/ideas.yml` guide l'utilisateur
 *     vers une description orientée problème, pas solution.
 *
 * Si `GITHUB_REPO` n'est pas configuré, ouvre quand même la page racine
 * du dépôt en fallback (l'utilisateur trouvera Discussions à la main).
 */
export function proposeImprovement(): void {
  if (!GITHUB_REPO) return;
  const url =
    `https://github.com/${GITHUB_REPO}/discussions/new`
    + '?category=ideas'
    + `&body=${encodeURIComponent(`<!-- Version Vespry : ${getVersion()} -->\n\n`)}`;
  window.open(url, '_blank', 'noopener');
}
