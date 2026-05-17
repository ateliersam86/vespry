/**
 * Mur des soutiens — contrat client.
 *
 * Le service `vespry-donors` (Cloudflare Worker, dossier `donor-service/`)
 * ingère les webhooks Ko-Fi et GitHub Sponsors et expose `GET /donors`.
 * Ce module définit la forme du flux et le récupère.
 *
 * IMPORTANT : le fetch DOIT se faire depuis l'offscreen — la CSP de
 * discord.com bloque tout fetch tiers depuis le contexte de la page.
 *
 * Ce contrat doit rester aligné sur `donor-service/src/donors.ts`.
 */

export interface Donor {
  /** Numéro de soutien séquentiel — pilote les paliers. */
  seq: number;
  source: 'kofi' | 'github' | 'stripe';
  /** Nom affiché, ou null si le donateur a choisi l'anonymat. */
  name: string | null;
  /** Petit mot modéré, ou null. */
  message: string | null;
  /** Epoch millisecondes. */
  createdAt: number;
  /** Clé i18n de palier (`m.first`, …) si ce soutien est un palier. */
  milestone: string | null;
}

export interface DonorFeed {
  /** Nombre total de soutiens. */
  total: number;
  /** Les ~30 soutiens les plus récents, du plus récent au plus ancien. */
  recent: Donor[];
  /** Prochain palier à atteindre, ou null si tous franchis. */
  nextMilestone: { key: string; seq: number; remaining: number } | null;
}

/**
 * Récupère le flux des soutiens depuis le Worker.
 * Ne lève jamais — renvoie null si l'URL est vide ou le service indisponible
 * (le footer bascule alors sur un état dégradé, jamais d'erreur visible).
 */
export async function fetchDonorFeed(apiUrl: string): Promise<DonorFeed | null> {
  if (!apiUrl) return null;
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/donors`, {
      cache: 'no-cache',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<DonorFeed>;
    return {
      total: typeof data.total === 'number' ? data.total : 0,
      recent: Array.isArray(data.recent) ? data.recent : [],
      nextMilestone: data.nextMilestone ?? null,
    };
  } catch {
    return null;
  }
}

/** Paramètres d'un don à régler par Stripe Checkout. */
export interface CheckoutRequest {
  /** Montant du don, en centimes. */
  amountCents: number;
  /** Nom à afficher sur le mur, ou null (anonyme). */
  donorName: string | null;
  /** Petit mot, ou null. */
  message: string | null;
  /** Le donateur accepte d'apparaître publiquement. */
  isPublic: boolean;
}

/**
 * Demande au Worker une session Stripe Checkout et renvoie son URL de
 * paiement. Ne lève jamais — null si le service est indisponible.
 */
export async function createCheckout(
  apiUrl: string,
  req: CheckoutRequest,
): Promise<string | null> {
  if (!apiUrl) return null;
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { url?: unknown };
    return typeof data.url === 'string' ? data.url : null;
  } catch {
    return null;
  }
}
