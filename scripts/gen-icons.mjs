#!/usr/bin/env node
/**
 * Génère les icônes d'extension PNG (16/48/128) depuis la mascotte Vespry —
 * le hibou pixel-art (concept B, tête seule), fond transparent.
 *
 * Un fin liseré clair entoure le hibou : invisible sur barre d'outils claire,
 * il le détache sur une barre sombre (sinon les bords sombres se fondent).
 *
 * Le hibou 14×13 + liseré 1px = 16×15, posé sur un canevas 16×16 → scaling
 * entier (1×/3×/8×), pixels nets à chaque taille.
 *
 * Usage : node scripts/gen-icons.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'src/assets');

const PAL = { o: '#1F1A33', b: '#5D4EAE', f: '#F4EBD4', w: '#FEFDF8', p: '#1F1A33', k: '#F0B54A' };
// Liseré lavande discret — l'icône PNG sert sur barre claire ET sombre,
// le liseré ne peut pas y être conditionnel ; le violet clair est le
// compromis le moins voyant.
const RIM = '#B3A6E6';

// Hibou tête seule, 14×13 — identique au mockup et à src/ui/owl.ts.
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

const H = HEAD.length;
const W = HEAD[0].length;
const filled = (x, y) => x >= 0 && x < W && y >= 0 && y < H && HEAD[y][x] !== '.';

// Liseré : cases vides au contact orthogonal du hibou (4-voisinage — fin).
const rim = [];
for (let y = -1; y <= H; y += 1) {
  for (let x = -1; x <= W; x += 1) {
    if (filled(x, y)) continue;
    if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) {
      rim.push({ x, y });
    }
  }
}

// Offset (+1,+1) → tout tient dans un canevas 16×16.
function svg() {
  let rects = '';
  for (const { x, y } of rim) {
    rects += `<rect x="${x + 1}" y="${y + 1}" width="1" height="1" fill="${RIM}"/>`;
  }
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const c = HEAD[y][x];
      if (c === '.') continue;
      rects += `<rect x="${x + 1}" y="${y + 1}" width="1" height="1" fill="${PAL[c]}"/>`;
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
