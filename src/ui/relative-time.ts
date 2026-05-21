/**
 * Helpers de formatage temporel relatif (« dans 3h », « il y a 2j »).
 *
 * Extrait depuis `src/popup/popup.tsx` pour être réutilisable par l'overlay
 * (section Planification, affichage du dernier export incrémental, etc.).
 *
 * Les clés i18n `time.in_*` / `time.ago_*` sont définies dans tous les
 * locales `src/locales/*.json`.
 */
import { t } from './i18n';

/** « dans 3 h », « dans 2 j » — résolution adaptée à l'échelle. */
export function formatRelativeFuture(target: number, now: number): string {
  const sec = Math.max(0, Math.round((target - now) / 1000));
  if (sec < 60) return t('time.in_seconds', { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t('time.in_minutes', { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t('time.in_hours', { n: h });
  const d = Math.round(h / 24);
  return t('time.in_days', { n: d });
}

/** « il y a 3 h », « il y a 2 j » — symétrique de `formatRelativeFuture`. */
export function formatRelativePast(target: number, now: number): string {
  const sec = Math.max(0, Math.round((now - target) / 1000));
  if (sec < 60) return t('time.ago_seconds', { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t('time.ago_minutes', { n: min });
  const h = Math.round(min / 60);
  if (h < 48) return t('time.ago_hours', { n: h });
  const d = Math.round(h / 24);
  return t('time.ago_days', { n: d });
}
