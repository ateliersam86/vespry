/**
 * Profil de performance adaptatif — détecte la machine et retourne un mode
 * d'exécution pour le moteur d'export (taille de buffer, parallélisme salons).
 *
 * Pourquoi. Vespry tournait jusqu'ici en chargeant tous les messages d'un salon
 * en RAM avant écriture. Inacceptable sur les gros serveurs avec une machine
 * faible (RAM ≤ 2 Go). Mais une machine puissante (8 cœurs, 8 Go+) peut largement
 * mieux que le strict streaming. On adapte au lieu de forcer un mode unique.
 *
 * Trois profils :
 *
 * | Profil     | Critère                          | Buffer messages/page | Salons // |
 * |------------|----------------------------------|----------------------|-----------|
 * | `fast`     | RAM ≥ 8 Go ET cores ≥ 8          | 1000                 | 3         |
 * | `balanced` | défaut                           | 250                  | 2         |
 * | `low`      | RAM ≤ 2 Go OU heap ≤ 512 Mo      | 0 (streaming pur)    | 1         |
 *
 * Cap dur : `parallelChannels` ne dépasse JAMAIS 3 — au-delà Discord throttle
 * (rate-limit `getMessages` ~50 req/s gracieux). La machine puissante gagne sur
 * le packaging et la sérialisation, pas sur l'API.
 *
 * Module isolé : aucun import d'autre fichier Vespry. Testable sans navigateur
 * (mocks des globals via `Object.defineProperty`).
 */

/** Identifiant des trois profils possibles. */
export type PerfProfileTier = 'fast' | 'balanced' | 'low';

/**
 * Profil retourné par `detectPerfProfile()`. Toutes les valeurs sont des
 * nombres entiers prêts à l'emploi — pas de fonction à appeler côté consommateur.
 */
export interface PerfProfile {
  /** Niveau de performance détecté. */
  readonly tier: PerfProfileTier;
  /**
   * Taille de buffer (en nombre de messages) pour les exporteurs streamés.
   *
   * - `fast`     : 1000 — gros chunks, écritures rares.
   * - `balanced` : 250  — équilibre RAM/débit.
   * - `low`      : 0    — streaming pur, on flush dès qu'un message sort du
   *                       curseur IndexedDB (pas d'accumulation).
   */
  readonly bufferMessagesPerPage: number;
  /**
   * Nombre de salons traités en parallèle par le runner d'export.
   * Capé à 3 quel que soit le profil (rate-limit Discord).
   */
  readonly parallelChannels: 1 | 2 | 3;
  /**
   * `true` quand le profil exige de ne JAMAIS charger un salon entier en RAM.
   * Sur `fast` on peut garder le mode bulk historique (plus rapide) ; sur
   * `balanced` et `low` on streame.
   */
  readonly streaming: boolean;
}

/** Cap absolu de concurrence salons — rate-limit Discord. */
const MAX_PARALLEL_CHANNELS = 3;

/**
 * Signaux bruts collectés depuis les API navigateur. Exposé pour faciliter le
 * test (on peut injecter des signaux fabriqués au lieu de mocker les globals)
 * mais en production on appelle `detectPerfProfile()` sans argument.
 */
export interface PerfSignals {
  /** `navigator.hardwareConcurrency` — nombre de cœurs CPU logiques. */
  readonly hardwareConcurrency: number | undefined;
  /**
   * `navigator.deviceMemory` — RAM approximative en Go, paliers
   * 0.25 / 0.5 / 1 / 2 / 4 / 8. Non disponible sur Firefox.
   */
  readonly deviceMemoryGb: number | undefined;
  /**
   * `performance.memory.jsHeapSizeLimit` — limite de heap V8 en octets.
   * Chromium uniquement. Permet de détecter une machine très contrainte
   * (~ 512 Mo de heap = on bascule en streaming pur).
   */
  readonly jsHeapSizeLimit: number | undefined;
}

/**
 * Lit les signaux disponibles sur l'environnement courant. Tous les accès sont
 * défensifs — chaque API peut manquer (Firefox, Safari, contextes worker).
 */
export function collectPerfSignals(): PerfSignals {
  // `navigator` n'existe pas en service worker classique ni en Node : on garde
  // tout dans des try/catch implicites via accès optionnels.
  const nav: Navigator | undefined =
    typeof navigator === 'undefined' ? undefined : navigator;

  const hardwareConcurrency =
    typeof nav?.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0
      ? nav.hardwareConcurrency
      : undefined;

  // `deviceMemory` est une extension non standard (Chromium + WebKit récents,
  // pas Firefox). Le type TS ne la connaît pas — accès via cast structuré.
  const navWithMemory = nav as
    | (Navigator & { deviceMemory?: number })
    | undefined;
  const deviceMemoryGb =
    typeof navWithMemory?.deviceMemory === 'number' &&
    navWithMemory.deviceMemory > 0
      ? navWithMemory.deviceMemory
      : undefined;

  // `performance.memory` est Chromium-only et non standard. Même approche.
  const perf =
    typeof performance === 'undefined'
      ? undefined
      : (performance as Performance & {
          memory?: { jsHeapSizeLimit?: number };
        });
  const jsHeapSizeLimit =
    typeof perf?.memory?.jsHeapSizeLimit === 'number' &&
    perf.memory.jsHeapSizeLimit > 0
      ? perf.memory.jsHeapSizeLimit
      : undefined;

  return { hardwareConcurrency, deviceMemoryGb, jsHeapSizeLimit };
}

/** 512 Mo en octets — seuil heap V8 sous lequel on bascule `low`. */
const LOW_HEAP_LIMIT_BYTES = 512 * 1024 * 1024;

/**
 * Classe les signaux en tier. Pure et déterministe — c'est le cœur testable.
 *
 * Règles, dans cet ordre :
 * 1. RAM ≤ 2 Go OU heap ≤ 512 Mo → `low` (priorité absolue : on protège la
 *    machine contrainte avant tout).
 * 2. RAM ≥ 8 Go ET cores ≥ 8 → `fast`.
 * 3. Sinon → `balanced` (cas par défaut, y compris signaux absents).
 */
export function classifySignals(signals: PerfSignals): PerfProfileTier {
  const { hardwareConcurrency, deviceMemoryGb, jsHeapSizeLimit } = signals;

  // Règle 1 — contrainte mémoire forte. On évalue avec ce qu'on a : si
  // `deviceMemoryGb` est défini ET ≤ 2, ou si le heap V8 est ≤ 512 Mo, on
  // considère la machine comme low. Pas de fallback "≤ 2 Go par défaut" :
  // l'absence de signal ne doit pas dégrader vers low (Firefox n'expose pas
  // `deviceMemory` et tournerait toujours en streaming pur sinon).
  if (deviceMemoryGb !== undefined && deviceMemoryGb <= 2) return 'low';
  if (jsHeapSizeLimit !== undefined && jsHeapSizeLimit <= LOW_HEAP_LIMIT_BYTES)
    return 'low';

  // Règle 2 — machine puissante. Il faut LES DEUX signaux et qu'ils soient
  // bons. Cores seuls ne suffisent pas (un mobile avec 8 cœurs et 3 Go n'est
  // pas une machine de bureau).
  if (
    deviceMemoryGb !== undefined &&
    deviceMemoryGb >= 8 &&
    hardwareConcurrency !== undefined &&
    hardwareConcurrency >= 8
  ) {
    return 'fast';
  }

  // Règle 3 — défaut.
  return 'balanced';
}

/**
 * Traduit un tier en profil opérationnel. Pure : aucun accès aux globals.
 */
export function profileForTier(tier: PerfProfileTier): PerfProfile {
  switch (tier) {
    case 'fast':
      return {
        tier: 'fast',
        bufferMessagesPerPage: 1000,
        parallelChannels: clampParallel(3),
        streaming: false,
      };
    case 'low':
      return {
        tier: 'low',
        bufferMessagesPerPage: 0,
        parallelChannels: clampParallel(1),
        streaming: true,
      };
    case 'balanced':
    default:
      return {
        tier: 'balanced',
        bufferMessagesPerPage: 250,
        parallelChannels: clampParallel(2),
        streaming: true,
      };
  }
}

/**
 * Force la concurrence salons dans `[1, MAX_PARALLEL_CHANNELS]`. Exporté pour
 * que les consommateurs (settings utilisateur, override de debug) appliquent la
 * même borne — pas pour les besoins internes de ce module qui passe déjà des
 * littéraux 1/2/3.
 */
export function clampParallel(n: number): 1 | 2 | 3 {
  if (!Number.isFinite(n) || n <= 1) return 1;
  if (n >= MAX_PARALLEL_CHANNELS) return 3;
  return 2;
}

/**
 * Point d'entrée principal : détecte le profil de la machine courante.
 * Sans argument, on collecte les signaux automatiquement. Pour les tests on
 * peut passer des signaux pré-construits.
 */
export function detectPerfProfile(signals?: PerfSignals): PerfProfile {
  const s = signals ?? collectPerfSignals();
  const tier = classifySignals(s);
  return profileForTier(tier);
}
