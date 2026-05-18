import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

// `process` est fourni par Node au moment du build (vite). Déclaré localement
// pour ne pas dépendre de @types/node dans le tsconfig de l'extension.
declare const process: { env: Record<string, string | undefined> };

/**
 * Manifest V3 — Vespry, port Firefox.
 *
 * Pourquoi un manifest séparé. Firefox MV3 diverge du Chrome MV3 sur deux
 * points critiques pour Vespry :
 *
 * 1. Pas de `chrome.offscreen`. Le moteur d'export, qui vit dans un document
 *    offscreen sur Chrome, est hébergé ici dans une **event page** (background
 *    script non-persistant). C'est `src/firefox/background.ts` qui prend le
 *    rôle du couple service worker + offscreen du build Chrome.
 *
 * 2. Pas de `service_worker` côté background. Firefox 115+ accepte uniquement
 *    `background.scripts` + `persistent: false` (event page MV3). La page
 *    reste vivante tant qu'un handler ou un `port` est ouvert — et l'overlay
 *    ouvre un `chrome.runtime.connect` persistant le temps d'un export pour
 *    empêcher l'event page de s'endormir au milieu d'un run.
 *
 * Le reste du manifeste est volontairement identique au build Chrome
 * (`src/manifest.ts`) pour que les content scripts, le popup, l'overlay et
 * les permissions soient inchangés — un seul moteur, deux orchestrations.
 */
export default defineManifest({
  manifest_version: 3,
  name: 'Vespry — Discord Export',
  // Cf. `src/manifest.ts` : `VESPRY_BUILD_VERSION` permet aux builds de dev
  // d'avoir une version unique pour déclencher la mise à jour de l'extension.
  version: process.env.VESPRY_BUILD_VERSION || pkg.version,
  description:
    'Crash-proof, AI-ready Discord chat exporter. Resumes after a crash, '
    + 'outputs a package an AI agent can analyze.',

  // `browser_specific_settings` est REQUIS pour publier sur addons.mozilla.org.
  // L'id reste stable d'une release à l'autre (identifie l'extension côté AMO).
  // `strict_min_version` 115.0 = première version Firefox stable avec MV3 +
  // event pages + content scripts world MAIN — minimum pour Vespry.
  browser_specific_settings: {
    gecko: {
      id: 'vespry@ateliersam86.github.io',
      strict_min_version: '115.0',
      // Manifest V3 sur AMO depuis fin 2024 exige `data_collection_permissions`
      // (réglementation EU AI Act). Vespry ne collecte aucune donnée
      // utilisateur tierce : tout reste local (IndexedDB → zip).
      // - `authenticationInfo` : le jeton de session Discord est lu et utilisé
      //   pour appeler l'API Discord (rien d'autre).
      // - `personalCommunications` : on lit les messages Discord pour les
      //   exporter — par essence du contenu de communication personnel.
      // Pas de catégorie « technicalAndInteraction » ni « locationInfo » :
      // aucune télémétrie, aucune géolocalisation.
      data_collection_permissions: {
        required: ['authenticationInfo', 'personalCommunications'],
      },
    },
  },

  action: {
    default_popup: 'src/popup/popup.html',
    default_title: 'Vespry — Discord Export',
  },

  // Event page MV3 côté Firefox : `scripts` + `persistent: false`. Pas de
  // `service_worker` — Firefox ne le supporte pas. @crxjs sait gérer les deux
  // formes selon la cible.
  background: {
    scripts: ['src/firefox/background.ts'],
    type: 'module',
    persistent: false,
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
    // Pas d'`offscreen` : non supporté par Firefox. Le moteur est dans
    // l'event page (cf. `src/firefox/background.ts`).
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
