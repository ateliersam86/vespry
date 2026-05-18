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
import type {
  ExportFormat,
  MediaSelection,
  SelectionZone,
  ZoneMode,
} from './engine/checkpoint-types';
import type { RawChannel, RawGuild, RawMessage, Snowflake } from './engine/types';
import type { DonorFeed } from './donors';

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

/**
 * Vue d'une tâche de purge (Phase 2 — fonctionnalité de suppression).
 *
 * Parallèle à `QueueItemView`, indépendante de l'export. Le moteur supprime
 * les messages un par un côté Discord ; la vue lit ces champs pour afficher
 * la progression (« 12 / 50 supprimés, 1 échec »).
 */
export interface PurgeItemView {
  /** Id local de la purge (`purge_<ts>_<rand>`) — pas lié à Discord. */
  runId: string;
  guildName: string;
  channelId: Snowflake;
  channelName: string;
  status: 'in_progress' | 'completed' | 'partial' | 'failed';
  /** Nombre total de messages dans la sélection initiale. */
  total: number;
  /** Messages traités avec succès (204 ou 404 — idempotent). */
  done: number;
  /** Messages refusés (403) ou en erreur non récupérable, traités quand même. */
  failed: number;
  /** Lignes de la mini-console (plafonné à 250). */
  log: string[];
}

export interface VespryState {
  ready: boolean;
  error: string | null;
  userName: string | null;
  guilds: RawGuild[];
  queue: QueueItemView[];
  /** File des opérations de purge en cours / terminées (Phase 2). */
  purgeQueue: PurgeItemView[];
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
      zones: SelectionZone[];
      zoneMode: ZoneMode;
      /** Export incrémental — ne reprendre que les messages postés depuis
       *  le dernier export du même serveur. */
      incremental?: boolean;
      /** Messages/fichier (0 = pas de découpage). */
      partitionSize: number;
      formats: ExportFormat[];
    }
  | { cmd: 'resume'; runId: string }
  | {
      cmd: 'download';
      runId: string;
      /**
       * Nom de fichier final (avec extension). Calculé côté UI à partir du
       * template configuré par l'utilisateur (Phase 3 — templates de zip).
       * Quand absent, le contrôleur retombe sur son défaut historique
       * `vespry-${safe(guildName)}.zip`.
       */
      filename?: string;
    }
  | { cmd: 'preview'; channelId: string; before?: string }
  | { cmd: 'get-donors' }
  | {
      cmd: 'checkout';
      /** Montant du don, en centimes. */
      amountCents: number;
      donorName?: string;
      message?: string;
      isPublic: boolean;
    }
  | {
      /**
       * Déclenche un export incrémental d'un serveur planifié (Phase 3).
       * Émis par le service worker quand `chrome.alarms.onAlarm` réveille
       * Vespry. L'offscreen charge la liste des salons du guild ciblé et
       * `enqueue()` avec `incremental: true` + médias/formats par défaut.
       */
      cmd: 'scheduled-export-fire';
      guildId: string;
      guildName: string;
    }
  | {
      /**
       * Phase 2 — purge de messages. La sélection vient de l'overlay
       * (cases cochées dans l'aperçu, validation explicite par l'utilisateur).
       */
      cmd: 'purge';
      guild: RawGuild;
      channelId: Snowflake;
      channelName: string;
      messageIds: Snowflake[];
    };

/**
 * Paramètres d'un export passés à `enqueue`, hors guild/channels/media.
 * Bundle partagé par le RemoteController (vue) et le VespryController (moteur).
 */
export interface EnqueueExtras {
  includeThreads: boolean;
  includeReactionUsers?: boolean;
  zones: SelectionZone[];
  zoneMode: ZoneMode;
  /** Export incrémental — résolu en `sinceMs` par le contrôleur. */
  incremental?: boolean;
  /** Messages/fichier (0 = pas de découpage). */
  partitionSize: number;
  formats: ExportFormat[];
}

/** Réponse à une commande. `data` selon la commande. */
export interface CommandResponse {
  ok: boolean;
  error?: string;
  state?: VespryState;
  channels?: RawChannel[];
  /** Aperçu de messages récents (commande `preview`). */
  messages?: RawMessage[];
  /** Flux du mur des soutiens (commande `get-donors`) — null si indisponible. */
  donors?: DonorFeed | null;
  /** URL de la session Stripe Checkout (commande `checkout`). */
  checkoutUrl?: string;
  /** Id local de la purge créée (commande `purge`). */
  purgeRunId?: string;
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
