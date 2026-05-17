/**
 * Paliers de soutien — la mécanique de motivation du mur.
 *
 * Chaque palier est un numéro de soutien remarquable (le 1er, le 10e…). Le
 * Worker renvoie une *clé* i18n ; l'extension la traduit (cf. `m.*` dans
 * `src/ui/i18n.ts`). Le Worker ne connaît aucun libellé — séparation nette
 * entre logique et présentation.
 */

export interface Tier {
  /** Numéro de soutien qui décroche ce palier. */
  seq: number;
  /** Clé i18n du nom de palier. */
  key: string;
}

/** Paliers, par ordre croissant. Resserrés au début pour rester atteignables. */
export const TIERS: readonly Tier[] = [
  { seq: 1, key: 'm.first' },
  { seq: 10, key: 'm.ten' },
  { seq: 25, key: 'm.twentyfive' },
  { seq: 50, key: 'm.fifty' },
  { seq: 100, key: 'm.hundred' },
  { seq: 250, key: 'm.twofifty' },
  { seq: 500, key: 'm.fivehundred' },
  { seq: 1000, key: 'm.thousand' },
];

/** Clé de palier si `seq` tombe pile sur un palier, sinon null. */
export function milestoneFor(seq: number): string | null {
  return TIERS.find((t) => t.seq === seq)?.key ?? null;
}

/**
 * Prochain palier après `total` soutiens visibles — alimente l'accroche
 * « plus que N avant … ». Null si tous les paliers sont franchis.
 */
export function nextMilestone(
  total: number,
): { key: string; seq: number; remaining: number } | null {
  const next = TIERS.find((t) => t.seq > total);
  if (!next) return null;
  return { key: next.key, seq: next.seq, remaining: next.seq - total };
}
