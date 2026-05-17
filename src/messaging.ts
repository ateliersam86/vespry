/**
 * Contrats de messages entre les contextes de l'extension.
 *
 * Topologie :
 * - `window.postMessage` — bridge (monde MAIN) → content script (ISOLATED).
 * - `chrome.runtime` — vues (overlay, popup) → service worker → offscreen.
 *   Le service worker est le broker : il garantit que l'offscreen existe,
 *   relaie les commandes, et rediffuse l'état (badge + onglets Discord).
 *
 * Le moteur d'export vit dans l'offscreen document (tab-indépendant).
 */
import type { MediaSelection, MessageFilters } from './engine/checkpoint-types';
import type { RawChannel, RawGuild } from './engine/types';

// --- bridge MAIN → ISOLATED (capture du jeton) ---

export const BRIDGE_SOURCE = 'vespry-bridge' as const;

export interface BridgeTokenMessage {
  source: typeof BRIDGE_SOURCE;
  type: 'token';
  token: string;
}

export function isBridgeTokenMessage(data: unknown): data is BridgeTokenMessage {
  return (
    typeof data === 'object'
    && data !== null
    && (data as { source?: unknown }).source === BRIDGE_SOURCE
    && (data as { type?: unknown }).type === 'token'
    && typeof (data as { token?: unknown }).token === 'string'
  );
}

// --- état sérialisable diffusé par l'offscreen ---

/** Vue d'une tâche d'export (sans le Blob — non sérialisable en messaging). */
export interface QueueItemView {
  runId: string;
  guildName: string;
  status: string;
  channelsTotal: number;
  channelsDone: number;
  messages: number;
  assetsByKind: { image: number; video: number; audio: number; file: number };
  reactions: number;
  log: string[];
  zipReady: boolean;
}

export interface VespryState {
  ready: boolean;
  error: string | null;
  userName: string | null;
  guilds: RawGuild[];
  queue: QueueItemView[];
}

// --- commandes vue → offscreen (via le service worker) ---

export type VespryCommand =
  | { cmd: 'get-state' }
  | { cmd: 'load-channels'; guildId: string }
  | {
      cmd: 'enqueue';
      guild: RawGuild;
      channels: RawChannel[];
      media: MediaSelection;
      includeThreads: boolean;
      includeReactionUsers?: boolean;
      afterMs?: number;
      beforeMs?: number;
      filters?: MessageFilters;
    }
  | { cmd: 'resume'; runId: string }
  | { cmd: 'download'; runId: string };

/**
 * Paramètres d'un export passés à `enqueue`, hors guild/channels/media.
 * Bundle partagé par le RemoteController (vue) et le VespryController (moteur).
 */
export interface EnqueueExtras {
  includeThreads: boolean;
  includeReactionUsers?: boolean;
  afterMs?: number;
  beforeMs?: number;
  filters?: MessageFilters;
}

/** Réponse à une commande. `data` selon la commande. */
export interface CommandResponse {
  ok: boolean;
  error?: string;
  state?: VespryState;
  channels?: RawChannel[];
}

// --- messages de routage ---

/** Vue → service worker : « exécute cette commande sur l'offscreen ». */
export interface CommandEnvelope {
  kind: 'vespry-command';
  command: VespryCommand;
}

/** Service worker → offscreen : commande à exécuter (offscreen garanti vivant). */
export interface ExecEnvelope {
  kind: 'vespry-exec';
  command: VespryCommand;
}

export function isExecEnvelope(m: unknown): m is ExecEnvelope {
  return typeof m === 'object' && m !== null
    && (m as { kind?: unknown }).kind === 'vespry-exec';
}

/** Offscreen → service worker → vues : diffusion d'état. */
export interface StateBroadcast {
  kind: 'vespry-state';
  state: VespryState;
}

/** Service worker → ouvrir Discord (depuis le popup). */
export interface OpenDiscordMessage {
  kind: 'open-discord';
}

/** Offscreen → service worker : déclenche un téléchargement de fichier. */
export interface DoDownloadMessage {
  kind: 'do-download';
  url: string;
  filename: string;
}

export function isDoDownload(m: unknown): m is DoDownloadMessage {
  return typeof m === 'object' && m !== null
    && (m as { kind?: unknown }).kind === 'do-download';
}

/**
 * Offscreen → service worker : « donne-moi le jeton ».
 * Les documents offscreen n'ont pas accès à `chrome.storage` ; seul le
 * service worker peut le lire. Réponse : `{ token: string | null }`.
 */
export interface GetTokenMessage {
  kind: 'get-token';
}

export function isGetToken(m: unknown): m is GetTokenMessage {
  return typeof m === 'object' && m !== null
    && (m as { kind?: unknown }).kind === 'get-token';
}

export function isCommandEnvelope(m: unknown): m is CommandEnvelope {
  return typeof m === 'object' && m !== null
    && (m as { kind?: unknown }).kind === 'vespry-command';
}

export function isStateBroadcast(m: unknown): m is StateBroadcast {
  return typeof m === 'object' && m !== null
    && (m as { kind?: unknown }).kind === 'vespry-state';
}
