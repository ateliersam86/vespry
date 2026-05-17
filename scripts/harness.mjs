/**
 * Harnais de test partagé.
 *
 * Chaque run part d'un profil Chromium NEUF (dossier temporaire jeté à la fin) :
 * un profil persistant réutilisé garderait en cache l'ancien service worker
 * après un changement de code, d'où des « réponses vides » trompeuses.
 *
 * Le jeton Discord est injecté directement dans `chrome.storage.local`
 * (clé `vespry.discordToken`) au lieu de dépendre d'une session Discord
 * connectée : le test devient déterministe et hermétique.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'dist');

/** Clé de stockage du jeton — doit rester alignée sur `src/engine/auth.ts`. */
const TOKEN_KEY = 'vespry.discordToken';

/**
 * Lance Chromium avec l'extension chargée et le jeton pré-injecté.
 * @param {string} token  Jeton de session Discord.
 * @returns {Promise<{ctx: import('playwright').BrowserContext, extId: string, cleanup: () => Promise<void>}>}
 */
export async function launchWithToken(token) {
  const profile = mkdtempSync(join(tmpdir(), 'vespry-test-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    locale: 'fr-FR',
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--window-size=1320,900',
    ],
  });

  // Récupère l'ID de l'extension via son service worker.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  const extId = new URL(sw.url()).host;

  // Injecte le jeton dans chrome.storage.local depuis une page d'extension.
  const seed = await ctx.newPage();
  await seed.goto(`chrome-extension://${extId}/src/popup/popup.html`, {
    waitUntil: 'load',
  });
  await seed.evaluate(
    ([key, tok]) => chrome.storage.local.set({ [key]: { token: tok, capturedAt: Date.now() } }),
    [TOKEN_KEY, token],
  );
  await seed.close();

  const cleanup = async () => {
    await ctx.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  };
  return { ctx, extId, cleanup };
}

/** Texte rendu de l'overlay (Shadow DOM, hors balises <style>). */
export async function overlayText(page) {
  return page.evaluate(() => {
    const r = document.getElementById('vespry-overlay-host')?.shadowRoot;
    return r
      ? Array.from(r.children)
          .filter((e) => e.tagName !== 'STYLE')
          .map((e) => e.textContent ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
  });
}
