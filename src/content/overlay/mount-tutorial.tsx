/**
 * Montage du tutoriel Vespry dans SON PROPRE host DOM.
 *
 * Pourquoi un host séparé du shadow Vespry : un parent de l'overlay
 * Vespry a `filter: blur(...)` (voir `overlay.css:78`), ce qui crée un
 * containing block et casse `position: fixed`. Si on rendait le tuto
 * dans le shadow Vespry, son backdrop ne couvrirait pas le viewport et
 * le spotlight serait calé sur la box de l'overlay au lieu de l'écran.
 *
 * D'où ce module : un host indépendant attaché à `document.body`, avec
 * son propre shadow DOM et son propre CSS embarqué. Le tuto peut alors
 * cibler aussi bien le bouton lanceur Vespry (DOM principal Discord) que
 * les éléments de l'overlay Vespry (autre shadow root).
 */
import { render } from 'preact';
import { Tutorial } from './Tutorial';
import tutorialCss from './Tutorial.css?inline';
import { getThemePref, resolveTheme } from '../../ui/theme-pref';

const HOST_ID = 'vespry-tutorial-host';
let host: HTMLDivElement | null = null;
let mountPoint: HTMLDivElement | null = null;

/**
 * Ouvre le tuto. Si déjà ouvert (host présent), no-op. `startStep` permet
 * d'enchaîner depuis un step précis (ex. step 1 si l'overlay vient
 * d'être ouvert et qu'on saute le step 0 du bouton lanceur).
 */
export async function openTutorial(startStep = 0): Promise<void> {
  if (host) return;
  if (!document.body) return;
  host = document.createElement('div');
  host.id = HOST_ID;
  // Propage le thème actuel sur le host pour que Tutorial.css branche les
  // variables claires/sombres. Cf. audit Codex 2026-05-22 #9.
  const pref = await getThemePref();
  host.setAttribute('data-theme', resolveTheme(pref));
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = tutorialCss;
  shadow.appendChild(style);

  mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  document.body.appendChild(host);

  render(<Tutorial startStep={startStep} onClose={closeTutorial} />, mountPoint);
}

/**
 * Démonte le tuto. IMPORTANT : `render(null, mountPoint)` AVANT de retirer
 * le host du DOM, sinon les `useEffect` du composant Tutorial ne nettoient
 * pas leurs ressources (le `requestAnimationFrame` continue à tourner et
 * le `keydown` reste accroché à `window`). Cf. audit Codex 2026-05-22 #1.
 */
export function closeTutorial(): void {
  if (!host) return;
  if (mountPoint) render(null, mountPoint);
  host.remove();
  host = null;
  mountPoint = null;
}

export function isTutorialOpen(): boolean {
  return host !== null;
}
