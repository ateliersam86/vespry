/**
 * Accès D1 du mur des soutiens + forme du flux exposé.
 *
 * CONTRAT `GET /donors` — `DonorFeed`. L'extension a une copie de ce contrat
 * dans `src/donors.ts` ; les deux doivent rester alignés.
 */
import { milestoneFor, nextMilestone } from './milestones';

/** Canal d'origine d'un soutien. */
export type DonorSource = 'kofi' | 'github' | 'stripe';

/** Normalise une valeur de colonne `source` en `DonorSource`. */
function toSource(s: string): DonorSource {
  return s === 'github' || s === 'stripe' ? s : 'kofi';
}

export interface Donor {
  /** Numéro de soutien séquentiel. */
  seq: number;
  source: DonorSource;
  /** Nom affiché, null si anonyme. */
  name: string | null;
  /** Petit mot modéré, null si absent. */
  message: string | null;
  /** Epoch millisecondes. */
  createdAt: number;
  /** Clé i18n de palier si ce soutien est un palier, sinon null. */
  milestone: string | null;
}

export interface DonorFeed {
  /** Nombre total de soutiens visibles. */
  total: number;
  /** Les ~30 soutiens les plus récents, du plus récent au plus ancien. */
  recent: Donor[];
  /** Prochain palier à atteindre, ou null si tous franchis. */
  nextMilestone: { key: string; seq: number; remaining: number } | null;
}

/** Une nouvelle entrée à insérer (issue d'un webhook). */
export interface NewDonor {
  source: DonorSource;
  externalId: string;
  name: string | null;
  message: string | null;
  isPublic: boolean;
  createdAt: number;
}

/**
 * Insère un soutien. `INSERT OR IGNORE` sur `external_id` UNIQUE → idempotent :
 * un rejeu de webhook (Ko-Fi réessaie) ne crée jamais de doublon.
 */
export async function insertDonor(db: D1Database, d: NewDonor): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO donors
         (source, external_id, name, message, is_public, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(d.source, d.externalId, d.name, d.message, d.isPublic ? 1 : 0, d.createdAt)
    .run();
}

interface DonorRow {
  seq: number;
  source: string;
  name: string | null;
  message: string | null;
  created_at: number;
}

/** Construit le flux public des soutiens. */
export async function getFeed(db: D1Database): Promise<DonorFeed> {
  const totalRow = await db
    .prepare('SELECT COUNT(*) AS n FROM donors WHERE hidden = 0')
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const res = await db
    .prepare(
      `SELECT seq, source, name, message, created_at FROM donors
       WHERE hidden = 0 ORDER BY created_at DESC LIMIT 30`,
    )
    .all<DonorRow>();

  const recent: Donor[] = (res.results ?? []).map((r) => ({
    seq: r.seq,
    source: toSource(r.source),
    name: r.name,
    message: r.message,
    createdAt: r.created_at,
    milestone: milestoneFor(r.seq),
  }));

  return { total, recent, nextMilestone: nextMilestone(total) };
}

/** Masque une entrée (modération manuelle). */
export async function hideDonor(db: D1Database, seq: number): Promise<void> {
  await db.prepare('UPDATE donors SET hidden = 1 WHERE seq = ?').bind(seq).run();
}

/** Liste complète, masqués inclus — pour l'écran d'administration. */
export async function listAll(db: D1Database): Promise<unknown[]> {
  const res = await db
    .prepare('SELECT * FROM donors ORDER BY seq DESC')
    .all();
  return res.results ?? [];
}
