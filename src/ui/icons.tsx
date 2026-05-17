/**
 * Jeu d'icônes Vespry — SVG inline, cohérent.
 *
 * Les icônes de trait héritent de `currentColor` (donc du thème) et se
 * dimensionnent en `1em` via la classe `.v-ico`. Remplacent les emojis, qui
 * rendaient différemment selon l'OS.
 *
 * `OwlMark` est la mascotte (hibou pixel-art, concept B) en SVG vectoriel.
 */
import type { JSX } from 'preact';
import { OWL_HEAD, OWL_PALETTE, OWL_RIM_COLOR, owlRimCells } from './owl';

type IconProps = { class?: string };

/** Icône de trait standard — 24×24, currentColor. */
function stroke(path: JSX.Element, extra?: string): (p: IconProps) => JSX.Element {
  return ({ class: cls }: IconProps) => (
    <svg
      class={`v-ico ${cls ?? ''} ${extra ?? ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {path}
    </svg>
  );
}

export const IconMoon = ({ class: cls }: IconProps): JSX.Element => (
  <svg class={`v-ico ${cls ?? ''}`} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5 8.5 8.5 0 1 0 20.5 14.3Z" />
  </svg>
);

export const IconSun = ({ class: cls }: IconProps): JSX.Element => (
  <svg
    class={`v-ico ${cls ?? ''}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
  >
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.9 1.9M17.5 17.5l1.9 1.9M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.9-1.9M17.5 6.5l1.9-1.9" />
  </svg>
);

export const IconAuto = ({ class: cls }: IconProps): JSX.Element => (
  <svg class={`v-ico ${cls ?? ''}`} viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
    <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" />
  </svg>
);

export const IconHeart = ({ class: cls }: IconProps): JSX.Element => (
  <svg class={`v-ico ${cls ?? ''}`} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 20.7 4.2 13a4.9 4.9 0 0 1 7-6.9l.8.8.8-.8a4.9 4.9 0 0 1 7 6.9Z" />
  </svg>
);

export const IconMail = stroke(
  <>
    <rect x="3" y="5.5" width="18" height="13" rx="2.2" />
    <path d="m4 7 8 6 8-6" />
  </>,
);

export const IconCheck = stroke(<path d="M5 12.5 10 17.5 19 6.5" />);
export const IconMinus = stroke(<path d="M6 12h12" />);
export const IconChevronDown = stroke(<path d="m6 9 6 6 6-6" />);
export const IconChevronRight = stroke(<path d="m9 6 6 6-6 6" />);
export const IconClose = stroke(<path d="M6 6 18 18M18 6 6 18" />);
export const IconMinimize = stroke(<path d="M6 18h12" />);
export const IconExpand = stroke(<path d="M8 16 16 8M9 8h7v7" />);
export const IconDownload = stroke(<path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" />);

/** Mascotte Vespry — hibou pixel-art (concept B, tête seule) + liseré clair. */
export function OwlMark({ class: cls }: IconProps): JSX.Element {
  const rects: JSX.Element[] = [];
  for (const { x, y } of owlRimCells()) {
    rects.push(
      <rect key={`rim-${x}-${y}`} x={x} y={y} width="1.05" height="1.05" fill={OWL_RIM_COLOR} />,
    );
  }
  OWL_HEAD.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === '.') return;
      rects.push(
        <rect key={`${x}-${y}`} x={x} y={y} width="1.05" height="1.05" fill={OWL_PALETTE[c]} />,
      );
    });
  });
  return (
    <svg
      class={`v-mark ${cls ?? ''}`}
      viewBox="-1 -1 16 15"
      shape-rendering="crispEdges"
    >
      {rects}
    </svg>
  );
}
