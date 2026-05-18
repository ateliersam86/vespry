import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_STORAGE_KEY,
  SCHEDULED_EXPORT_ALARM_NAME,
  computeNextFireTime,
  installAlarmFor,
  isScheduledExport,
  loadSchedule,
  saveSchedule,
  type AlarmsLike,
  type ScheduledExport,
  type StorageLike,
} from './scheduler';

/** Storage fake en mémoire — implémente la surface utilisée par `scheduler`. */
function makeStorage(): StorageLike & { dump: () => Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    dump: () => ({ ...data }),
    get: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) {
        if (k in data) out[k] = data[k];
      }
      return out;
    },
    set: async (items) => {
      Object.assign(data, items);
    },
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete data[k];
    },
  };
}

/** Alarms fake — trace `create()` et `clear()` pour les assertions. */
function makeAlarms(): AlarmsLike & {
  created: { name: string; info: { when?: number; periodInMinutes?: number } }[];
  cleared: string[];
} {
  const created: { name: string; info: { when?: number; periodInMinutes?: number } }[] = [];
  const cleared: string[] = [];
  return {
    created,
    cleared,
    create(name, info) {
      created.push({ name, info });
    },
    clear: async (name) => {
      cleared.push(name);
      return true;
    },
  };
}

const ok: ScheduledExport = {
  guildId: '123',
  guildName: 'Serveur Test',
  frequency: 'daily',
  hourUtc: 9,
};

describe('isScheduledExport', () => {
  it('valide une config bien formée', () => {
    expect(isScheduledExport(ok)).toBe(true);
  });

  it('rejette les payloads cassés', () => {
    expect(isScheduledExport(null)).toBe(false);
    expect(isScheduledExport({})).toBe(false);
    expect(isScheduledExport({ ...ok, guildId: '' })).toBe(false);
    expect(isScheduledExport({ ...ok, frequency: 'monthly' })).toBe(false);
    expect(isScheduledExport({ ...ok, hourUtc: 24 })).toBe(false);
    expect(isScheduledExport({ ...ok, hourUtc: -1 })).toBe(false);
    expect(isScheduledExport({ ...ok, hourUtc: 9.5 })).toBe(false);
  });
});

describe('loadSchedule / saveSchedule', () => {
  it('round-trip une config valide via storage', async () => {
    const storage = makeStorage();
    await saveSchedule(storage, ok);
    const got = await loadSchedule(storage);
    expect(got).toEqual(ok);
  });

  it('null supprime la clé', async () => {
    const storage = makeStorage();
    await saveSchedule(storage, ok);
    await saveSchedule(storage, null);
    expect(await loadSchedule(storage)).toBeNull();
    expect(SCHEDULE_STORAGE_KEY in storage.dump()).toBe(false);
  });

  it('payload corrompu en storage → loadSchedule renvoie null', async () => {
    const storage = makeStorage();
    await storage.set({ [SCHEDULE_STORAGE_KEY]: { wrong: 'shape' } });
    expect(await loadSchedule(storage)).toBeNull();
  });

  it('saveSchedule rejette un payload invalide', async () => {
    const storage = makeStorage();
    await expect(
      saveSchedule(storage, { ...ok, hourUtc: 99 } as ScheduledExport),
    ).rejects.toThrow();
  });
});

describe('computeNextFireTime', () => {
  it('heure du jour pas encore atteinte → aujourd\'hui à H UTC', () => {
    // 2026-05-18 04:00 UTC, planning à 9h UTC daily → même jour 9h UTC.
    const now = Date.UTC(2026, 4, 18, 4, 0, 0);
    const expected = Date.UTC(2026, 4, 18, 9, 0, 0);
    expect(computeNextFireTime(ok, now)).toBe(expected);
  });

  it('heure du jour déjà passée (daily) → demain à H UTC', () => {
    // 2026-05-18 15:00 UTC, planning à 9h UTC → demain 9h UTC.
    const now = Date.UTC(2026, 4, 18, 15, 0, 0);
    const expected = Date.UTC(2026, 4, 19, 9, 0, 0);
    expect(computeNextFireTime(ok, now)).toBe(expected);
  });

  it('heure du jour déjà passée (weekly) → dans 7 jours à H UTC', () => {
    const now = Date.UTC(2026, 4, 18, 15, 0, 0);
    const weekly: ScheduledExport = { ...ok, frequency: 'weekly' };
    const expected = Date.UTC(2026, 4, 25, 9, 0, 0);
    expect(computeNextFireTime(weekly, now)).toBe(expected);
  });

  it('heure pile = passée (≤ now) → on repousse d\'un cycle', () => {
    // À la seconde près. now = 9h UTC pile → next = demain (daily).
    const now = Date.UTC(2026, 4, 18, 9, 0, 0);
    const expected = Date.UTC(2026, 4, 19, 9, 0, 0);
    expect(computeNextFireTime(ok, now)).toBe(expected);
  });
});

describe('installAlarmFor', () => {
  it('schedule null → clear et pas de create', async () => {
    const alarms = makeAlarms();
    await installAlarmFor(alarms, null);
    expect(alarms.cleared).toEqual([SCHEDULED_EXPORT_ALARM_NAME]);
    expect(alarms.created).toHaveLength(0);
  });

  it('schedule daily → create avec period 24h', async () => {
    const alarms = makeAlarms();
    const now = Date.UTC(2026, 4, 18, 4, 0, 0);
    await installAlarmFor(alarms, ok, now);
    expect(alarms.cleared).toEqual([SCHEDULED_EXPORT_ALARM_NAME]);
    expect(alarms.created).toHaveLength(1);
    const c = alarms.created[0];
    expect(c?.name).toBe(SCHEDULED_EXPORT_ALARM_NAME);
    expect(c?.info.periodInMinutes).toBe(24 * 60);
    expect(c?.info.when).toBe(Date.UTC(2026, 4, 18, 9, 0, 0));
  });

  it('schedule weekly → create avec period 7×24h', async () => {
    const alarms = makeAlarms();
    const weekly: ScheduledExport = { ...ok, frequency: 'weekly' };
    const now = Date.UTC(2026, 4, 18, 4, 0, 0);
    await installAlarmFor(alarms, weekly, now);
    const c = alarms.created[0];
    expect(c?.info.periodInMinutes).toBe(7 * 24 * 60);
  });

  it('réinstallation : un clear précède chaque create', async () => {
    const alarms = makeAlarms();
    const now = Date.UTC(2026, 4, 18, 4, 0, 0);
    await installAlarmFor(alarms, ok, now);
    await installAlarmFor(alarms, ok, now);
    expect(alarms.cleared.length).toBe(2);
    expect(alarms.created.length).toBe(2);
  });
});
