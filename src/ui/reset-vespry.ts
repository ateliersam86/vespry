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

export interface ResetResult {
  /** True si tout a réussi. False si au moins une action a échoué (détail ci-dessous). */
  ok: boolean;
  /** Court récap pour le toast / l'UI. */
  summary: string;
}

export async function resetAllVespryData(): Promise<ResetResult> {
  const messages: string[] = [];
  let ok = true;

  // 1) IndexedDB
  try {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('deleteDatabase a échoué'));
      // `blocked` se produit si une autre connexion (offscreen) tient la
      // base. On résout quand même : la suppression se fera dès que toutes
      // les connexions seront closes (Chrome MV3 recycle vite).
      req.onblocked = () => resolve();
    });
    messages.push('historique d\'exports purgé');
  } catch (e) {
    ok = false;
    messages.push(`IndexedDB : ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) chrome.storage.local — clé par clé pour rester sûr. On efface tout
  // ce qui commence par `vespry.` (préférences, planning, flags tuto)
  // et aussi le jeton capté s'il a été stocké côté Vespry.
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) =>
      k.startsWith('vespry.') || k === 'vespryToken' || k === 'token');
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
    summary: messages.join(' · '),
  };
}
