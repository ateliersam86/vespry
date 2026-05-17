/**
 * Document offscreen — héberge le moteur d'export.
 *
 * Contexte invisible, persistant, indépendant des onglets : l'export tourne
 * même si l'onglet Discord est fermé. Reçoit les commandes (relayées par le
 * service worker) et diffuse l'état à chaque changement.
 */
import { VespryController } from '../content/overlay/controller';
import { installGlobalHandlers } from '../diagnostics';
import {
  isExecEnvelope,
  type CommandResponse,
  type StateBroadcast,
  type VespryCommand,
} from '../messaging';

installGlobalHandlers('offscreen');

const controller = new VespryController();

/** Diffuse l'état courant (capté par le service worker et les vues). */
function broadcast(): void {
  const msg: StateBroadcast = { kind: 'vespry-state', state: controller.toState() };
  chrome.runtime.sendMessage(msg).catch(() => {
    /* aucun récepteur — sans gravité */
  });
}

controller.subscribe(broadcast);
void controller.init().then(broadcast);

async function handle(command: VespryCommand): Promise<CommandResponse> {
  switch (command.cmd) {
    case 'get-state':
      return { ok: true, state: controller.toState() };
    case 'load-channels':
      return { ok: true, channels: await controller.loadChannels(command.guildId) };
    case 'enqueue':
      await controller.enqueue(
        command.guild,
        command.channels,
        command.media,
        {
          ...(command.afterMs !== undefined ? { afterMs: command.afterMs } : {}),
          ...(command.beforeMs !== undefined ? { beforeMs: command.beforeMs } : {}),
        },
        command.includeThreads,
      );
      return { ok: true, state: controller.toState() };
    case 'resume':
      controller.resume(command.runId);
      return { ok: true };
    case 'download':
      controller.downloadZip(command.runId);
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExecEnvelope(message)) return undefined;
  handle(message.command)
    .then(sendResponse)
    .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
  return true; // réponse asynchrone
});
