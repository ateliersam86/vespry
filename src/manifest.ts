import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

// `process` est fourni par Node au moment du build (vite). Déclaré localement
// pour ne pas dépendre de @types/node dans le tsconfig de l'extension.
declare const process: { env: Record<string, string | undefined> };

/**
 * Manifest V3 — Vespry.
 *
 * Architecture des contextes (cf. design doc, "Contexte d'exécution") :
 * - `background/service-worker.ts` — éphémère, ne fait QUE du routage de
 *   messages et l'ouverture d'onglets. Aucun travail long ici (MV3 le tue).
 * - `content/discord-bridge.ts` — content script en monde MAIN : patche
 *   fetch/XHR pour capter l'en-tête `authorization` des requêtes que Discord
 *   émet lui-même. C'est le seul moyen fiable d'obtenir le jeton de session
 *   depuis fin 2023 (il n'est plus dans localStorage).
 * - `content/content-script.ts` — content script en monde ISOLATED : reçoit
 *   le jeton du bridge, injecte le bouton lanceur et l'overlay (Shadow DOM).
 *   L'overlay est une VUE : il pilote le moteur par messaging.
 * - `offscreen/offscreen.html` — document offscreen invisible : héberge le
 *   moteur d'export (VespryController). Persistant, indépendant des onglets —
 *   l'export tourne même si l'onglet Discord est fermé.
 * - `popup/popup.html` — ouvre Discord, affiche les exports en cours.
 */
export default defineManifest({
  manifest_version: 3,
  name: 'Vespry — Discord Export',
  // `VESPRY_BUILD_VERSION` donne aux builds de dev (cf. scripts/play.mjs) une
  // version unique : Chrome voit alors une « mise à jour » et ré-enregistre
  // l'extension. Sans ça, sur un profil réutilisé, Chrome sert une version
  // en cache et les content scripts cassent. Vide en CI / release.
  version: process.env.VESPRY_BUILD_VERSION || pkg.version,
  description:
    'Crash-proof, AI-ready Discord chat exporter. Resumes after a crash, '
    + 'outputs a package an AI agent can analyze.',
  minimum_chrome_version: '110',

  action: {
    default_popup: 'src/popup/popup.html',
    default_title: 'Vespry — Discord Export',
  },

  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },

  content_scripts: [
    {
      // Monde MAIN : accès aux objets de la page pour patcher fetch/XHR.
      matches: ['https://discord.com/*', 'https://*.discord.com/*'],
      js: ['src/content/discord-bridge.ts'],
      run_at: 'document_start',
      world: 'MAIN',
    },
    {
      // Monde ISOLATED : accès aux API chrome.* + injection de l'overlay.
      matches: ['https://discord.com/*', 'https://*.discord.com/*'],
      js: ['src/content/content-script.ts'],
      run_at: 'document_idle',
    },
  ],

  permissions: [
    'storage',
    'unlimitedStorage', // IndexedDB stocke les blobs média — quota levé
    'tabs', // ouvrir/activer l'onglet Discord depuis le popup
    'offscreen', // document offscreen qui héberge le moteur d'export
    'notifications', // notifier fin d'export / session expirée
    'downloads', // déclencher le téléchargement du zip
  ],

  host_permissions: [
    'https://discord.com/*',
    'https://*.discord.com/*',
    'https://cdn.discordapp.com/*',
    'https://media.discordapp.net/*',
  ],

  icons: {
    16: 'src/assets/icon-16.png',
    48: 'src/assets/icon-48.png',
    128: 'src/assets/icon-128.png',
  },
});
