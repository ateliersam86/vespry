/**
 * Mascotte Vespry — le hibou pixel-art (concept B, tête seule).
 *
 * Source unique de la carte de pixels, partagée par :
 *  - `icons.tsx` (`OwlMark`, composant Preact),
 *  - `content-script.ts` (bouton lanceur, hors Preact → SVG en chaîne).
 *
 * Un fin liseré clair (`owlRimCells`) entoure le hibou : invisible sur fond
 * clair, il le détache sur un fond sombre (barre d'outils, header sombre).
 */

/** Palette du hibou. */
export const OWL_PALETTE: Record<string, string> = {
  o: '#1F1A33', b: '#5D4EAE', f: '#F4EBD4', w: '#FEFDF8', p: '#1F1A33', k: '#F0B54A',
};

/** Couleur du liseré de contraste. */
export const OWL_RIM_COLOR = '#F4EBD4';

/** Carte de pixels — hibou tête seule, 14×13. */
export const OWL_HEAD: readonly string[] = [
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

/**
 * Cellules du liseré : cases vides au contact du hibou (8-voisinage).
 * Coordonnées dans `[-1 .. largeur]` — le liseré déborde d'1px du hibou.
 */
export function owlRimCells(): ReadonlyArray<{ x: number; y: number }> {
  const h = OWL_HEAD.length;
  const w = OWL_HEAD[0]?.length ?? 0;
  const filled = (x: number, y: number): boolean =>
    x >= 0 && x < w && y >= 0 && y < h && OWL_HEAD[y]?.[x] !== '.' && OWL_HEAD[y]?.[x] !== undefined;
  const rim: { x: number; y: number }[] = [];
  for (let y = -1; y <= h; y += 1) {
    for (let x = -1; x <= w; x += 1) {
      if (filled(x, y)) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy += 1) {
        for (let dx = -1; dx <= 1 && !touches; dx += 1) {
          if (filled(x + dx, y + dy)) touches = true;
        }
      }
      if (touches) rim.push({ x, y });
    }
  }
  return rim;
}

/**
 * SVG du hibou sous forme de chaîne — pour les contextes hors Preact
 * (injection DOM directe). `px` = taille de rendu en pixels (largeur).
 */
export function owlSvgString(px: number): string {
  let rects = '';
  for (const { x, y } of owlRimCells()) {
    rects += `<rect x="${x}" y="${y}" width="1.05" height="1.05" fill="${OWL_RIM_COLOR}"/>`;
  }
  OWL_HEAD.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === '.') return;
      rects += `<rect x="${x}" y="${y}" width="1.05" height="1.05" fill="${OWL_PALETTE[c]}"/>`;
    });
  });
  const h = Math.round((px * 15) / 16);
  return `<svg width="${px}" height="${h}" viewBox="-1 -1 16 15" `
    + `shape-rendering="crispEdges" style="flex:none">${rects}</svg>`;
}
