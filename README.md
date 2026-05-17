# Vespry — Discord Export

> ⚠️ Codename provisoire (`Vespry`). Nom et logo définitifs à arrêter avant
> publication sur le Chrome Web Store.

Extension Chrome qui exporte l'historique complet d'un serveur ou d'une
conversation Discord — **sans casser sur les gros volumes**, avec une sortie
**directement exploitable par une IA**.

## Pourquoi

Les extensions d'export Discord cassent sur les gros serveurs : elles lancent le
téléchargement trop tôt, le fetch dépasse le délai, le navigateur annule. Vespry
écrit chaque lot de 100 messages dans IndexedDB *immédiatement* : fermer le
navigateur, rebooter, revenir — l'export reprend où il s'était arrêté. Le bug ne
devient pas « corrigé », il devient impossible.

La sortie est un paquet pensé pour l'analyse par IA : JSON structuré par salon,
images résolues en chemins locaux, fils de réponses, `INDEX.md`.

## Statut

En construction. Voir le plan : `../../../Brain/notes/sessions/2026-05-16-discord-scraping/PLAN.md`.

## Développement

```bash
npm install
npm run dev        # build watch + HMR
npm run build      # build de production -> dist/
npm run test       # tests unitaires (vitest)
npm run typecheck  # vérification de types
```

Charger l'extension : `chrome://extensions` → mode développeur → « Charger
l'extension non empaquetée » → dossier `dist/`.

## Avertissement

Automatiser un compte utilisateur Discord est contraire aux conditions
d'utilisation de Discord. Cet outil est fourni tel quel ; utilisez-le sur vos
propres données et à vos risques.

## Licence

MIT. Le client API Discord (`src/engine/discord-api.ts`) dérive de Discrub
Classic (MIT). « Discrub » est une marque de prathercc, non utilisée ici.
