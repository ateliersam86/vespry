# Publication Vespry sur le Chrome Web Store

Procédure de soumission de Vespry sur le Chrome Web Store (CWS).
Cible : Chrome Desktop (Windows / macOS / Linux / ChromeOS), tous marchés, MV3.

Le même paquet est accepté tel quel par **Microsoft Edge Add-ons** (Chromium) —
cf. `edge.md` pour la procédure Edge.

## Pré-requis

- Compte développeur Chrome Web Store : **frais uniques de 5 $** (CB),
  inscription : https://chrome.google.com/webstore/devconsole/.
- L'artefact à uploader : `vespry-<version>.zip`, produit à partir de `dist/`.

## Construire le paquet à soumettre

```sh
# build TypeScript + Vite vers dist/
npm run build

# zipper le contenu de dist/
cd dist && zip -r ../vespry-<version>.zip . && cd ..
```

Le zip à uploader vit à la racine du repo : `vespry-<version>.zip`.

Avant chaque soumission, vérifier :

1. `manifest.json` à la racine du zip (et non dans un sous-dossier `dist/`).
2. `manifest_version: 3`.
3. `version` cohérent avec `package.json`.
4. `name`, `description`, `icons` (16/48/128) présents.
5. `permissions` cohérent avec ce qui sera justifié dans la fiche.

## Permissions à justifier (texte prêt à coller)

Le CWS demande de justifier chaque permission **et** la mention « usage des
données utilisateur ». Voici les justifications correspondant à `manifest.ts` :

| Permission | Justification |
|---|---|
| `storage` | Stocke les préférences de l'utilisateur (thème, mode Avancé, template de nom de fichier zip, planning d'export) et le jeton de session Discord capté pour les appels API d'export. |
| `unlimitedStorage` | IndexedDB stocke les blobs des médias téléchargés pendant un export — un gros serveur peut dépasser les 100 Mo du quota par défaut, ce qui ferait crasher l'export. |
| `tabs` | Ouvre / active l'onglet Discord depuis le popup quand l'utilisateur clique « Ouvrir Discord ». |
| `offscreen` | Héberge le moteur d'export dans un document offscreen tab-indépendant — sans cette permission, l'export s'interromprait dès que l'onglet Discord est fermé. |
| `notifications` | Avertit l'utilisateur quand un export se termine, est mis en pause (jeton expiré) ou échoue. Aucune notification non sollicitée. |
| `downloads` | Déclenche le téléchargement de l'archive `.zip` finale. |
| `alarms` | Réveille Vespry aux heures programmées par l'utilisateur pour les exports récurrents (mode Avancé → Planification). |

`host_permissions` (`discord.com`, `cdn.discordapp.com`, `media.discordapp.net`) :
nécessaires pour appeler l'API Discord et télécharger les médias (les CDN
Discord refusent les requêtes cross-origin sans cette déclaration).

## Déclaration d'usage des données utilisateur

Le CWS exige une déclaration explicite (« Privacy practices »). Cocher :

- **Authentication information** — le jeton de session Discord est lu pour
  appeler l'API au nom de l'utilisateur. Non transmis à un serveur tiers.
- **Personal communications** — les messages exportés sont des
  communications personnelles. Restent en local sur l'ordinateur de
  l'utilisateur.

Ne **pas** cocher :

- Personally identifiable information (autre que les deux ci-dessus).
- Health, financial, location, web history.
- User activity (clics, navigation, etc.).
- Website content (hors Discord).

URL de la politique de confidentialité : pointer vers la section
« Confidentialité » du README sur GitHub
(`https://github.com/ateliersam86/vespry#confidentialité`), ou copier
cette section dans une page dédiée si CWS exige une URL distincte.

## Fiche du store

- **Nom court** : `Vespry — Discord Export`
- **Description courte** (132 caractères max) :
  `Exporte ton historique Discord — serveurs, salons, DMs — dans un zip,
  en local. Reprend après crash. 15 langues. Gratuit, open source.`
- **Catégorie** : « Productivité » (sous-cat. « Utilities »).
- **Langue principale** : `fr` (français), avec la traduction `en` en
  complément (les deux fiches partagent les captures).

## Captures écran

Cinq captures minimum, **1280 × 800** (recommandé) ou 640 × 400. Reprendre
celles de `docs/screenshots/` :

1. `overlay.png` — l'overlay sur Discord.
2. `advanced.png` — mode Avancé, filtres, ET / OU.
3. `multi-select.png` — multi-sélection de salons.
4. `html-export.png` — rendu de l'export HTML.
5. `export-done.png` — file d'export, statistiques.

Ajouter selon disponibilité : `purge-modal.png`, `schedule.png`,
`password.png`, `filename-template.png`.

## Avis aux reviewers (champ « Notes for reviewers »)

Texte à coller dans le champ « Single purpose / Permissions / Notes » :

```
Vespry est un outil d'export d'historique Discord à usage personnel.

PURPOSE: Allow Discord users to export their own message history
(servers, DMs) to local files (JSON, HTML, CSV, TXT) — same as
Discord's official "Request Data" feature, but immediate, structured,
and locally controlled.

DATA HANDLING: 100% local. The Discord session token is read from
the page and used only to call Discord's own API on behalf of the
user. No data is ever sent to a third-party server.

OPTIONAL TELEMETRY: A "schema watch" toggle (default OFF, advanced
panel) sends ONLY {version, locale, field_names[]} when Discord
ships an unknown API field — no token, no message content, no IDs.
Source: src/engine/schema-report.ts (~75 lines).

OPTIONAL DONATIONS: Stripe Checkout opens in a popup when user clicks
"Support" — no card data ever touches Vespry. Donor wall is
public-only aggregated content from a Cloudflare Worker (no tracking).

DISCLAIMER: Automating a Discord user account is against Discord ToS.
Tool is for personal use on one's own data, at user's own risk.
This is stated in the README and in-extension.

The source code is at https://github.com/ateliersam86/vespry (MIT).
```

## Délai de review

CWS : généralement **2 à 7 jours** pour une première soumission.
Les mises à jour suivantes : **24 à 72 h**.

## Mises à jour ultérieures

Le **CWS API** permet d'automatiser l'upload des mises à jour
(`chrome.webstore.upload` + OAuth Google). À mettre en place dans la CI une
fois le compte développeur créé. Référence officielle :
https://developer.chrome.com/docs/webstore/using-api.

## Statut du dépôt

- Repo : https://github.com/ateliersam86/vespry
- Licence : MIT — fichier `LICENSE` à la racine.
- `manifest.json` est généré par Vite à partir de `src/manifest.ts`.
