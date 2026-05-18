/**
 * Envoi opt-in d'un rapport de schéma au service Vespry.
 *
 * Strictement minimal — uniquement `{ version, locale, fields[] }`.
 * Pas de jeton, pas de message, pas d'id, pas de stack trace.
 *
 * Stocké dans `chrome.storage.local` (clé `vespry.schemaReport`) :
 *   - `enabled` : opt-in explicite, défaut FALSE.
 *   - `lastSentSig` : signature du dernier rapport envoyé pour éviter
 *     le bombardement (un rapport au plus par exécution avec les MÊMES
 *     champs inconnus).
 */
import { getVersion } from '../version';
import { getDetectedUnknowns } from './schema-watch';

const STORAGE_KEY = 'vespry.schemaReport';
interface StoredState {
  enabled: boolean;
  lastSentSig?: string;
}

async function readState(): Promise<StoredState> {
  const all = await chrome.storage.local.get(STORAGE_KEY);
  const s = all[STORAGE_KEY] as StoredState | undefined;
  return s ?? { enabled: false };
}

async function writeState(state: StoredState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

/** Lit l'état actuel de l'opt-in. Défaut : désactivé. */
export async function isSchemaReportEnabled(): Promise<boolean> {
  return (await readState()).enabled;
}

/** Bascule l'opt-in. Si désactivé, on oublie aussi la dernière signature. */
export async function setSchemaReportEnabled(enabled: boolean): Promise<void> {
  const prev = await readState();
  await writeState(enabled ? { ...prev, enabled: true } : { enabled: false });
}

/** Signature locale = champs triés joints — pour ne pas réémettre la même. */
function localSignature(fields: string[]): string {
  return [...fields].sort().join(',');
}

/**
 * Envoie un rapport si l'opt-in est ON et qu'il y a des champs nouveaux.
 * Idempotent : aucun envoi si rien n'a changé depuis le dernier rapport.
 * Ne lève jamais — un échec réseau est silencieux.
 */
export async function maybeSendSchemaReport(apiUrl: string): Promise<void> {
  if (!apiUrl) return;
  const state = await readState();
  if (!state.enabled) return;
  const fields = getDetectedUnknowns();
  if (fields.length === 0) return;
  const sig = localSignature(fields);
  if (state.lastSentSig === sig) return;
  try {
    await fetch(`${apiUrl.replace(/\/+$/, '')}/schema-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: getVersion(),
        locale: (navigator.language || 'en').slice(0, 8),
        fields,
      }),
    });
    await writeState({ ...state, lastSentSig: sig });
  } catch {
    /* échec réseau — sans gravité, on retentera plus tard */
  }
}
