#!/usr/bin/env node
/**
 * Captures d'écran de l'overlay en fonctionnement (preuve visuelle) :
 *   1. overlay sombre   2. thème clair   3. export terminé   4. panneau Soutiens
 *
 * Profil neuf + jeton injecté (cf. harness.mjs).
 *
 * Usage : VESPRY_TEST_TOKEN="..." node scripts/screenshots.mjs
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchWithToken } from './harness.mjs';

const TOKEN = process.env.VESPRY_TEST_TOKEN;
if (!TOKEN) { console.log('VESPRY_TEST_TOKEN requis'); process.exit(1); }

const out = tmpdir();
const shots = [];
const { ctx, cleanup } = await launchWithToken(TOKEN);

const waitOverlay = (page, fn, timeout) =>
  page.waitForFunction(fn, undefined, { timeout, polling: 500 });

const d = await ctx.newPage();

async function shoot(name) {
  const path = join(out, `vespry-${name}.png`);
  await d.locator('.v-win').screenshot({ path });
  shots.push(path);
  console.log('capture :', path);
}

try {
  await d.goto('https://discord.com/channels/@me', { waitUntil: 'load', timeout: 45_000 });
  await d.locator('#vespry-launch-btn').waitFor({ state: 'visible', timeout: 20_000 });
  await d.locator('#vespry-launch-btn').click();
  await d.waitForSelector('#vespry-overlay-host', { state: 'attached', timeout: 10_000 });

  await waitOverlay(d, () => {
    const r = document.getElementById('vespry-overlay-host')?.shadowRoot;
    return Boolean(r && /Images/.test(r.textContent ?? ''));
  }, 50_000);
  await waitOverlay(d, () => {
    const r = document.getElementById('vespry-overlay-host')?.shadowRoot;
    return (r?.querySelectorAll('.v-crow').length ?? 0) > 3;
  }, 45_000);
  await d.waitForTimeout(800);
  await shoot('1-sombre');

  // Thème clair.
  await d.locator('.v-theme-btn').click();
  await d.waitForTimeout(700);
  await shoot('2-clair');
  // retour sombre (clair → auto → sombre).
  await d.locator('.v-theme-btn').click();
  await d.locator('.v-theme-btn').click();
  await d.waitForTimeout(500);

  // Petit export (filtre = aujourd'hui).
  await d.locator('.v-date').first().fill(new Date().toISOString().slice(0, 10));
  await d.locator('.v-crow .v-cbx').first().click();
  await d.locator('.v-btn', { hasText: /Ajouter/ }).first().click();
  await waitOverlay(d, () => {
    const t = document.getElementById('vespry-overlay-host')?.shadowRoot?.textContent ?? '';
    return /TERMIN|PARTIEL|\.zip/i.test(t);
  }, 120_000);
  await d.locator('.v-exp', { hasText: /Détails/ }).first().click().catch(() => {});
  await d.waitForTimeout(800);
  await shoot('3-export');

  // Panneau Soutiens.
  await d.locator('.v-support-link').first().click();
  await d.waitForTimeout(800);
  await shoot('4-soutiens');
} catch (e) {
  console.log('erreur :', String(e));
}

await cleanup();
console.log('\nCAPTURES:', shots.join(' '));
