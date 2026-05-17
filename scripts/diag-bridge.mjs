#!/usr/bin/env node
/**
 * Diagnostic de la chaîne du jeton sur le PROFIL connecté (.test-profile-manual).
 * Trace chaque maillon : bridge MAIN → postMessage → content script → stockage
 * → offscreen. Aucune injection — c'est le vrai parcours.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'dist');
const profile = join(root, '.test-profile-manual');
const log = (m) => console.log(m);

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  locale: 'fr-FR',
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--window-size=1320,900'],
});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
const extId = sw ? new URL(sw.url()).host : null;
log(`extId : ${extId ?? 'INTROUVABLE'}`);

const d = await ctx.newPage();
const pageErrors = [];
d.on('pageerror', (e) => pageErrors.push(e.message));
d.on('console', (m) => {
  if (/vespry|error/i.test(m.text())) log(`  [console] ${m.type()}: ${m.text().slice(0, 200)}`);
});

log('→ ouverture de discord.com/channels/@me …');
await d.goto('https://discord.com/channels/@me', { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
log(`URL après chargement : ${d.url()}`);
log('attente 25 s (Discord doit émettre ses requêtes API)…');
await d.waitForTimeout(25_000);

// 1. Marqueurs du bridge (monde MAIN).
const bridge = await d.evaluate(() => ({
  bridge: window.__vespryBridge ?? false,
  fetch: window.__vespryFetch ?? 0,
  xhr: window.__vespryXhr ?? 0,
  sawAuth: window.__vesprySawAuth ?? 0,
  posted: window.__vespryPosted ?? 0,
})).catch((e) => ({ err: String(e) }));
log('\n--- 1. BRIDGE (monde MAIN) ---');
log(`  bridge actif : ${bridge.bridge}`);
log(`  fetch patchés : ${bridge.fetch} · setRequestHeader patchés : ${bridge.xhr}`);
log(`  en-têtes authorization vus : ${bridge.sawAuth}`);
log(`  jetons postés au content script : ${bridge.posted}`);

// 2. Jeton dans chrome.storage.local.
let storage = {};
if (extId) {
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'load' }).catch(() => {});
  storage = await ext.evaluate(() => chrome.storage.local.get(null)).catch((e) => ({ err: String(e) }));
  await ext.close();
}
log('\n--- 2. chrome.storage.local ---');
const tok = storage['vespry.discordToken'];
log(`  clés : ${Object.keys(storage).join(', ') || '(vide)'}`);
log(`  jeton stocké : ${tok ? `oui (${String(tok.token).slice(0, 14)}…, ${String(tok.token).length} car.)` : 'NON'}`);

// 3. Overlay.
await d.locator('#vespry-launch-btn').click({ timeout: 15_000 }).catch((e) => log(`  clic launcher : ${e}`));
await d.waitForSelector('#vespry-overlay-host', { state: 'attached', timeout: 8000 }).catch(() => {});
await d.waitForTimeout(8000);
const overlay = await d.evaluate(() => {
  const r = document.getElementById('vespry-overlay-host')?.shadowRoot;
  if (!r) return '(pas de shadow root)';
  return Array.from(r.children).filter((e) => e.tagName !== 'STYLE')
    .map((e) => e.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}).catch((e) => String(e));
log('\n--- 3. OVERLAY ---');
log(`  ${overlay}`);

if (pageErrors.length) log(`\nERREURS page : ${pageErrors.slice(0, 3).join(' | ')}`);
log('\n(fenêtre laissée ouverte 8 s)');
await d.waitForTimeout(8000);
await ctx.close();
log('=== FIN DIAGNOSTIC ===');
