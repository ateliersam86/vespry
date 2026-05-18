/**
 * Planificateur d'export récurrent — Phase 3.
 *
 * Permet à l'utilisateur de programmer un export incrémental d'un serveur
 * Discord à fréquence régulière (quotidienne ou hebdomadaire), à une heure
 * UTC donnée. Implémentation via `chrome.alarms` côté service worker.
 *
 * Pourquoi UTC ? L'utilisateur peut voyager / changer de fuseau. Stocker
 * l'heure en UTC évite que l'alarme se décale d'elle-même. La UI affiche
 * l'heure localisée (informatif), mais ce qui est persisté est UTC.
 *
 * État stocké dans `chrome.storage.local` clé `vespry.scheduled`. Un seul
 * planning actif à la fois (simplicité V1) — l'utilisateur choisit UN
 * serveur cible. La fréquence est `'daily'` ou `'weekly'`.
 *
 * Cycle de vie :
 * 1. UI overlay → `saveSchedule(s)` → écrit storage.
 * 2. Service worker observe `chrome.storage.onChanged` → `installAlarmFor(s)`.
 * 3. À l'heure dite, `chrome.alarms.onAlarm` déclenche un export incrémental.
 *
 * Module isolé : aucune dépendance au moteur d'export. Testable sans
 * navigateur ni IndexedDB (logique pure + accès chrome.* mockable).
 */

/** Clé du storage pour le planning unique actif. */
export const SCHEDULE_STORAGE_KEY = 'vespry.scheduled';

/** Nom de l'alarme `chrome.alarms` enregistrée par le service worker. */
export const SCHEDULED_EXPORT_ALARM_NAME = 'vespry-scheduled-export';

/** Fréquence supportée. */
export type ScheduleFrequency = 'daily' | 'weekly';

/**
 * Configuration d'un export récurrent. `guildName` est dénormalisé (cache
 * local) pour pouvoir afficher le nom dans la UI même quand l'offscreen
 * n'a pas encore rechargé la liste des serveurs.
 *
 * `hourUtc` : 0..23. Pour un planning hebdomadaire, l'export tombe sur le
 * MÊME jour de la semaine que le moment où l'utilisateur a sauvegardé —
 * géré par `chrome.alarms` qui réveille toutes les 7 × 24 × 60 = 10080
 * minutes après la première occurrence.
 */
export interface ScheduledExport {
  guildId: string;
  guildName: string;
  frequency: ScheduleFrequency;
  /** Heure UTC, 0..23. */
  hourUtc: number;
}

/** Valide la forme d'un payload lu depuis storage (corruption-safe). */
export function isScheduledExport(v: unknown): v is ScheduledExport {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.guildId === 'string'
    && o.guildId.length > 0
    && typeof o.guildName === 'string'
    && (o.frequency === 'daily' || o.frequency === 'weekly')
    && typeof o.hourUtc === 'number'
    && Number.isInteger(o.hourUtc)
    && o.hourUtc >= 0
    && o.hourUtc <= 23
  );
}

/**
 * Interface minimale `chrome.storage.local` utilisée par ce module —
 * permet de mocker en test sans dépendre de `@types/chrome` runtime.
 */
export interface StorageLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/**
 * Interface minimale `chrome.alarms` utilisée par ce module.
 */
export interface AlarmsLike {
  create(name: string, info: { when?: number; periodInMinutes?: number }): void;
  clear(name: string): Promise<boolean>;
}

/** Lit le planning courant depuis `chrome.storage.local`. */
export async function loadSchedule(
  storage: StorageLike,
): Promise<ScheduledExport | null> {
  const r = await storage.get(SCHEDULE_STORAGE_KEY);
  const raw = r[SCHEDULE_STORAGE_KEY];
  return isScheduledExport(raw) ? raw : null;
}

/**
 * Écrit le planning dans `chrome.storage.local`. Passer `null` supprime
 * la clé — c'est la voie unique pour désactiver la planification.
 */
export async function saveSchedule(
  storage: StorageLike,
  schedule: ScheduledExport | null,
): Promise<void> {
  if (schedule === null) {
    await storage.remove(SCHEDULE_STORAGE_KEY);
    return;
  }
  if (!isScheduledExport(schedule)) {
    throw new Error('saveSchedule : payload invalide');
  }
  await storage.set({ [SCHEDULE_STORAGE_KEY]: schedule });
}

/**
 * Calcule l'horodatage (`Date.now()`-compatible, ms epoch) de la PROCHAINE
 * occurrence de l'alarme pour un planning donné. Si l'heure cible
 * d'aujourd'hui est déjà passée, on programme pour demain (daily) ou
 * dans 7 jours à l'heure dite (weekly).
 *
 * Pure : `now` est injectable, ce qui rend la fonction trivialement
 * déterministe en test.
 */
export function computeNextFireTime(
  schedule: ScheduledExport,
  now: number,
): number {
  const candidate = new Date(now);
  candidate.setUTCMinutes(0, 0, 0);
  candidate.setUTCHours(schedule.hourUtc);
  let next = candidate.getTime();
  if (next <= now) {
    // Heure cible déjà passée aujourd'hui — repousser d'un cycle.
    const dayMs = 24 * 60 * 60 * 1000;
    const cycleDays = schedule.frequency === 'weekly' ? 7 : 1;
    next += cycleDays * dayMs;
  }
  return next;
}

/**
 * (Dé)programme l'alarme `chrome.alarms` selon le planning courant.
 * Passer `null` supprime l'alarme. Sûr à appeler plusieurs fois : Chrome
 * écrase une alarme du même nom à chaque `create()`.
 *
 * `now` injectable pour les tests ; en prod on passe `Date.now()`.
 */
export async function installAlarmFor(
  alarms: AlarmsLike,
  schedule: ScheduledExport | null,
  now: number = Date.now(),
): Promise<void> {
  // On efface systématiquement avant de recréer : si la fréquence change
  // sans changer le nom, `create()` recouvre déjà l'ancienne, mais un
  // `clear()` explicite garantit qu'on passe par un état propre même
  // sur les implémentations qui auraient conservé un periodInMinutes
  // résiduel.
  await alarms.clear(SCHEDULED_EXPORT_ALARM_NAME);
  if (schedule === null) return;

  const when = computeNextFireTime(schedule, now);
  const periodInMinutes = schedule.frequency === 'weekly'
    ? 7 * 24 * 60
    : 24 * 60;
  alarms.create(SCHEDULED_EXPORT_ALARM_NAME, { when, periodInMinutes });
}
