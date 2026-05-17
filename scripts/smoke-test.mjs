#!/usr/bin/env node
/**
 * Smoke-test d'intégration — charge l'extension dans Chromium (Playwright).
 *
 * Phase 1 — popup : chaîne service worker ↔ offscreen (`get-state`).
 * Phase 2 — discord.com : injection du content script, montage de l'overlay.
 * Phase 3 — langues : l'UI se traduit selon `navigator.language`.
 *
 * Sans jeton Discord, l'état attendu partout est « pas de session » — jamais
 * un blocage sur « Chargement… ».
 *
 * Usage : node scripts/smoke-test.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const extDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const logs = [];
const rec = (src, msg) => logs.push(`[${src}] ${msg}`);
let pass = true;
const fail = (msg) => { pass = false; rec('FAIL', msg); };

/**
 * Lance un Chromium VISIBLE avec l'extension chargée, dans la locale donnée.
 * Fenêtre visible : on peut regarder le test se dérouler.
 */
async function launch(locale) {
  return chromium.launchPersistentContext('', {
    headless: false,
    ...(locale ? { locale } : {}),
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--window-size=1200,820',
    ],
  });
}

async function extensionId(context) {
  const sw = context.serviceWorkers()[0]
    ?? (await context.waitForEvent('serviceworker', { timeout: 12_000 }).catch(() => null));
  return sw ? sw.url().split('/')[2] : null;
}

// ─── Phases 1 & 2 ───────────────────────────────────────────────
const context = await launch();
const extId = await extensionId(context);
if (!extId) {
  console.log('❌ AUCUN SERVICE WORKER — extension non chargée');
  await context.close();
  process.exit(1);
}
rec('test', `extension chargée — id ${extId}`);

const popup = await context.newPage();
popup.on('pageerror', (e) => fail(`popup pageerror: ${e}`));
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
await popup.waitForTimeout(20_000);
const popupText = (await popup.evaluate(() => document.body.innerText).catch((e) => `(${e})`)).trim();
rec('phase1', `popup: ${popupText.replace(/\n+/g, ' / ')}`);
if (/Chargement|Loading/.test(popupText)) fail('popup bloqué sur « Chargement… »');
if (!/session|Session/.test(popupText)) fail('popup : état de session non affiché');

const direct = await popup.evaluate(async () => {
  try {
    return JSON.stringify(await chrome.runtime.sendMessage({
      kind: 'vespry-command', command: { cmd: 'get-state' },
    }));
  } catch (e) { return `ERREUR: ${e}`; }
});
rec('phase1', `get-state → ${direct}`);
if (!direct.includes('"ok":true')) fail('get-state n\'a pas abouti');

const discord = await context.newPage();
discord.on('pageerror', (e) => rec('discord!', String(e)));
try {
  await discord.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 35_000 });
  const launcher = discord.locator('#vespry-launch-btn');
  await launcher.waitFor({ state: 'visible', timeout: 20_000 });
  rec('phase2', 'bouton lanceur injecté ✓');
  await launcher.click();
  await discord.waitForSelector('#vespry-overlay-host', { state: 'attached', timeout: 10_000 });
  await discord.waitForTimeout(22_000);
  const overlayText = await discord.evaluate(() => {
    const root = document.getElementById('vespry-overlay-host')?.shadowRoot;
    return root
      ? Array.from(root.children).filter((el) => el.tagName !== 'STYLE')
          .map((el) => el.textContent ?? '').join(' ').trim()
      : '(pas de shadow root)';
  });
  rec('phase2', `overlay : ${overlayText.slice(0, 160).replace(/\s+/g, ' ')}`);
  if (/Chargement|Loading/.test(overlayText)) fail('overlay bloqué sur « Chargement… »');
  if (!/session|Session/.test(overlayText)) fail('overlay : état de session non affiché');
} catch (e) {
  fail(`phase 2 (discord.com) : ${e}`);
}
await context.close();

// ─── Phase 3 : langues ──────────────────────────────────────────
// On vérifie que le popup affiche bien la traduction de la locale.
const LOCALE_CHECKS = {
  ja: 'セッションなし',
  es: 'Sin sesión',
  de: 'Keine Sitzung',
};
for (const [locale, expected] of Object.entries(LOCALE_CHECKS)) {
  const ctx = await launch(locale);
  const id = await extensionId(ctx);
  if (!id) { fail(`locale ${locale} : extension non chargée`); await ctx.close(); continue; }
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/src/popup/popup.html`);
  await p.waitForTimeout(12_000);
  const txt = (await p.evaluate(() => document.body.innerText).catch(() => '')).trim();
  if (txt.includes(expected)) {
    rec('phase3', `locale ${locale} → « ${expected} » ✓`);
  } else {
    fail(`locale ${locale} : « ${expected} » absent (popup: ${txt.replace(/\n+/g, ' / ').slice(0, 90)})`);
  }
  await ctx.close();
}

// ─── Phase 4 : flux CONNECTÉ (si un token de test est fourni) ───
// Injecte le token dans chrome.storage pour simuler une capture réussie,
// puis vérifie que l'overlay charge bien les serveurs.
const TEST_TOKEN = process.env.VESPRY_TEST_TOKEN;
if (TEST_TOKEN) {
  const ctx = await launch();
  const id = await extensionId(ctx);
  const sw = ctx.serviceWorkers()[0]
    ?? (await ctx.waitForEvent('serviceworker', { timeout: 12_000 }).catch(() => null));
  if (!id || !sw) {
    fail('phase4 : extension non chargée');
  } else {
    await sw.evaluate(
      (tok) => chrome.storage.local.set({
        'vespry.discordToken': { token: tok, capturedAt: Date.now() },
      }),
      TEST_TOKEN,
    );
    rec('phase4', 'token injecté dans chrome.storage ✓');
    const d = await ctx.newPage();
    d.on('pageerror', (e) => rec('phase4!', String(e)));
    try {
      await d.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 35_000 });
      const launcher = d.locator('#vespry-launch-btn');
      await launcher.waitFor({ state: 'visible', timeout: 20_000 });
      await launcher.click();
      await d.waitForSelector('#vespry-overlay-host', { state: 'attached', timeout: 10_000 });
      await d.waitForTimeout(28_000); // appels API réels (getGuilds…)
      const txt = await d.evaluate(() => {
        const root = document.getElementById('vespry-overlay-host')?.shadowRoot;
        return root
          ? Array.from(root.children).filter((el) => el.tagName !== 'STYLE')
              .map((el) => el.textContent ?? '').join(' ').trim()
          : '(pas de shadow root)';
      });
      rec('phase4', `overlay connecté : ${txt.slice(0, 220).replace(/\s+/g, ' ')}`);
      if (/non détectée|no.token/i.test(txt)) fail('phase4 : token rejeté ou non lu');
      else if (/Chargement|Loading/.test(txt)) fail('phase4 : overlay bloqué');
      else if (/n.a pas pu démarrer|could not start/i.test(txt)) fail('phase4 : moteur en erreur');
      else if (!/Images/.test(txt)) fail('phase4 : overlay complet non rendu');
      else rec('phase4', 'overlay complet rendu avec session ✓');
    } catch (e) {
      fail(`phase4 : ${e}`);
    }
    await ctx.close();
  }
} else {
  rec('phase4', '(ignorée — pas de VESPRY_TEST_TOKEN)');
}

console.log('=== JOURNAL ===');
console.log(logs.join('\n'));
console.log(`\n=== VERDICT : ${pass ? '✅ TOUT OK' : '❌ ÉCHEC'} ===`);
process.exit(pass ? 0 : 1);
