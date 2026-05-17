#!/usr/bin/env node
/**
 * Ouvre un Chromium pour tester Vespry à la main, avec un profil PERSISTANT
 * (`.test-profile-manual/`). Conséquence : tu te connectes à Discord une
 * seule fois — la session est conservée à chaque `npm run play` suivant.
 *
 * Pas d'injection de jeton ici : c'est le vrai parcours (tu es connecté à
 * Discord, le bridge capte ta session naturellement).
 *
 * Astuce : après un rebuild de l'extension, recharge-la depuis
 * `chrome://extensions` (icône ↻) pour être sûr d'avoir le dernier code.
 *
 * Usage : npm run play
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'dist');
const profile = join(root, '.test-profile-manual');

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  locale: 'fr-FR',
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--window-size=1320,900',
  ],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page
  .goto('https://discord.com/channels/@me', { waitUntil: 'load', timeout: 60_000 })
  .catch(() => { /* hors-ligne — sans gravité */ });

console.log('────────────────────────────────────────────────────────');
console.log('  Navigateur Vespry ouvert (profil persistant).');
console.log('  1. Connecte-toi à Discord (une seule fois — ça reste).');
console.log('  2. Clique le bouton « Vespry » en haut à droite.');
console.log('  Les prochains `npm run play` te garderont connecté.');
console.log('  Ferme la fenêtre pour quitter.');
console.log('────────────────────────────────────────────────────────');

await new Promise((resolve) => ctx.on('close', () => resolve()));
console.log('Navigateur fermé.');
