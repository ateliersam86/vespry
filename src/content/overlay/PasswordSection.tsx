/**
 * Section « Mot de passe du zip » du mode Avancé (Phase 4 — chiffrement AES).
 *
 * Le mot de passe :
 *
 * - ne transite QUE le temps d'un export ; aucun stockage `chrome.storage` ni
 *   cookie. État local React, propagé à `enqueue()` au clic « Lancer », jeté
 *   à la fin du run par le moteur (en RAM dans `run.options.zipPassword`,
 *   IndexedDB le temps du run uniquement).
 * - chiffre le zip en AES-256 via `encryptZipBlob` côté packager. Le zip
 *   généré reste lisible par 7-Zip / Keka / WinRAR avec le mot de passe.
 * - n'est PAS récupérable. Si l'utilisateur l'oublie, le zip est perdu —
 *   message explicite affiché à côté du champ.
 *
 * Composant isolé (pattern ScheduleSection / PurgeModal / FilenameTemplate)
 * pour éviter les conflits sur Overlay.tsx avec les autres chantiers.
 */
import { useState } from 'preact/hooks';
import { estimatePasswordStrength, type PasswordStrength } from '../../engine/encrypt-zip';
import { t } from '../../ui/i18n';
import { HelpTip } from '../../ui/HelpTip';

interface Props {
  /** Mot de passe courant (état remonté côté Overlay pour passer à enqueue). */
  password: string;
  /** Notifie la nouvelle valeur. */
  onChange: (value: string) => void;
}

/** Couleur / classe CSS pour chaque niveau de force. */
const STRENGTH_CLASS: Record<PasswordStrength, string> = {
  empty: 'v-pw-strength v-pw-empty',
  weak: 'v-pw-strength v-pw-weak',
  medium: 'v-pw-strength v-pw-medium',
  strong: 'v-pw-strength v-pw-strong',
};

export function PasswordSection({ password, onChange }: Props): preact.JSX.Element {
  const [visible, setVisible] = useState(false);
  const strength = estimatePasswordStrength(password);
  const enabled = password.length > 0;

  return (
    <div class="v-field">
      <label class="v-pw-head">
        <span>
          {t('password.label')}
          <HelpTip text={t('tip.encryption')} />
        </span>
        {/* Signal visuel clair : tant que le champ est vide → l'archive
            sortira EN CLAIR. Dès qu'au moins 1 char est saisi → le badge
            « 🔒 Chiffrement activé » apparaît côté droit du label.
            Sam (2026-05-19) : « ça n'active pas le chiffrement » — en
            fait si, mais l'utilisateur ne le voyait pas. */}
        <span class={`v-pw-status ${enabled ? 'on' : ''}`}>
          {enabled ? `🔒 ${t('password.status_on')}` : t('password.status_off')}
        </span>
      </label>
      {/* Wrapper position:relative pour positionner le toggle œil
          absolument à l'intérieur du champ (pattern classique input+icon). */}
      <div class="v-pw-row">
        <input
          class="v-input v-pw-input"
          type={visible ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder={t('password.placeholder')}
          value={password}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
        <button
          type="button"
          class="v-pw-toggle"
          onClick={() => setVisible((v) => !v)}
          title={visible ? t('password.hide') : t('password.show')}
          aria-label={visible ? t('password.hide') : t('password.show')}
        >
          {visible ? '🙈' : '👁'}
        </button>
      </div>
      {/* Jauge de force — visible uniquement quand l'utilisateur tape ;
          inutile de l'afficher quand le chiffrement n'est pas demandé. */}
      {enabled && (
        <div class={STRENGTH_CLASS[strength]}>
          <div class="v-pw-bar" />
          <span class="v-pw-label">{t(`password.strength_${strength}`)}</span>
        </div>
      )}
      <div class="v-help">{t('password.help')}</div>
    </div>
  );
}
