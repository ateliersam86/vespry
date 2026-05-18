# Publication Vespry sur addons.mozilla.org (AMO)

Procédure de soumission de Vespry sur le store Firefox.
Cible : Firefox Desktop + Firefox Android, MV3, version minimale `142.0`.

## Pré-requis

- Compte développeur sur https://addons.mozilla.org (Firefox account).
- Pour la signature des artefacts (CI / dev) : JWT issuer + secret depuis
  https://addons.mozilla.org/developers/addon/api/key/. Stocker dans
  `coffre` (jamais en clair, jamais commité).
- Variables locales :
  - `WEB_EXT_API_KEY` — l'issuer JWT.
  - `WEB_EXT_API_SECRET` — le secret JWT.

## Construire le paquet Firefox

```sh
# build TypeScript + Vite vers dist-firefox/
npm run build:firefox

# (optionnel) valide le manifeste et le code AMO-style
npm run firefox:lint

# crée le zip soumissible dans web-ext-artifacts/
npm run firefox:package
```

L'artefact final : `web-ext-artifacts/vespry_discord_export-<version>.zip`.
C'est ce zip qui est uploadé sur AMO.

## Lint AMO — état attendu

`web-ext lint --source-dir=dist-firefox` doit afficher :

- **0 erreurs.** Toute erreur bloque la review automatique.
- **3 warnings inhérents aux libs** — sans incidence sur la review :
  - `UNSAFE_VAR_ASSIGNMENT` × 2 sur `assets/theme-pref-*.js` et
    `assets/content-script.ts-*.js` (Preact utilise `innerHTML` pour ses
    rendus — pas de contenu utilisateur non échappé côté Vespry).
  - `DANGEROUS_EVAL` × 1 sur `assets/i18n-*.js` (`Function()` est utilisé
    par `@transcend-io/conflux`, la bibliothèque de zip — pas de
    `Function()` dans le code Vespry lui-même).

Si un nouveau warning ou une erreur apparaît, traiter avant la soumission.

## Tester localement dans Firefox

```sh
# lance Firefox avec dist-firefox/ chargé temporairement et ouvre Discord
npm run firefox:run
```

Web-ext utilise la copie de Firefox installée sur la machine. Sur Mac, le
binaire Firefox Developer Edition est privilégié si présent (variable
`WEB_EXT_FIREFOX_BIN` pour forcer un chemin).

Vérifications manuelles à faire avant chaque release :

1. Le bouton « Vespry » apparaît sur https://discord.com.
2. La connexion à un serveur exporte un salon test.
3. Pendant un export long, ouvrir et fermer un autre onglet — l'export
   doit continuer (port `vespry-keepalive` actif).
4. Tester la pause / reprise (déconnexion / reconnexion Discord).
5. Le téléchargement du zip fonctionne (popup d'option Firefox).

## Soumettre une nouvelle version sur AMO

### Première soumission (création de l'addon)

1. https://addons.mozilla.org/developers/addon/submit/ → « On this site ».
2. Upload du zip `web-ext-artifacts/vespry_discord_export-<version>.zip`.
3. **Source code requis** — AMO exige le code source pour MV3 avec
   `unlimitedStorage`. Soumettre une archive du repo :
   ```sh
   git archive --format=zip --output=vespry-source-<version>.zip HEAD
   ```
   Mozilla relit le code (open source de toute façon — repo public).
4. Renseigner :
   - Nom : `Vespry — Discord Export`.
   - Description longue : reprendre `README.md` (section pitch + features).
   - Catégorie : `Tabs` ou `Other`.
   - Tags : `discord`, `export`, `backup`, `ai`.
   - Captures d'écran : `docs/screenshots/*.png`.
   - Site dev : `https://github.com/ateliersam86/vespry`.
   - Politique de confidentialité — URL ou texte. Voir section dédiée
     `README.md` → Confidentialité, à reprendre intégralement.
5. Choix licence : MIT (déjà déclaré dans le repo).

### Mises à jour

Bumps de version via `package.json` puis :

```sh
npm run build:firefox
npm run firefox:package
# upload du nouveau zip dans Developer Hub > Vespry > New Version
```

L'id de l'addon reste constant (`vespry@ateliersam86.github.io`,
défini dans `src/manifest.firefox.ts`) — c'est la clé d'identification AMO.

## Délais et review

- **Listed** (publié sur le store) : 1-3 jours en review humaine.
  Toute évolution de comportement par rapport à la review précédente
  rallonge le délai. Mozilla peut demander des clarifications côté privacy.
- **Source code review** : Vespry est open source — pas de minification
  surprise, pas de packing exotique. La review est plus rapide pour ce
  type d'extension.

## Data collection permissions — déclaration

Vespry déclare dans `src/manifest.firefox.ts` :

```ts
data_collection_permissions: {
  required: ['authenticationInfo', 'personalCommunications'],
}
```

Pourquoi ces valeurs (et pas `none`) :

- `authenticationInfo` : Vespry lit le jeton de session Discord depuis
  les requêtes Discord. Le jeton **ne quitte jamais la machine** — il
  est utilisé uniquement pour les appels API Discord — mais c'est
  techniquement de l'« authentication info » selon la nomenclature AMO.
- `personalCommunications` : Vespry lit le contenu des messages Discord
  pour les exporter. Par essence des communications personnelles. Tout
  reste **local** (IndexedDB → zip téléchargé par l'utilisateur).

Pas de `technicalAndInteraction`, pas de `locationInfo`, pas de
`searchTerms`, pas de `websiteActivity`. Vespry n'envoie **aucune**
télémétrie tierce sur les opérations utilisateur ; seul un rapport
**opt-in** sur les évolutions de schéma Discord est envoyé (champs JSON
inconnus) — pas de contenu de message, pas d'ids.

Référence : [Mozilla — Firefox built-in consent for data collection](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Différences Firefox vs Chrome — résumé technique

| Élément | Chrome MV3 | Firefox MV3 |
|---|---|---|
| Moteur d'export | Document `offscreen` | Event page non-persistante |
| Background | Service worker | `background.scripts` + `persistent: false` |
| Anti-sommeil | Document offscreen survit tant que l'extension vit | Port `vespry-keepalive` ouvert depuis l'overlay |
| Manifest source | `src/manifest.ts` | `src/manifest.firefox.ts` |
| Vite config | `vite.config.ts` | `vite.firefox.config.ts` |
| Build output | `dist/` | `dist-firefox/` |
| Permissions spécifiques | `offscreen` | — |
| Permissions abandonnées | — | `offscreen` (non supporté) |
| Réglages spécifiques | — | `browser_specific_settings.gecko` (id, min_version, data_collection_permissions) |

Le moteur d'export (`src/engine/*` + `src/content/overlay/controller.ts`)
est **strictement identique** entre les deux builds — c'est le point
d'orchestration (offscreen vs event page) qui diverge.

## Sources

- [Mozilla — Data collection consent changes](https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/)
- [Firefox Extension Workshop — Manifest V3 migration](https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/)
- [Firefox Extension Workshop — Built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [MDN — browser_specific_settings](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)
