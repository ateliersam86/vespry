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
import { isBridgeTokenMessage } from '../messaging';
import { saveToken } from '../engine/auth';
import { RemoteController } from '../ui/remote-controller';
import { installGlobalHandlers } from '../diagnostics';
import { toggleOverlay } from './overlay/mount';

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

function injectLauncher(): void {
  if (document.getElementById(LAUNCH_ID)) return;
  const btn = document.createElement('button');
  btn.id = LAUNCH_ID;
  btn.textContent = 'Vespry';
  btn.style.cssText = [
    'position:fixed', 'top:10px', 'right:16px', 'z-index:2147482000',
    'background:#6c5ce0', 'color:#fff', 'border:0', 'border-radius:8px',
    'font:600 13px "gg sans",Helvetica,Arial,sans-serif', 'padding:7px 13px',
    'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,.4)',
  ].join(';');
  btn.addEventListener('click', () => toggleOverlay(controller));
  document.body.appendChild(btn);
  updateLauncher();
}

/** Affiche le % de l'export en cours sur le bouton lanceur. */
function updateLauncher(): void {
  const btn = document.getElementById(LAUNCH_ID);
  if (!btn) return;
  const running = controller.queue.find((q) => q.status === 'in_progress');
  if (running) {
    const pct = running.channelsTotal > 0
      ? Math.round((running.channelsDone / running.channelsTotal) * 100)
      : 0;
    btn.textContent = `Vespry · ${pct}%`;
  } else {
    btn.textContent = 'Vespry';
  }
}

controller.subscribe(updateLauncher);

// Discord est une SPA : on injecte une fois et on re-vérifie périodiquement.
injectLauncher();
setInterval(injectLauncher, 4000);
