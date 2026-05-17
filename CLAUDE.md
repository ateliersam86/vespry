# Vespry — extension Chrome d'export Discord

Extension Manifest V3 qui exporte l'historique de serveurs/conversations Discord
de façon increvable (checkpoint IndexedDB) avec une sortie agent-ready.

## Architecture

Quatre contextes d'exécution, à ne jamais confondre :

- `src/background/service-worker.ts` — éphémère (MV3 le tue). Routage de
  messages + ouverture d'onglets UNIQUEMENT. Aucun travail long ici.
- `src/content/discord-bridge.ts` — content script monde MAIN. Patche fetch/XHR
  pour capter l'en-tête `authorization`. Le jeton n'est plus dans localStorage
  depuis fin 2023.
- `src/content/content-script.ts` — content script monde ISOLATED. Relais du
  jeton + injection de l'overlay (Shadow DOM).
- `src/offscreen/offscreen.html` + `offscreen.ts` — document offscreen
  invisible et tab-indépendant. C'est ICI que tourne le moteur d'export et la
  reprise (`VespryController`), jamais dans le service worker.

## Moteur (`src/engine/`)

- `discord-api.ts` — client API Discord. Dérivé de Discrub Classic (MIT).
- `auth.ts` — capture/stockage du jeton de session.
- `checkpoint-store.ts` — IndexedDB, source de vérité (runs/channels/messages/assets).
- `export-runner.ts` — orchestrateur checkpoint-natif.
- `packager.ts` — génère le paquet agent-ready (JSON, media, INDEX, zip).

## Service de dons (`donor-service/`)

Cloudflare Worker indépendant (sa propre `package.json`, hors build Vite).
Ingère les webhooks Ko-Fi et GitHub Sponsors, range les soutiens dans D1, et
expose `GET /donors`. L'extension consomme ce flux pour le footer « Mur des
soutiens ». Le fetch passe par l'offscreen (la CSP de Discord bloque l'overlay).
Contrat partagé : `donor-service/src/donors.ts` ↔ `src/donors.ts`.

## Règles

- TypeScript strict, pas de `any`. Tests unitaires sur le moteur (vitest).
- Robustesse > vitesse. Tout export doit être resumable.
- Médias téléchargés au fil de l'eau (liens CDN Discord signés, expirent ~24 h).
- Spec autoritative : design doc dans
  `~/.gstack/projects/Dicordscraping/samuelmuselet-unknown-design-20260516-145957.md`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool.
- Bugs/errors → /investigate
- Code review → /review
- QA → /qa
- Ship → /ship
