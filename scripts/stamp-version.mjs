#!/usr/bin/env node
/**
 * Inscrit la version de release dans package.json.
 *
 * `manifest.ts` lit `package.json` au build → la version se propage à
 * `manifest.json`. La CI passe le tag de release GitHub ; la version n'est
 * jamais saisie à la main.
 *
 * Usage : node scripts/stamp-version.mjs v0.2.0   (le « v » est optionnel)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raw = process.argv[2];
if (!raw) {
  console.error('usage: stamp-version.mjs <version|tag>');
  process.exit(1);
}

const version = raw.replace(/^v/, '').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Version invalide : "${version}" (attendu X.Y.Z, ex. 0.2.0).`);
  process.exit(1);
}

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Version inscrite : ${version}`);
