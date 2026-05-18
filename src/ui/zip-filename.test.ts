import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ZIP_TEMPLATE,
  ZIP_TEMPLATE_STORAGE_KEY,
  loadZipTemplate,
  renderZipFilename,
  sanitizeFilename,
  saveZipTemplate,
  type ZipTemplateStorage,
} from './zip-filename';

/** Stockage in-memory pour les tests. */
function makeStorage(): ZipTemplateStorage & { dump: () => Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    dump: () => ({ ...data }),
    get: async (k) => (k in data ? { [k]: data[k] } : {}),
    set: async (items) => { Object.assign(data, items); },
    remove: async (k) => { delete data[k]; },
  };
}

const NOON = new Date(2026, 4, 18, 13, 30, 0); // 2026-05-18 13:30 local

describe('sanitizeFilename', () => {
  it('remplace les caractères interdits par des underscores', () => {
    expect(sanitizeFilename('mon:nom?fichier*')).toBe('mon_nom_fichier_');
  });

  it('préserve les espaces (lisibilité)', () => {
    expect(sanitizeFilename('Groupe avec Sora')).toBe('Groupe avec Sora');
  });

  it('tronque à 200 caractères', () => {
    const long = 'a'.repeat(500);
    expect(sanitizeFilename(long).length).toBe(200);
  });

  it('retombe sur "export" pour une chaîne vide', () => {
    expect(sanitizeFilename('')).toBe('export');
    expect(sanitizeFilename('   ')).toBe('export');
  });
});

describe('renderZipFilename', () => {
  it('résout {guildName} avec sanitization', () => {
    const name = renderZipFilename('vespry-{guildName}', {
      guildName: 'Groupe: questions',
      now: NOON,
    });
    expect(name).toBe('vespry-Groupe_ questions.zip');
  });

  it('résout {date} en YYYY-MM-DD local', () => {
    const name = renderZipFilename('snapshot-{date}', {
      guildName: 'g',
      now: NOON,
    });
    expect(name).toBe('snapshot-2026-05-18.zip');
  });

  it('résout {datetime} en YYYY-MM-DD_HHmm', () => {
    const name = renderZipFilename('export-{datetime}', {
      guildName: 'g',
      now: NOON,
    });
    expect(name).toBe('export-2026-05-18_1330.zip');
  });

  it('résout plusieurs placeholders', () => {
    const name = renderZipFilename('{guildName}-{date}', {
      guildName: 'Sam',
      now: NOON,
    });
    expect(name).toBe('Sam-2026-05-18.zip');
  });

  it('template vide → défaut', () => {
    const name = renderZipFilename('   ', {
      guildName: 'Sam',
      now: NOON,
    });
    expect(name).toBe('vespry-Sam.zip');
    expect(DEFAULT_ZIP_TEMPLATE).toBe('vespry-{guildName}');
  });

  it('placeholder inconnu → laissé en l\'état', () => {
    const name = renderZipFilename('hi-{unknown}', {
      guildName: 'g',
      now: NOON,
    });
    // `{` et `}` ne sont pas dans les caractères interdits — préservés.
    expect(name).toBe('hi-{unknown}.zip');
  });

  it('ajoute toujours l\'extension .zip', () => {
    const name = renderZipFilename('foo', { guildName: 'g', now: NOON });
    expect(name).toMatch(/\.zip$/);
  });
});

describe('loadZipTemplate / saveZipTemplate', () => {
  it('round-trip', async () => {
    const s = makeStorage();
    await saveZipTemplate(s, 'custom-{guildName}');
    expect(await loadZipTemplate(s)).toBe('custom-{guildName}');
  });

  it('null supprime la clé', async () => {
    const s = makeStorage();
    await saveZipTemplate(s, 'x');
    await saveZipTemplate(s, null);
    expect(await loadZipTemplate(s)).toBeNull();
    expect(ZIP_TEMPLATE_STORAGE_KEY in s.dump()).toBe(false);
  });

  it('chaîne vide est traitée comme suppression', async () => {
    const s = makeStorage();
    await saveZipTemplate(s, '   ');
    expect(await loadZipTemplate(s)).toBeNull();
  });

  it('payload non string ignoré au load', async () => {
    const s = makeStorage();
    await s.set({ [ZIP_TEMPLATE_STORAGE_KEY]: 42 });
    expect(await loadZipTemplate(s)).toBeNull();
  });
});
