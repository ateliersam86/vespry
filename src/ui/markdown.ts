/**
 * Rendu sûr du markdown Discord — partagé entre l'aperçu (Preact) et les
 * exporteurs (chaîne HTML pour le fichier exporté).
 *
 * Pipeline : `humanize` (remplace les balises Discord brutes par du texte
 * lisible) → `esc` (échappe le HTML) → markdown minimal (gras, italique,
 * code, barré, liens) → `<br>` pour les sauts de ligne.
 *
 * L'ordre `esc → markdown` est crucial : on échappe AVANT d'introduire les
 * balises de markdown, donc aucun HTML utilisateur ne peut s'injecter.
 */

/** Étiquettes de mentions Discord, traduites — `@membre`, `@rôle`, `#salon`. */
export interface MentionLabels {
  user: string;
  role: string;
  channel: string;
}

/** Remplace les balises Discord brutes par du texte lisible (mentions, emojis custom). */
export function humanize(text: string, mentions: MentionLabels): string {
  return text
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<@!?\d+>/g, mentions.user)
    .replace(/<@&\d+>/g, mentions.role)
    .replace(/<#\d+>/g, mentions.channel);
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
 * Rend un contenu de message en HTML : humanize → escape → markdown Discord
 * minimal → sauts de ligne. Sortie sûre, utilisable en `dangerouslySetInnerHTML`
 * ou injectée dans une chaîne HTML générée.
 */
export function renderInlineHtml(text: string, mentions: MentionLabels): string {
  let s = escapeHtml(humanize(text, mentions));
  s = s.replace(/```([\s\S]+?)```/g, (_m, c: string) => `<pre>${c.trim()}</pre>`);
  s = s.replace(/`([^`]+?)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+?)~~/g, '<s>$1</s>');
  s = s.replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="noopener">$1</a>');
  return s.replace(/\n/g, '<br>');
}
