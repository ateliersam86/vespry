/**
 * Rendu sûr du markdown Discord — partagé entre l'aperçu (Preact) et les
 * exporteurs (chaîne HTML pour le fichier exporté).
 *
 * Pipeline : `humanize` (remplace les balises Discord brutes par du texte
 * lisible) → `esc` (échappe le HTML) → markdown Discord (titres, citations,
 * listes, gras, italique, souligné, barré, spoiler, code, liens) → sauts de
 * ligne. L'ordre `esc → markdown` est crucial : on échappe AVANT d'introduire
 * la moindre balise, donc aucun HTML utilisateur ne peut s'injecter.
 */

/** Étiquettes de mentions Discord, traduites — `@membre`, `@rôle`, `#salon`. */
export interface MentionLabels {
  user: string;
  role: string;
  channel: string;
}

/**
 * Mentions résolues — `<@id>` → nom réel quand on connaît l'utilisateur,
 * sinon repli sur l'étiquette générique `@member` etc.
 */
export interface ResolvedMentions {
  /** id utilisateur → nom à afficher (sans le @). */
  users?: Record<string, string>;
  /** id rôle → nom (sans le @). */
  roles?: Record<string, string>;
  /** id salon → nom (sans le #). */
  channels?: Record<string, string>;
}

/** Échappe le texte pour une insertion HTML sûre. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Remplace les balises Discord brutes par du texte lisible.
 * Utilise les noms résolus si disponibles, repli sur les labels génériques.
 */
export function humanize(
  text: string,
  mentions: MentionLabels,
  resolved?: ResolvedMentions,
): string {
  return text
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<@!?(\d+)>/g, (_, id: string) =>
      `@${resolved?.users?.[id] ?? mentions.user.replace(/^@/, '')}`)
    .replace(/<@&(\d+)>/g, (_, id: string) =>
      `@${resolved?.roles?.[id] ?? mentions.role.replace(/^@/, '')}`)
    .replace(/<#(\d+)>/g, (_, id: string) =>
      `#${resolved?.channels?.[id] ?? mentions.channel.replace(/^#/, '')}`);
}

/** Marqueur opaque pour protéger les blocs de code pendant l'expansion inline. */
const CODE_PLACEHOLDER = 'CODE';
const INLINE_CODE_PLACEHOLDER = 'IC';

/** Rend les transformations inline (gras, italique, spoiler…). */
function inlineMd(s: string): string {
  let r = s;
  r = r.replace(/\|\|([^|]+?)\|\|/g, '<span class="spoiler">$1</span>');
  r = r.replace(/\*\*\*([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  r = r.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  r = r.replace(/__([^_]+?)__/g, '<u>$1</u>');
  r = r.replace(/~~([^~]+?)~~/g, '<s>$1</s>');
  // italique : `*…*` ou `_…_`, en évitant les doublons traités plus haut.
  r = r.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  r = r.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');
  // Liens auto. La classe finale `[^\s<]+` consommait la ponctuation
  // terminale (`.`, `,`, `)`, `!`, `?`, `;`, `:`) — un lien collé à une
  // phrase comme `Vois https://x.com/foo.` finissait avec un `.` dans
  // l'URL et 404. On exclut explicitement ces caractères en fin de match,
  // puis on les remet hors du `<a>` via une post-capture optionnelle.
  // Audit B+C (2026-05-18).
  r = r.replace(
    /(https?:\/\/[^\s<]*?)([.,)!?;:]*)(?=\s|$|[<])/g,
    '<a href="$1" rel="noopener">$1</a>$2',
  );
  return r;
}

/**
 * Rend une ligne en markdown bloc : titres, citations, listes. Renvoie la
 * ligne déjà enveloppée si applicable, sinon `null` pour traitement inline.
 */
function blockLine(line: string): string | null {
  // Titres : `# `, `## `, `### `.
  const h = /^(#{1,3})\s+(.+)$/.exec(line);
  if (h) {
    const level = h[1]!.length;
    return `<h${level} class="md-h${level}">${inlineMd(h[2]!)}</h${level}>`;
  }
  // Citation : `> ` (le `>` est déjà échappé en `&gt;` à ce stade).
  const q = /^&gt;\s+(.+)$/.exec(line);
  if (q) return `<blockquote>${inlineMd(q[1]!)}</blockquote>`;
  // Liste : `- ` ou `* `.
  const l = /^[-*]\s+(.+)$/.exec(line);
  if (l) return `<li>${inlineMd(l[1]!)}</li>`;
  return null;
}

/** Concatène les `<li>` consécutifs dans un `<ul>`, le reste inchangé. */
function wrapLists(lines: string[]): string[] {
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const isLi = line.startsWith('<li>');
    if (isLi && !inList) { out.push('<ul>'); inList = true; }
    if (!isLi && inList) { out.push('</ul>'); inList = false; }
    out.push(line);
  }
  if (inList) out.push('</ul>');
  return out;
}

/**
 * Rend un contenu de message en HTML : humanize → escape → blocs de code →
 * lignes bloc (titres/citations/listes) → markdown inline → sauts de ligne.
 * Sortie sûre, utilisable en `dangerouslySetInnerHTML`.
 */
export function renderInlineHtml(
  text: string,
  mentions: MentionLabels,
  resolved?: ResolvedMentions,
): string {
  // Humanize + escape d'abord, AVANT toute insertion de balise.
  let s = escapeHtml(humanize(text, mentions, resolved));

  // Protège les blocs et le code inline : on les remplace par des marqueurs
  // opaques, on travaille le reste, puis on les ré-injecte.
  const blocks: string[] = [];
  s = s.replace(/```([\s\S]+?)```/g, (_m, c: string) => {
    blocks.push(`<pre>${c.trim()}</pre>`);
    return `${CODE_PLACEHOLDER}${blocks.length - 1}${CODE_PLACEHOLDER}`;
  });
  const inlines: string[] = [];
  s = s.replace(/`([^`\n]+?)`/g, (_m, c: string) => {
    inlines.push(`<code>${c}</code>`);
    return `${INLINE_CODE_PLACEHOLDER}${inlines.length - 1}${INLINE_CODE_PLACEHOLDER}`;
  });

  // Traitement ligne par ligne : titres, citations, listes.
  const lines = s.split('\n').map((line) => {
    const block = blockLine(line);
    return block ?? inlineMd(line);
  });
  const wrapped = wrapLists(lines);

  // Joindre : les lignes inline reçoivent <br>, les blocs (déjà en bloc) non.
  let out = wrapped
    .map((line) => (
      line.startsWith('<h') || line.startsWith('<blockquote')
      || line.startsWith('<ul') || line.startsWith('</ul')
      || line.startsWith('<li')
        ? line
        : line
    ))
    .join('\n');

  // Newlines hors blocs → <br>.
  out = out.replace(/\n(?!<\/?(h\d|blockquote|ul|li))/g, '<br>');

  // Ré-injecte les blocs et code inline.
  out = out.replace(
    new RegExp(`${CODE_PLACEHOLDER}(\\d+)${CODE_PLACEHOLDER}`, 'g'),
    (_m, i: string) => blocks[Number(i)] ?? '',
  );
  out = out.replace(
    new RegExp(`${INLINE_CODE_PLACEHOLDER}(\\d+)${INLINE_CODE_PLACEHOLDER}`, 'g'),
    (_m, i: string) => inlines[Number(i)] ?? '',
  );
  return out;
}
