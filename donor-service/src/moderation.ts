/**
 * Modération des textes libres fournis par les donateurs (nom + message).
 *
 * Un mur des soutiens affiche du contenu saisi par des inconnus : il faut un
 * garde-fou. Approche volontairement simple et conservatrice — en cas de
 * doute, on retire le texte (le soutien reste compté, sans texte affiché).
 * Sam peut masquer une entrée à la main via l'endpoint admin.
 */

export const MAX_NAME = 48;
export const MAX_MESSAGE = 280;

/**
 * Liste de blocage — insultes et termes haineux évidents (FR + EN). Comparée
 * sur du texte normalisé (minuscules, accents retirés). Volontairement courte
 * et factuelle : à étendre selon les signalements.
 */
const BANNED = [
  'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot', 'retard',
  'connard', 'connasse', 'salope', 'pute', 'encule', 'enfoire', 'negre',
  'pede', 'tapette', 'bougnoule',
];

const BANNED_RE = new RegExp(`\\b(${BANNED.join('|')})\\b`, 'i');

/**
 * Minuscules + suppression des diacritiques combinants (é → e), pour une
 * comparaison stable avec une liste de blocage en ASCII.
 */
function normalize(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase().normalize('NFD')) {
    const cp = ch.codePointAt(0) ?? 0;
    // U+0300..U+036F : bloc des diacritiques combinants.
    if (cp >= 0x300 && cp <= 0x36f) continue;
    out += ch;
  }
  return out;
}

/**
 * Nettoie un texte de donateur : compacte les espaces, coupe à `max`.
 * Renvoie null si le texte est vide ou si la liste de blocage matche — dans
 * ce cas l'entrée passe au compteur, mais sans ce texte.
 */
export function cleanText(raw: string | null | undefined, max: number): string | null {
  const text = (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  if (!text) return null;
  if (BANNED_RE.test(normalize(text))) return null;
  return text;
}
