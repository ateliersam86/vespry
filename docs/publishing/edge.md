# Publication Vespry sur Microsoft Edge Add-ons

Procédure de soumission de Vespry sur le store Microsoft Edge.
Cible : Edge Desktop (Windows / macOS / Linux), tous marchés, MV3.

**Bonne nouvelle.** Edge est Chromium et accepte le **même `.zip` que celui
soumis au Chrome Web Store**. Aucun code à modifier, aucun build séparé.

## Pré-requis

- Compte développeur Microsoft Partner Center (gratuit, ~10 min).
  Inscription : https://partner.microsoft.com/dashboard/microsoftedge/public/login.
  Pas de frais d'enregistrement (contrairement aux 5 $ du Chrome Web Store).
- L'artefact à uploader : `vespry-<version>.zip` — c'est le même zip que
  celui généré pour le Chrome Web Store, produit à partir de `dist/`.

## Construire le paquet à soumettre

```sh
# build TypeScript + Vite vers dist/
npm run build

# zipper le contenu de dist/ pour Edge (et CWS — un seul artefact pour les deux)
cd dist && zip -r ../vespry-<version>.zip . && cd ..
```

Le zip à uploader vit à la racine du repo : `vespry-<version>.zip`.

Avant chaque soumission, vérifier :

- `dist/manifest.json` reflète bien la version courante de `package.json`.
- Les icônes (`src/assets/icon-16/48/128.png`) sont présentes dans le zip.
- Le service worker et l'offscreen sont bundlés (`dist/assets/`).

## Créer le compte Partner Center (premier upload)

1. Ouvrir https://partner.microsoft.com/dashboard/microsoftedge/public/login.
2. Se connecter avec un compte Microsoft (perso ou pro). Si tu n'en as pas,
   en créer un — choisir une adresse `outlook.com` qui restera stable, ce
   sera l'identifiant développeur des futures mises à jour.
3. Sur le formulaire d'inscription, choisir le type de compte :
   - **Individu** : suffisant pour Vespry (open source perso).
   - **Entreprise** : nécessaire si Vespry était édité par une société.
4. Renseigner nom du développeur, pays, adresse mail, infos de contact.
   Le nom du développeur sera affiché publiquement sur la fiche Edge —
   choisir un nom cohérent (par ex. `Sam Muselet — Atelier de Sam`).
5. Valider — pas de paiement ni de carte demandés.

## Soumettre une nouvelle extension (première publication)

1. **Dashboard Partner Center** → bloc `Edge` → bouton `Create new extension`.
2. **Upload du zip** — déposer `vespry-<version>.zip`. Partner Center
   valide le manifest et liste les langues détectées. Vespry ne déclare
   pas de `default_locale` ni de `__MSG_*__` dans son manifest (description
   en anglais en clair) — Partner Center détecte donc un seul locale :
   en-US. Les 15 traductions de l'overlay vivent dans `src/locales/*.json`
   et sont chargées au runtime via i18n maison, indépendamment du store.
3. **Availability** :
   - Visibility : `Public` (par défaut).
   - Markets : tous (par défaut). Pas de raison de restreindre.
4. **Properties** :
   - Category : `Productivity`.
   - Website : `https://github.com/ateliersam86/vespry`.
   - Support contact : `https://github.com/ateliersam86/vespry/issues`.
   - Mature content : `Non`.
   - Privacy policy : `Yes — collects/transmits personal information`.
     Lire la section dédiée plus bas pour la déclaration honnête.
5. **Privacy** (nouvelle section depuis mai 2026, voir la doc Microsoft) :
   - **Single Purpose Description** : reprendre la phrase du README —
     « Vespry exports the history of your Discord conversations
     (servers, channels, DMs) to a file on your computer, with crash-proof
     resumability for large servers. »
   - **Permission justification** (par permission du manifest) :
     - `storage` : « Persists the export queue, user preferences (theme,
       language, format choices), and the captured Discord session token —
       all stored locally via chrome.storage.local, never transmitted. »
     - `unlimitedStorage` : « IndexedDB stores message batches and media
       blobs during long exports of large servers (tens of thousands of
       messages, gigabytes of media). The unlimited quota prevents the
       browser from evicting checkpoints mid-export. »
     - `tabs` : « Opens or activates the Discord tab from the popup. Used
       only to navigate the user to https://discord.com/ — no inspection
       of other tabs, no tab content read. »
     - `offscreen` : « Hosts the export engine in an offscreen document so
       it survives the user closing the Discord tab. The engine is a
       resumable, checkpoint-driven worker — it must outlive any single
       tab. No remote code, no tab content access. »
     - `notifications` : « Notifies the user when an export finishes, is
       paused, or fails. Local notifications only, no remote service. »
     - `downloads` : « Triggers the final .zip download once the export is
       complete. The user remains in control of the destination folder. »
     - `host_permissions: https://discord.com/*, https://*.discord.com/*` :
       « Reads the user's Discord session and calls the official Discord
       API to fetch their own messages. No third-party endpoint. »
     - `host_permissions: https://cdn.discordapp.com/*, https://media.discordapp.net/*` :
       « Downloads media (images, videos, attachments) referenced by the
       exported messages so the offline archive remains viewable without
       re-fetching expired Discord CDN links. »
   - **Are you using remote code?** : `No, I am not using remote code`.
     Vespry est 100 % bundlé localement. Aucun `eval`, aucun chargement
     de script tiers à l'exécution. Conflux (la lib de zip) utilise un
     `new Function()` interne mais c'est du code bundlé statique, pas du
     code distant — Microsoft considère ça comme local.
   - **Data usage** : cocher uniquement `Authentication information` et
     `Personal communications` (les deux mêmes catégories qu'AMO — voir
     `docs/publishing/firefox.md` pour la logique). Toutes les certifications
     « Limited Use » sont à cocher : Vespry traite ces données **localement,
     uniquement pour la fonction principale (l'export)**, ne les vend pas,
     ne les transfère pas à des tiers.
   - **Privacy policy URL** : pointer vers une page publique. Deux options :
     - **Recommandé** : la section « Confidentialité » du README sur GitHub —
       `https://github.com/ateliersam86/vespry#confidentialité`. C'est honnête,
       complet, et déjà rédigé.
     - Ou héberger une page dédiée sur `https://ateliersam86.github.io/vespry/privacy`.
6. **Store listings** (au moins l'anglais) :
   - **Extension name** : `Vespry — Discord Export` (récupéré du manifest).
   - **Description** : reprendre les sections « Vespry » + « Le problème »
     + « Vespry face aux autres outils » du README, légèrement adaptées.
     Cible : 250 caractères minimum, 10 000 maximum. Vespry est à l'aise
     entre 2 000 et 4 000 caractères. Possibilité d'utiliser le
     `Generate with AI` de Partner Center pour pré-remplir, à condition
     de relire et corriger l'anglais avant publication.
   - **Short description** : provient du champ `description` du manifest
     (`Crash-proof, AI-ready Discord chat exporter…`). Read-only ici —
     pour modifier, changer le manifest et ré-uploader.
   - **Extension logo** : `src/assets/icon-128.png` ne suffit pas (ratio
     1:1, minimum 128×128, mais Microsoft recommande 300×300). Générer
     une version 300×300 à partir de la source du logo (`src/assets/`).
     Si la source vit ailleurs (fichier de design), il faudra l'exporter
     en PNG 300×300 et l'uploader ici.
   - **Small promotional tile** (optionnel, 440×280) : à produire si
     Sam veut une mise en avant. Sans, Edge affichera le logo recadré.
   - **Large promotional tile** (optionnel, 1400×560) : idem.
   - **Screenshots** (jusqu'à 6, 640×480 ou 1280×800) : utiliser
     `docs/screenshots/*.png`. Les sept screenshots du repo sont en
     1280×800 ou proches — vérifier les dimensions avant l'upload, et
     redimensionner si besoin. Suggérer dans cet ordre :
     1. `overlay.png` — l'overlay sur Discord (vue principale).
     2. `multi-select.png` — sélection multi-salons.
     3. `advanced.png` — mode avancé.
     4. `html-export.png` — rendu HTML d'un export.
     5. `export-done.png` — fin d'export.
     6. `message-select.png` — aperçu / sélection de messages.
   - **YouTube video URL** (optionnel) : pas de vidéo pour la v1.
     À ajouter quand un screencast existe.
   - **Search terms** (optionnel, jusqu'à 7 termes ou phrases, max 21 mots
     au total, 30 caractères par terme) : suggéré —
     `discord export`, `discord backup`, `chat archive`, `crash-proof`,
     `AI dataset`, `server backup`, `messages export`.
7. **Submit your extension** → **Notes for certification** : préciser au
   reviewer Microsoft que Vespry est open source (lien GitHub), qu'il
   nécessite un compte Discord pour fonctionner (sinon le reviewer voit
   « pas de session » et pourrait juger l'extension cassée), et qu'aucun
   endpoint tiers n'est appelé en dehors de Discord et du Cloudflare Worker
   `donor-service` (URL publique fournie dans `credits.json`, optionnel,
   utilisé uniquement pour afficher le mur des soutiens et créer une
   session Stripe Checkout côté donateur — pas de télémétrie utilisateur).

Microsoft annonce **jusqu'à 7 jours ouvrés** pour la certification. En
pratique pour une extension open source sans logique exotique, on tombe
plutôt sur 1-3 jours.

## Mises à jour ultérieures

Bumps de version via `package.json` puis :

```sh
npm run build
cd dist && zip -r ../vespry-<version>.zip . && cd ..
# upload du nouveau zip dans Partner Center > Vespry > Packages > Upload new
```

L'id de l'extension Edge est attribué par Microsoft à la première
soumission — il reste constant pour toutes les mises à jour. Pas besoin
de le déclarer dans le manifest (contrairement à Firefox).

## Différences pratiques par rapport au Chrome Web Store

| | Chrome Web Store | Microsoft Edge Add-ons |
|---|---|---|
| Frais d'enregistrement | 5 $ (one-time) | gratuit |
| Délai de review | quelques heures à 3 jours | 1-3 jours (max 7) |
| Manifest spécifique | non (MV3 standard) | non (le même) |
| Format zip | dist/ zippé | identique |
| Privacy policy obligatoire | si collecte de données | si collecte de données |
| Justification par permission | non détaillée | détaillée (Privacy page) |
| Captures d'écran | 1280×800 ou 640×400 | 1280×800 ou 640×480 |
| Logo | 128×128 (manifest) | 300×300 (store) |
| AI description generator | non | oui (optionnel) |

Le même zip fonctionne pour les deux stores. Les différences sont
purement sur les métadonnées du listing (justifications, formats
captures, logo recommandé).

## Déclarer Vespry honnêtement à Microsoft

Vespry traite des données utilisateur sensibles **localement** :
- jeton de session Discord (capté depuis les requêtes, jamais transmis) ;
- contenu des messages exportés (lus, écrits dans le zip, jamais transmis).

La page **Data usage** de Partner Center attend une déclaration honnête.
Cocher `Authentication information` et `Personal communications` est la
bonne réponse — la review humaine voit le code source et confirmerait
de toute façon. Les certifications « Limited Use » sont **toutes
vraies** pour Vespry :

- L'extension n'utilise pas ces données pour servir des publicités.
- Elle ne les vend pas, ne les transfère pas à des tiers, ne les rend
  pas publiques.
- Elle ne les utilise que pour la fonctionnalité principale, à la
  demande explicite de l'utilisateur.
- Aucune décision algorithmique automatisée n'est prise sur ces données.

Cette cohérence README ↔ store ↔ AMO ↔ Chrome Web Store est volontaire :
si un reviewer s'interroge, il trouvera la même déclaration partout.

## Sources

- [Microsoft — Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- [Microsoft — Register as a Microsoft Edge extension developer](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)
- [Microsoft — Developer policies for the Microsoft Edge Add-ons store](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)
- [Microsoft — Port a Chrome extension to Microsoft Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension)
