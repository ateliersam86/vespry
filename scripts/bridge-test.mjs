#!/usr/bin/env node
/**
 * Test de diagnostic du bridge — connecte vraiment Discord (token injecté dans
 * le localStorage de Discord) puis observe si le bridge capte le jeton.
 *
 * Reproduit le scénario réel : Discord connecté + extension chargée.
 * Lit les marqueurs `__vespry*` posés par le bridge pour localiser la panne.
 *
 * Usage : VESPRY_TEST_TOKEN="..." node scripts/bridge-test.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOKEN = process.env.VESPRY_TEST_TOKEN;
if (!TOKEN) {
  console.log('VESPRY_TEST_TOKEN requis');
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'dist');
// Profil PERSISTANT : conserve cookies / session Discord entre les runs.
const profileDir = join(root, '.test-profile');

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--window-size=1280,860',
  ],
});

const sw = ctx.serviceWorkers()[0]
  ?? (await ctx.waitForEvent('serviceworker', { timeout: 12_000 }).catch(() => null));
if (!sw) { console.log('❌ pas de service worker'); await ctx.close(); process.exit(1); }

const d = await ctx.newPage();
const pageErrors = [];
d.on('pageerror', (e) => pageErrors.push(String(e)));

/** Clique « Continuer dans le navigateur » si l'interstitiel apparaît. */
async function dismissAppPrompt() {
  const btn = d.getByText(/Continue in Browser|Continuer dans le navigateur/i);
  if (await btn.count().catch(() => 0)) {
    await btn.first().click().catch(() => {});
    await d.waitForTimeout(2000);
  }
}

// 1. Aller sur Discord, injecter le token dans SON localStorage.
await d.goto('https://discord.com/login', { waitUntil: 'load', timeout: 45_000 });
await dismissAppPrompt();
await d.waitForTimeout(4000);
console.log('URL avant injection :', d.url());
const inject = await d.evaluate((tok) => {
  try {
    window.localStorage.setItem('token', JSON.stringify(tok));
    return 'token injecté ✓';
  } catch (e) {
    return `ERREUR localStorage : ${String(e)}`;
  }
}, TOKEN);
console.log(inject);

// 2. Recharger dans l'app — Discord démarre connecté.
await d.goto('https://discord.com/channels/@me', { waitUntil: 'load', timeout: 45_000 });
await dismissAppPrompt();

// 3. Laisser Discord booter et émettre ses requêtes API.
await d.waitForTimeout(32_000);
console.log('URL après boot :', d.url());

// 4. Lire les marqueurs du bridge (monde MAIN).
const markers = await d.evaluate(() => {
  const w = window;
  return {
    bridge: w.__vespryBridge ?? false,
    fetch: w.__vespryFetch ?? 0,
    xhr: w.__vespryXhr ?? 0,
    sawAuth: w.__vesprySawAuth ?? 0,
    posted: w.__vespryPosted ?? 0,
  };
});

// 5. Discord est-il connecté ?
const loggedIn = await d.evaluate(
  () => !document.querySelector('input[type="email"]')
    && !/\/login/.test(location.pathname),
);

// 6. Le jeton est-il arrivé dans chrome.storage ?
const stored = await sw.evaluate(async () => {
  const r = await chrome.storage.local.get('vespry.discordToken');
  return Boolean(r['vespry.discordToken']);
});

console.log('=== DIAGNOSTIC BRIDGE ===');
console.log('Discord connecté         :', loggedIn);
console.log('bridge exécuté           :', markers.bridge);
console.log('appels fetch interceptés :', markers.fetch);
console.log('appels XHR interceptés   :', markers.xhr);
console.log('en-têtes authorization vus:', markers.sawAuth);
console.log('jetons publiés            :', markers.posted);
console.log('jeton dans chrome.storage :', stored);
if (pageErrors.length) console.log('erreurs page :', pageErrors.slice(0, 5).join(' | '));

// 7. Ouvrir l'overlay Vespry et vérifier qu'il charge les serveurs.
let overlayOk = false;
try {
  const launcher = d.locator('#vespry-launch-btn');
  await launcher.waitFor({ state: 'visible', timeout: 15_000 });
  await launcher.click();
  await d.waitForSelector('#vespry-overlay-host', { state: 'attached', timeout: 10_000 });
  await d.waitForTimeout(22_000); // laisse charger les serveurs / l'auto-récupération
  const txt = await d.evaluate(() => {
    const root = document.getElementById('vespry-overlay-host')?.shadowRoot;
    return root
      ? Array.from(root.children).filter((e) => e.tagName !== 'STYLE')
          .map((e) => e.textContent ?? '').join(' ').trim()
      : '';
  });
  overlayOk = /Images/.test(txt) && !/non détectée|Chargement/.test(txt);
  console.log('overlay                   :', txt.slice(0, 170).replace(/\s+/g, ' '));
} catch (e) {
  console.log('overlay                   : erreur —', String(e));
}
console.log('overlay montre les serveurs:', overlayOk);

await ctx.close();
const ok = stored && overlayOk;
console.log(ok ? '\n✅ FLUX CONNECTÉ COMPLET OK' : '\n❌ ÉCHEC');
process.exit(ok ? 0 : 1);
