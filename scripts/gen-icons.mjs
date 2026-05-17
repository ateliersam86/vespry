#!/usr/bin/env node
/**
 * Génère les icônes d'extension PNG (16/48/128) depuis la mascotte Vespry —
 * le hibou pixel-art (concept B, tête seule), fond transparent.
 *
 * La carte 14×13 est paddée en 16×16 pour un scaling ENTIER (1×/3×/8×) :
 * les pixels restent parfaitement nets à chaque taille.
 *
 * Usage : node scripts/gen-icons.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'src/assets');

const PAL = { o: '#1F1A33', b: '#5D4EAE', f: '#F4EBD4', w: '#FEFDF8', p: '#1F1A33', k: '#F0B54A' };

// Hibou tête seule, 14×13 — identique au mockup vespry-logos.html.
const HEAD = [
  '...oo....oo...',
  '..obbo..obbo..',
  '.obbbbbbbbbbo.',
  'obbbbbbbbbbbbo',
  'obffffffffffbo',
  'obfwwwffwwwfbo',
  'obfwpwffwpwfbo',
  'obfwwwffwwwfbo',
  'obffffkkffffbo',
  'obffffffffffbo',
  '.obffffffffbo.',
  '..obffffffbo..',
  '...obbbbbbo...',
];

// Padding → 16×16 (1 colonne G/D, 1 ligne haut, 2 lignes bas).
const EMPTY16 = '.'.repeat(16);
const MAP = [EMPTY16, ...HEAD.map((r) => `.${r}.`), EMPTY16, EMPTY16];

function svg() {
  let rects = '';
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const c = MAP[y][x];
      if (c === '.') continue;
      rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${PAL[c]}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects}</svg>`;
}

const ctx = await chromium.launch();
const page = await ctx.newPage();
const markup = svg();

for (const size of [16, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><meta charset="utf-8">`
    + `<style>html,body{margin:0}svg{width:${size}px;height:${size}px;display:block;image-rendering:pixelated}</style>`
    + markup,
  );
  await page.screenshot({
    path: join(assets, `icon-${size}.png`),
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  console.log(`✓ icon-${size}.png`);
}

await ctx.close();
console.log('Icônes générées dans src/assets/');
