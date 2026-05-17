#!/usr/bin/env node
/**
 * Ouvre Chromium pour tester Vespry à la main.
 *
 *  - Profil PERSISTANT (`.test-profile-manual/`) : tu te connectes à Discord
 *    une seule fois, la session est conservée d'un lancement à l'autre.
 *  - Chaque lancement RECONSTRUIT l'extension avec une version UNIQUE. Sans
 *    ça, Chrome — sur un profil réutilisé et une version figée — sert une
 *    extension en cache périmée : ses content scripts pointent vers des
 *    fichiers disparus → plus rien ne s'injecte sur Discord (« non
 *    connecté » alors que la page l'est). La version unique force Chrome à
 *    ré-enregistrer l'extension à neuf à chaque fois.
 *
 * Usage : npm run play
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'dist');
const profile = join(root, '.test-profile-manual');
const counterFile = join(root, '.dev-build-n');

// Compteur de build → 4e composant de version, unique et croissant.
const n = (existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) || 0 : 0) + 1;
writeFileSync(counterFile, String(n));
const devVersion = `0.1.0.${n % 60000}`;

console.log(`Build de dev — version ${devVersion} …`);
execSync('npm run build', {
  cwd: root,
  env: { ...process.env, VESPRY_BUILD_VERSION: devVersion },
  stdio: 'inherit',
});

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
console.log(`  Navigateur Vespry ouvert — v${devVersion}, profil persistant.`);
console.log('  1. Connecte-toi à Discord (une seule fois — ça reste).');
console.log('  2. Clique le bouton « Vespry » en haut à droite.');
console.log('  Ferme la fenêtre pour quitter.');
console.log('────────────────────────────────────────────────────────');

await new Promise((resolve) => ctx.on('close', () => resolve()));
console.log('Navigateur fermé.');
