/**
 * Modale de suppression de messages (Phase 2 — purge).
 *
 * Triple garde-fou : ne s'ouvre qu'avec une sélection manuelle ≥ 1 message,
 * affiche le compte et le nom du salon, ET exige que l'utilisateur tape un
 * mot de confirmation (« SUPPRIMER » en FR, « DELETE » en EN — défini par
 * `t('purge.confirm_word')`) avant que le bouton rouge final s'active.
 *
 * Une fois lancée, la modale reste ouverte et affiche la progression issue
 * de `controller.purgeQueue` (qui pousse via le broadcast d'état). À la fin
 * (statut `completed` / `partial` / `failed`), la modale affiche un bandeau
 * et offre un bouton « Fermer ».
 *
 * Composant isolé dans son propre fichier pour éviter les conflits sur
 * `Overlay.tsx` avec les autres chantiers Phase 2/3 en parallèle.
 */
import { useEffect, useState } from 'preact/hooks';
import type { PurgeItemView } from '../../messaging';
import type { RemoteController } from '../../ui/remote-controller';
import type { RawChannel, RawGuild } from '../../engine/types';
import { t } from '../../ui/i18n';

interface Props {
  controller: RemoteController;
  guild: RawGuild;
  channel: RawChannel;
  /** Ids de messages à supprimer (issus de `manualSel`). */
  messageIds: string[];
  /** Fermeture demandée par l'utilisateur (X, Esc, ou bouton Fermer). */
  onClose: () => void;
  /**
   * Notifié quand l'utilisateur valide la purge (= le bouton rouge final
   * vient d'être cliqué). Permet à l'overlay de vider la sélection manuelle
   * concernée pour éviter de re-cibler des messages supprimés.
   */
  onConfirmed: () => void;
}

/** Statut « purge encore active » = `in_progress`. */
function isRunning(p: PurgeItemView | null): boolean {
  return p !== null && p.status === 'in_progress';
}

export function PurgeModal({
  controller, guild, channel, messageIds, onClose, onConfirmed,
}: Props): preact.JSX.Element {
  const confirmWord = t('purge.confirm_word');
  const [typed, setTyped] = useState('');
  const [purgeId, setPurgeId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // L'item de purge actif (s'il existe dans la file). On le pioche par id ;
  // dès que la PurgeQueue diffuse une mise à jour, le composant re-render
  // (Overlay propage déjà le tick via subscribe).
  const item: PurgeItemView | null = purgeId
    ? controller.purgeQueue.find((p) => p.runId === purgeId) ?? null
    : null;

  // Esc ferme la modale tant qu'on n'a pas lancé la purge — après, on bloque
  // pour éviter une fermeture accidentelle en plein milieu.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !isRunning(item)) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [item, onClose]);

  const canConfirm = typed.trim() === confirmWord && !submitting && purgeId === null;
  const total = messageIds.length;

  async function onConfirm(): Promise<void> {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      const id = await controller.purge(guild, channel.id, channel.name ?? channel.id, messageIds);
      if (id) {
        setPurgeId(id);
        onConfirmed();
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Vue progression / bandeau de fin une fois la purge lancée.
  const finished = item !== null && !isRunning(item);

  return (
    <div class="v-modal-bd" onClick={() => !isRunning(item) && onClose()}>
      <div class="v-modal" onClick={(e) => e.stopPropagation()}>
        <div class="v-modal-hd">
          <span class="v-modal-title">{t('purge.modal_title')}</span>
          {!isRunning(item) && (
            <span class="v-modal-x" onClick={onClose}>×</span>
          )}
        </div>

        <div class="v-modal-body">
          {purgeId === null && (
            <>
              <p class="v-modal-warn">
                {t('purge.body', {
                  n: String(total),
                  channel: channel.name ?? channel.id,
                })}
              </p>
              <p class="v-modal-confirm-help">
                {t('purge.confirm_help', { word: confirmWord })}
              </p>
              <input
                class="v-input v-modal-confirm-input"
                type="text"
                value={typed}
                placeholder={confirmWord}
                onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
                autoFocus
              />
            </>
          )}

          {item !== null && (
            <div class="v-purge-progress">
              <div class="v-purge-counts">
                {isRunning(item)
                  ? t('purge.in_progress', {
                      done: String(item.done),
                      total: String(item.total),
                      failed: String(item.failed),
                    })
                  : item.status === 'completed'
                    ? t('purge.done', { n: String(item.done) })
                    : t('purge.partial', {
                        done: String(item.done),
                        failed: String(item.failed),
                      })}
              </div>
              <div class="v-purge-bar">
                <div
                  class="v-purge-bar-fill"
                  style={`width: ${item.total > 0
                    ? Math.min(100, Math.round(((item.done + item.failed) / item.total) * 100))
                    : 0}%`}
                />
              </div>
              {item.log.length > 0 && (
                <pre class="v-purge-log">{item.log.slice(-6).join('\n')}</pre>
              )}
            </div>
          )}
        </div>

        <div class="v-modal-foot">
          {purgeId === null ? (
            <>
              <span class="v-btn v-btn-ghost" onClick={onClose}>
                {t('purge.cancel')}
              </span>
              <span
                class={`v-btn v-btn-danger ${canConfirm ? '' : 'disabled'}`}
                onClick={canConfirm ? () => void onConfirm() : undefined}
              >
                {submitting
                  ? '…'
                  : t('purge.button', { n: String(total) })}
              </span>
            </>
          ) : (
            <span
              class={`v-btn ${finished ? '' : 'disabled'}`}
              onClick={finished ? onClose : undefined}
            >
              {t('purge.close')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
