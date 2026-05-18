/**
 * Champ « Nom du fichier zip » du mode Avancé (Phase 3).
 *
 * Persiste le template dans `chrome.storage.local` (clé `vespry.zipTemplate`).
 * Affiche un aperçu live du nom final résolu pour le serveur actuellement
 * sélectionné dans l'overlay — l'utilisateur voit immédiatement ce qu'il va
 * obtenir au téléchargement.
 *
 * Composant isolé dans son propre fichier (cohérent avec ScheduleSection /
 * PurgeModal) pour éviter les conflits sur Overlay.tsx.
 */
import { useEffect, useState } from 'preact/hooks';
import {
  DEFAULT_ZIP_TEMPLATE,
  loadZipTemplate,
  renderZipFilename,
  saveZipTemplate,
} from '../../ui/zip-filename';
import { t } from '../../ui/i18n';
import type { RawGuild } from '../../engine/types';

interface Props {
  /** Serveur courant — sert d'aperçu et de fallback pour `{guildName}`. */
  activeGuild: RawGuild | null;
}

export function FilenameTemplateField({ activeGuild }: Props): preact.JSX.Element {
  // État local : le template édité. On le sauvegarde au blur / Enter (pas à
  // chaque keystroke — limite les écritures storage et le bruit visuel).
  const [template, setTemplate] = useState<string>(DEFAULT_ZIP_TEMPLATE);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    void loadZipTemplate(chrome.storage.local).then((stored) => {
      if (stored !== null) setTemplate(stored);
      setHydrated(true);
    });
  }, []);

  function commit(): void {
    if (!hydrated) return;
    const trimmed = template.trim();
    // Vide → on supprime la clé, l'app retombe sur le défaut.
    void saveZipTemplate(
      chrome.storage.local,
      trimmed.length === 0 || trimmed === DEFAULT_ZIP_TEMPLATE ? null : trimmed,
    );
  }

  // Aperçu live — on rend le template avec le guild courant (ou un nom de
  // démonstration si rien n'est sélectionné).
  const preview = renderZipFilename(template, {
    guildName: activeGuild?.name ?? 'MonServeur',
    now: new Date(),
  });

  return (
    <div class="v-field">
      <label>{t('overlay.filename_label')}</label>
      <input
        class="v-input"
        type="text"
        value={template}
        placeholder={DEFAULT_ZIP_TEMPLATE}
        onInput={(e) => setTemplate((e.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <div class="v-help">{t('overlay.filename_help')}</div>
      <div class="v-help v-filename-preview">
        {t('overlay.filename_preview', { name: preview })}
      </div>
    </div>
  );
}
