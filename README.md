# Vespry

Vespry est une extension Chrome qui exporte l'historique de tes conversations
Discord — serveurs, salons, messages privés — dans un fichier, sur ton
ordinateur.

Un serveur que tu quittes, des messages privés à garder, une communauté qui
ferme : Discord ne te laisse rien emporter. Vespry, si.

![L'overlay Vespry sur Discord](docs/screenshots/overlay.png)

## Le problème

La plupart des extensions d'export cassent sur les gros serveurs. Elles
chargent tout l'historique d'un bloc, le navigateur dépasse le délai, l'onglet
plante — et tu n'as rien.

Vespry prend le problème à l'envers. Chaque centaine de messages est écrite sur
le disque (IndexedDB) au fur et à mesure. Si l'export s'interrompt — onglet
fermé, plante, coupure — il reprend depuis le dernier point enregistré au lieu
de tout recommencer. L'export tourne dans un contexte séparé de l'onglet
Discord : tu peux fermer l'onglet, il continue.

## Fonctionnalités

### Interface façon Discord

L'extension s'ouvre par-dessus Discord. À gauche, tes serveurs et tes
conversations privées ; au centre, l'aperçu des messages ; à droite, les
réglages de l'export. Rien à apprendre — c'est la disposition que tu connais
déjà.

### Zones de sélection

Tu n'es pas obligé de tout exporter. Une zone de sélection cible une partie
précise de l'historique : une période, un auteur, un mot-clé, une mention, les
messages épinglés, ceux avec une pièce jointe ou un lien. Tu peux aussi cocher
des messages un par un dans l'aperçu.

Les zones se combinent : l'export est l'union de toutes les zones actives,
listées sous forme d'étiquettes que tu peux retirer d'un clic. Sans aucune
zone, le salon entier est exporté.

![Zones de sélection — filtre par auteur](docs/screenshots/zones.png)

### Aperçu des messages

Avant d'exporter, tu vois le contenu réel du salon : messages, réactions,
images, audio, vidéo, stickers, embeds. L'aperçu défile à l'infini — remonte
aussi loin que tu veux dans l'historique.

### Médias

Images, vidéos, audio, fichiers : tu choisis quels types télécharger. Les
liens Discord expirent vite ; Vespry récupère les fichiers pendant l'export et
les range dans le paquet final.

### File d'export increvable

Les exports s'enchaînent dans une file. Chaque tâche affiche son avancement,
une console en temps réel, le détail par type de média. Pendant un export, un
badge de pourcentage s'affiche sur l'icône de l'extension — visible quel que
soit l'onglet où tu es.

Un export interrompu peut être repris. C'est le cœur de Vespry, et c'est
couvert par les tests automatiques.

### Popup

Un clic sur l'icône de l'extension : l'état de la session, les exports en
cours, l'accès rapide à Discord.

## Installation

En attendant la publication sur le Chrome Web Store :

1. Récupère le dossier `dist/` (ou compile-le, voir plus bas).
2. `chrome://extensions` → active le **mode développeur**.
3. **Charger l'extension non empaquetée** → sélectionne le dossier `dist/`.
4. Ouvre Discord, connecte-toi. Le bouton **Vespry** apparaît en haut à droite.

## Le fichier exporté

L'export est une archive `.zip` autonome :

- les messages en JSON structuré, un fichier par salon ;
- les médias téléchargés, rangés dans des dossiers ;
- un `INDEX.md` qui récapitule le contenu.

Le format est lisible tel quel, et propre à archiver, relire, ou donner à
analyser à un outil tiers.

## Soutenir le projet

Vespry est gratuit et open source, sans publicité. Si l'outil t'a rendu
service, tu peux soutenir son développement via
[GitHub Sponsors](https://github.com/sponsors/ateliersam86).

## Développement

```bash
npm install
npm run dev        # build watch + HMR
npm run build      # build de production -> dist/
npm run test       # tests unitaires (vitest)
npm run typecheck  # vérification de types
```

L'extension est en TypeScript strict (Manifest V3, Vite, Preact). Le moteur
d'export est couvert par des tests unitaires, dont la reprise d'un export
interrompu.

## Avertissement

Automatiser un compte utilisateur Discord est contraire aux conditions
d'utilisation de Discord. Cet outil est fourni tel quel ; utilise-le sur tes
propres données, à tes risques.

## Licence

MIT. Le client API Discord (`src/engine/discord-api.ts`) dérive de Discrub
Classic (MIT). « Discrub » est une marque de prathercc, non utilisée ici.
