#!/usr/bin/env node
/**
 * Ouvre un navigateur Chromium avec l'extension Vespry chargée et la session
 * pré-injectée, pour un test manuel. Le navigateur reste ouvert jusqu'à ce
 * que tu fermes la fenêtre.
 *
 * Usage : VESPRY_TEST_TOKEN="..." node scripts/play.mjs
 *     ou : npm run play   (avec VESPRY_TEST_TOKEN dans l'environnement)
 */
import { launchWithToken } from './harness.mjs';

const TOKEN = process.env.VESPRY_TEST_TOKEN;
if (!TOKEN) {
  console.log('VESPRY_TEST_TOKEN requis');
  process.exit(1);
}

const { ctx, cleanup } = await launchWithToken(TOKEN);
const page = await ctx.newPage();
await page
  .goto('https://discord.com/channels/@me', { waitUntil: 'load', timeout: 45_000 })
  .catch(() => { /* page de login ou hors-ligne — sans gravité */ });

console.log('────────────────────────────────────────────────────────');
console.log('  Navigateur Vespry ouvert.');
console.log('  Clique le bouton « Vespry » en haut à droite de Discord.');
console.log('  Ferme la fenêtre du navigateur pour quitter.');
console.log('────────────────────────────────────────────────────────');

// Reste en vie jusqu'à la fermeture de la fenêtre.
await new Promise((resolve) => ctx.on('close', () => resolve()));
await cleanup();
console.log('Navigateur fermé.');
