/**
 * Mascotte Vespry — le hibou pixel-art (concept B, tête seule).
 *
 * Source unique de la carte de pixels, partagée par :
 *  - `icons.tsx` (`OwlMark`, composant Preact),
 *  - `content-script.ts` (bouton lanceur, hors Preact → SVG en chaîne).
 */

/** Palette du hibou. */
export const OWL_PALETTE: Record<string, string> = {
  o: '#1F1A33', b: '#5D4EAE', f: '#F4EBD4', w: '#FEFDF8', p: '#1F1A33', k: '#F0B54A',
};

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
 * SVG du hibou sous forme de chaîne — pour les contextes hors Preact
 * (injection DOM directe). `px` = taille de rendu en pixels.
 */
export function owlSvgString(px: number): string {
  let rects = '';
  OWL_HEAD.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === '.') return;
      rects += `<rect x="${x}" y="${y}" width="1.05" height="1.05" fill="${OWL_PALETTE[c]}"/>`;
    });
  });
  return `<svg width="${px}" height="${px}" viewBox="0 0 14 13" `
    + `shape-rendering="crispEdges" style="flex:none">${rects}</svg>`;
}
