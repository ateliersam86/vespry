/**
 * Réinitialisation complète de Vespry.
 *
 * Purge tout ce que Vespry stocke localement :
 *   - IndexedDB `vespry` (checkpoints, runs, channels, messages, assets)
 *   - `chrome.storage.local` (préférences, planning, tuto, jeton capté,
 *     historique d'exports, etc.)
 *
 * Ne touche pas au jeton Discord lui-même (qui vit côté Discord, dans
 * leurs cookies/localStorage — pas dans notre périmètre). Si Vespry
 * avait captée un jeton en chrome.storage.local, il est purgé : la
 * prochaine action sur Discord re-capturera le jeton via le bridge.
 *
 * Idempotent : ré-exécutable sans erreur, même si IDB n'existe pas.
 * Renvoie un détail textuel des actions effectuées, utile pour un toast.
 */

const DB_NAME = 'vespry';
const BLOCKED_TIMEOUT_MS = 6000;

export interface ResetResult {
  /** True si tout a réussi sans réserve. */
  ok: boolean;
  /**
   * `blocked` : IDB n'a pas pu être supprimée parce qu'une connexion
   * (offscreen) la tenait. La suppression se fera quand cette connexion
   * sera close, mais on ne peut pas le garantir au moment du retour.
   */
  blocked?: boolean;
  /** Court récap pour le toast / l'UI. */
  summary: string;
}

export async function resetAllVespryData(): Promise<ResetResult> {
  const messages: string[] = [];
  let ok = true;
  let blocked = false;

  // 1) IndexedDB. `blocked` arrive quand une autre connexion (offscreen)
  // tient la base. On ne peut PAS attendre indéfiniment (l'UI bloquerait)
  // mais on ne peut pas non plus mentir et dire que c'est purgé. On
  // retourne `blocked: true` pour que le popup affiche un message
  // honnête « historique en cours d'effacement, recharge l'onglet
  // Discord pour finaliser ». Cf. audit Codex 2026-05-22 #2.
  try {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      const timer = setTimeout(() => {
        blocked = true;
        resolve();
      }, BLOCKED_TIMEOUT_MS);
      req.onsuccess = () => { clearTimeout(timer); resolve(); };
      req.onerror = () => { clearTimeout(timer); reject(req.error ?? new Error('deleteDatabase a échoué')); };
      req.onblocked = () => {
        // On ne résout pas tout de suite : la base peut encore se débloquer
        // si l'autre connexion se ferme. Le timeout ci-dessus tranche.
        blocked = true;
      };
    });
    messages.push(blocked
      ? 'historique : effacement en cours (recharge Discord pour finaliser)'
      : 'historique d\'exports purgé');
  } catch (e) {
    ok = false;
    messages.push(`IndexedDB : ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) chrome.storage.local — on efface UNIQUEMENT les clés au préfixe
  // canonique `vespry.` plus la clé legacy `vespryToken`. La clé `token`
  // générique (présente dans l'ancienne version) est retirée pour ne pas
  // toucher à des données potentiellement non-Vespry. Cf. audit Codex
  // 2026-05-22 #8.
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) =>
      k.startsWith('vespry.') || k === 'vespryToken');
    if (keys.length > 0) {
      await chrome.storage.local.remove(keys);
    }
    messages.push(`${keys.length} préférences supprimées`);
  } catch (e) {
    ok = false;
    messages.push(`chrome.storage : ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    ok,
    ...(blocked ? { blocked: true } : {}),
    summary: messages.join(' · '),
  };
}
