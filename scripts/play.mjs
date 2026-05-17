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

// Ouvre l'overlay automatiquement : le profil de test n'est pas connecté à
// Discord (profil jetable), donc la PAGE montre l'écran de login — mais
// l'extension, elle, a la session via le jeton injecté. On ouvre directement
// l'overlay pour montrer Vespry qui fonctionne, pas la page de login derrière.
await page.locator('#vespry-launch-btn').click({ timeout: 20_000 }).catch(() => {});

console.log('────────────────────────────────────────────────────────');
console.log('  Navigateur Vespry ouvert — overlay déjà affiché.');
console.log('  La page Discord derrière montre un écran de login : c\'est');
console.log('  normal, le profil de test n\'est pas connecté à Discord.');
console.log('  L\'extension, elle, a la session (jeton injecté pour le test).');
console.log('  Ferme la fenêtre du navigateur pour quitter.');
console.log('────────────────────────────────────────────────────────');

// Reste en vie jusqu'à la fermeture de la fenêtre.
await new Promise((resolve) => ctx.on('close', () => resolve()));
await cleanup();
console.log('Navigateur fermé.');
