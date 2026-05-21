/**
 * Montage de l'overlay dans un Shadow DOM.
 *
 * L'overlay est une VUE : il reçoit un RemoteController (piloté par messaging).
 * Fermer l'overlay ne touche pas au moteur — l'export continue dans l'offscreen.
 */
import { render } from 'preact';
import { Overlay } from './Overlay';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import type { RemoteController } from '../../ui/remote-controller';
import overlayCss from './overlay.css?inline';

const HOST_ID = 'vespry-overlay-host';
let host: HTMLDivElement | null = null;

export function openOverlay(controller: RemoteController): void {
  if (host) return;
  host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = overlayCss;
  shadow.appendChild(style);

  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  document.body.appendChild(host);

  render(
    <ErrorBoundary context="overlay">
      <Overlay controller={controller} onClose={closeOverlay} />
    </ErrorBoundary>,
    mountPoint,
  );
}

export function closeOverlay(): void {
  if (!host) return;
  host.remove();
  host = null;
}

export function toggleOverlay(controller: RemoteController): void {
  if (host) closeOverlay();
  else openOverlay(controller);
}
