/**
 * Content script — monde ISOLATED.
 *
 * 1. Reçoit le jeton du bridge (monde MAIN) et le persiste.
 * 2. Injecte le bouton lanceur « Vespry » — qui affiche le % d'un export en cours.
 * 3. Monte/démonte l'overlay (vue Shadow DOM) au clic.
 *
 * Le moteur d'export NE tourne PAS ici : il vit dans l'offscreen document.
 * Ce script ne fait que piloter une vue via le RemoteController.
 */
import { isBridgeTokenMessage, progressPct } from '../messaging';
import { saveToken } from '../engine/auth';
import { RemoteController } from '../ui/remote-controller';
import { installGlobalHandlers } from '../diagnostics';
import { owlSvgString } from '../ui/owl';
import { toggleOverlay } from './overlay/mount';
import { openTutorial, isTutorialOpen, closeTutorial } from './overlay/mount-tutorial';
import { shouldShowTutorial } from './overlay/Tutorial';

installGlobalHandlers('content-script');

// --- 1. Relais du jeton (bridge MAIN → ici) ---
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  if (!isBridgeTokenMessage(event.data)) return;
  void saveToken(event.data.token).catch((e: unknown) => {
    console.error('[Vespry] échec d\'enregistrement du jeton', e);
  });
});

// --- contrôleur de vue (partagé bouton + overlay) ---
const controller = new RemoteController();
void controller.init();

// --- 2. Bouton lanceur ---
const LAUNCH_ID = 'vespry-launch-btn';
const LABEL_ID = 'vespry-launch-label';

function injectLauncher(): void {
  if (document.getElementById(LAUNCH_ID)) return;
  if (!document.body) return; // SPA Discord : body pas encore là au tout début.
  const btn = document.createElement('button');
  btn.id = LAUNCH_ID;
  // z-index 2147483647 = max int32, garantit qu'aucun élément Discord ne peut
  // passer au-dessus. Cf. feedback Sam 2026-05-21 : le bouton avait disparu,
  // probablement masqué par un nouveau wrapper Discord à z-index plus haut.
  btn.style.cssText = [
    'position:fixed', 'top:10px', 'right:16px', 'z-index:2147483647',
    'background:#6c5ce0', 'color:#fff', 'border:0', 'border-radius:9px',
    'font:600 13px "gg sans",Helvetica,Arial,sans-serif', 'padding:5px 12px 5px 7px',
    'cursor:pointer', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
    'display:flex', 'align-items:center', 'gap:7px',
  ].join(';');
  // Mascotte hibou + libellé. Le libellé est dans un span dédié pour que
  // `updateLauncher` puisse l'actualiser sans effacer l'icône.
  // Évite `innerHTML` (anti-pattern signalé par le linter AMO). Important :
  // `DOMParser.parseFromString(..., 'image/svg+xml')` donne un *Document SVG*
  // dont les nœuds appartiennent à ce document — un simple `appendChild`
  // dans un document HTML perd le namespace SVG sur certains navigateurs
  // (le hibou est rendu invisible). `document.importNode(node, true)`
  // recopie le sous-arbre avec namespaces préservés. Cf. feedback Sam
  // 2026-05-21 : « tu n'as toujours pas restauré le logo de Vespry ».
  const svgDoc = new DOMParser().parseFromString(owlSvgString(20), 'image/svg+xml');
  const svgEl = document.importNode(svgDoc.documentElement, true);
  btn.appendChild(svgEl);
  const label = document.createElement('span');
  label.id = LABEL_ID;
  label.textContent = 'Vespry';
  btn.appendChild(label);
  btn.addEventListener('click', () => toggleOverlay(controller));
  document.body.appendChild(btn);
  updateLauncher();
}

/** Affiche le % de l'export en cours sur le bouton lanceur. */
function updateLauncher(): void {
  const label = document.getElementById(LABEL_ID);
  if (!label) return;
  const running = controller.queue.find((q) => q.status === 'in_progress');
  if (running) {
    const pct = progressPct(running);
    label.textContent = `Vespry · ${pct}%`;
  } else {
    label.textContent = 'Vespry';
  }
}

controller.subscribe(updateLauncher);

// Discord est une SPA et peut purger des nœuds racine au changement de vue.
// On injecte une première fois, puis on observe `document.body` pour ré-injecter
// si le bouton disparaît. Plus réactif et moins gaspilleur que le polling 4s.
// Le polling reste en filet de sécurité (cas où Body est remplacé en entier).
injectLauncher();
console.log('[Vespry] launcher init', { hasBody: !!document.body });

const observer = new MutationObserver(() => {
  if (!document.getElementById(LAUNCH_ID)) injectLauncher();
});
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: false });
} else {
  // Body pas encore là (run_at: document_idle est tardif, mais on garde la
  // ceinture-bretelles) — réessaie au DOMContentLoaded.
  document.addEventListener('DOMContentLoaded', () => {
    injectLauncher();
    observer.observe(document.body, { childList: true, subtree: false });
  });
}
// Filet de sécurité : si un wrapper Discord remplace tout le body, le
// MutationObserver attaché à l'ancien body ne déclenche plus. Polling 8s.
setInterval(injectLauncher, 8000);

// --- 3. Tuto : premier launch + bouton « Revoir » depuis le popup ---

/**
 * Premier passage sur Discord (flag `vespry.firstSeenOnDiscord` absent) :
 * on lance le step 0 du tuto qui pointe le bouton lanceur. On attend que
 * le bouton soit injecté (quelques rAF) avant de positionner le spotlight.
 */
async function maybeShowOnboarding(): Promise<void> {
  const should = await shouldShowTutorial();
  if (!should) return;
  // Petit délai pour que le bouton lanceur soit bien rendu (rAF + 200 ms).
  requestAnimationFrame(() => {
    setTimeout(() => openTutorial(0), 200);
  });
}
void maybeShowOnboarding();

/**
 * Listener `chrome.storage.onChanged` : quand le popup remet
 * `vespry.tutoCompleted` à `false`, ça arrive ici et on relance le tuto
 * immédiatement, peu importe que l'overlay soit ouvert ou non. C'est ça
 * qui répare le bouton « Revoir le tuto » que Sam signalait inopérant.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const tuto = changes['vespry.tutoCompleted'];
  if (tuto && tuto.newValue === false && !isTutorialOpen()) {
    // Si l'overlay Vespry est déjà ouvert, on saute le step 0 (bouton
    // lanceur) et on enchaîne avec les steps overlay (1+). Sinon on
    // commence par le step 0 pour que l'utilisateur (re)voie où cliquer.
    const overlayOpen = !!document.getElementById('vespry-overlay-host');
    openTutorial(overlayOpen ? 1 : 0);
  }
});

// Escape ferme aussi le tuto (sécurité). Le composant gère son propre
// listener, on garde celui-ci comme filet pour les cas d'edge.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isTutorialOpen()) closeTutorial();
}, true);
