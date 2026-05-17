/**
 * Document offscreen — héberge le moteur d'export.
 *
 * Contexte invisible, persistant, indépendant des onglets : l'export tourne
 * même si l'onglet Discord est fermé. Reçoit les commandes (relayées par le
 * service worker) et diffuse l'état à chaque changement.
 */
import { VespryController } from '../content/overlay/controller';
import { installGlobalHandlers } from '../diagnostics';
import { loadCredits } from '../credits';
import { createCheckout, fetchDonorFeed } from '../donors';
import {
  isExecEnvelope,
  type CommandResponse,
  type EnqueueExtras,
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
    case 'enqueue': {
      const extras: EnqueueExtras = {
        includeThreads: command.includeThreads,
        zones: command.zones,
        zoneMode: command.zoneMode,
        partitionSize: command.partitionSize,
        formats: command.formats,
      };
      if (command.includeReactionUsers) extras.includeReactionUsers = true;
      if (command.incremental) extras.incremental = true;
      await controller.enqueue(command.guild, command.channels, command.media, extras);
      return { ok: true, state: controller.toState() };
    }
    case 'resume':
      controller.resume(command.runId);
      return { ok: true };
    case 'download':
      controller.downloadZip(command.runId);
      return { ok: true };
    case 'preview':
      return {
        ok: true,
        messages: await controller.previewChannel(command.channelId, command.before),
      };
    case 'get-donors': {
      // Le fetch du mur des soutiens passe ICI (offscreen) : la CSP de
      // discord.com bloquerait un fetch tiers depuis l'overlay.
      const credits = await loadCredits();
      return { ok: true, donors: await fetchDonorFeed(credits.donorApiUrl) };
    }
    case 'checkout': {
      // Création de la session Stripe Checkout — fetch tiers, donc ICI.
      const credits = await loadCredits();
      const url = await createCheckout(credits.donorApiUrl, {
        amountCents: command.amountCents,
        donorName: command.donorName ?? null,
        message: command.message ?? null,
        isPublic: command.isPublic,
      });
      return url ? { ok: true, checkoutUrl: url } : { ok: true };
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExecEnvelope(message)) return undefined;
  handle(message.command)
    .then(sendResponse)
    .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
  return true; // réponse asynchrone
});
