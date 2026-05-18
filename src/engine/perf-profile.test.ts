import { describe, expect, it } from 'vitest';
import {
  classifySignals, clampParallel, detectPerfProfile,
  profileForTier, type PerfSignals,
} from './perf-profile';

/** Construit un jeu de signaux pour les tests — tout défini à `undefined` par défaut. */
function signals(over: Partial<PerfSignals> = {}): PerfSignals {
  return {
    hardwareConcurrency: over.hardwareConcurrency,
    deviceMemoryGb: over.deviceMemoryGb,
    jsHeapSizeLimit: over.jsHeapSizeLimit,
  };
}

describe('classifySignals', () => {
  it('RAM ≤ 2 Go → low (priorité absolue)', () => {
    expect(classifySignals(signals({ deviceMemoryGb: 2, hardwareConcurrency: 16 })))
      .toBe('low');
    expect(classifySignals(signals({ deviceMemoryGb: 0.5 }))).toBe('low');
  });

  it('heap V8 ≤ 512 Mo → low (même avec deviceMemoryGb haut)', () => {
    expect(classifySignals(signals({
      deviceMemoryGb: 16, hardwareConcurrency: 16,
      jsHeapSizeLimit: 256 * 1024 * 1024,
    }))).toBe('low');
  });

  it('RAM ≥ 8 Go ET cores ≥ 8 → fast', () => {
    expect(classifySignals(signals({ deviceMemoryGb: 8, hardwareConcurrency: 8 })))
      .toBe('fast');
    expect(classifySignals(signals({ deviceMemoryGb: 16, hardwareConcurrency: 12 })))
      .toBe('fast');
  });

  it('un seul des deux critères fast ne suffit pas', () => {
    expect(classifySignals(signals({ deviceMemoryGb: 8, hardwareConcurrency: 4 })))
      .toBe('balanced');
    expect(classifySignals(signals({ deviceMemoryGb: 4, hardwareConcurrency: 16 })))
      .toBe('balanced');
  });

  it('signaux absents → balanced (cas Firefox sans deviceMemory)', () => {
    expect(classifySignals(signals())).toBe('balanced');
    expect(classifySignals(signals({ hardwareConcurrency: 4 }))).toBe('balanced');
  });
});

describe('profileForTier', () => {
  it('fast : pas de streaming, 3 salons //', () => {
    const p = profileForTier('fast');
    expect(p.tier).toBe('fast');
    expect(p.streaming).toBe(false);
    expect(p.parallelChannels).toBe(3);
    expect(p.bufferMessagesPerPage).toBe(1000);
  });

  it('balanced : streaming, 2 salons //', () => {
    const p = profileForTier('balanced');
    expect(p.streaming).toBe(true);
    expect(p.parallelChannels).toBe(2);
    expect(p.bufferMessagesPerPage).toBe(250);
  });

  it('low : streaming pur, 1 salon à la fois', () => {
    const p = profileForTier('low');
    expect(p.streaming).toBe(true);
    expect(p.parallelChannels).toBe(1);
    expect(p.bufferMessagesPerPage).toBe(0);
  });
});

describe('clampParallel', () => {
  it('borne à [1, 3]', () => {
    expect(clampParallel(0)).toBe(1);
    expect(clampParallel(-5)).toBe(1);
    expect(clampParallel(1)).toBe(1);
    expect(clampParallel(2)).toBe(2);
    expect(clampParallel(3)).toBe(3);
    expect(clampParallel(99)).toBe(3);
    expect(clampParallel(NaN)).toBe(1);
  });
});

describe('detectPerfProfile (signals injectés)', () => {
  it('injecte un fast', () => {
    const p = detectPerfProfile({
      hardwareConcurrency: 16, deviceMemoryGb: 16, jsHeapSizeLimit: undefined,
    });
    expect(p.tier).toBe('fast');
  });

  it('injecte un low', () => {
    const p = detectPerfProfile({
      hardwareConcurrency: 4, deviceMemoryGb: 1, jsHeapSizeLimit: undefined,
    });
    expect(p.tier).toBe('low');
  });
});
