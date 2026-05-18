/**
 * i18n — système de traduction de Vespry.
 *
 * `t(key, params)` traduit une clé dans la langue détectée. La langue suit
 * `navigator.language` ; toute langue inconnue retombe sur l'anglais.
 *
 * Les chaînes vivent dans `src/locales/<lang>.json` — un fichier par langue.
 * EN est la source ; les autres sont gérées via Crowdin (voir crowdin.yml et
 * la section « Traductions » du README). Ajouter une langue = ajouter le
 * code à `Locale`, importer son fichier JSON et l'enregistrer dans
 * `DICTIONARIES`.
 */
import en from '../locales/en.json';
import fr from '../locales/fr.json';
import it from '../locales/it.json';
import es from '../locales/es.json';
import de from '../locales/de.json';
import pt from '../locales/pt.json';
import ru from '../locales/ru.json';
import ja from '../locales/ja.json';
import ko from '../locales/ko.json';
import zh from '../locales/zh.json';
import tr from '../locales/tr.json';
import pl from '../locales/pl.json';
import nl from '../locales/nl.json';
import fi from '../locales/fi.json';
import hi from '../locales/hi.json';

export type Locale =
  | 'fr' | 'en' | 'it' | 'es' | 'de' | 'pt' | 'ru'
  | 'ja' | 'ko' | 'zh' | 'tr' | 'pl' | 'nl' | 'fi' | 'hi';

type Dict = Record<string, string>;

const DICTIONARIES: Record<Locale, Dict> = {
  en, fr, it, es, de, pt, ru, ja, ko, zh, tr, pl, nl, fi, hi,
};

function detectLocale(): Locale {
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return lang in DICTIONARIES ? (lang as Locale) : 'en';
}

const locale: Locale = detectLocale();

/** Traduit une clé. `params` interpole les jetons `{nom}`. */
export function t(key: string, params?: Record<string, string | number>): string {
  const template = DICTIONARIES[locale][key] ?? en[key as keyof typeof en] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

export function currentLocale(): Locale {
  return locale;
}
