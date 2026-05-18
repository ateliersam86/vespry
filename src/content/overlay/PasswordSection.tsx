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

  return (
    <div class="v-field">
      <label>{t('password.label')}</label>
      <div class="v-pw-row">
        <input
          class="v-input v-pw-input"
          type={visible ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder={t('password.placeholder')}
          value={password}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
        <span
          class="v-mchip v-pw-toggle"
          onClick={() => setVisible((v) => !v)}
          title={visible ? t('password.hide') : t('password.show')}
        >
          {visible ? '🙈' : '👁'}
        </span>
      </div>
      <div class={STRENGTH_CLASS[strength]}>
        <div class="v-pw-bar" />
        <span class="v-pw-label">{t(`password.strength_${strength}`)}</span>
      </div>
      <div class="v-help">{t('password.help')}</div>
    </div>
  );
}
