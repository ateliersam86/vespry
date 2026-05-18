# Changelog — Vespry

Versionnage sémantique (semver). La version affichée dans le header de
l'overlay et le popup vient de `package.json`.

## [0.1.0] — non publié

Première version fonctionnelle prête pour soumission Chrome Web Store,
Microsoft Edge Add-ons et Mozilla AMO.

### Polish UX (2026-05-18)

- **Bouton CTA** : « Lancer l'exportation » par défaut, devient « + Ajouter
  à la file » uniquement si un export tourne déjà — plus de mention
  trompeuse d'une « file » qui n'existe pas encore.
- **Barre de progression fluide** : pré-comptage des messages par salon
  via l'API search Discord (`total_results`) au démarrage du run, puis
  pondération `messages / estimatedTotal`. Fin du saut à 80 % suivi d'un
  blocage. Fallback gracieux sur `channelsDone/channelsTotal` si search
  API échoue.
- **Overlay responsif** : largeur 70vw sur grand écran (15 % de marge à
  gauche et à droite), repli à 94vw sous ~1100 px, plafond 1800×1200 px
  pour les 4K/5K.
- **Animation hibou** : le logo OwlMark fait un saut subtil toutes les 8 s
  (squash+stretch CSS, 0,5 s). Désactivé sous `prefers-reduced-motion`.
- **Format d'export par défaut** : HTML seul (au lieu de JSON+HTML cochés
  ensemble). JSON/CSV/TXT à un clic.
- **Avertissement ToS Discord** au premier export — modale explicite
  (lien `https://discord.com/terms`, recommandation d'usage privé),
  checkbox « ne plus afficher » persistée.
- **Crédit éditeur** dans le footer overlay : « © {année} L'Atelier de
  Sam — fait avec passion par Samuel Muselet », année calculée
  dynamiquement.
- **Cohérence patches** (audit UX) : zip pas encore prêt affiche
  désormais « ⏳ Préparation de l'archive… » au lieu d'une barre 100 %
  silencieuse ; export incrémental sans run précédent logge clairement
  « premier export complet » au lieu de rester silencieux.

### Exports — qualité (2026-05-18, suite audit comparatif vs DCE/Discrub)

- **JSON enveloppe agent-ready** :
  `$schema`, `vespryVersion`, `exportedAt`, `guild{id,name}`,
  `channel{id,name,type,typeName}`, et `messages[].typeName` (enum
  lisible : `"REPLY"`, `"CHANNEL_PINNED_MESSAGE"`…). Champs Discord
  snake_case natifs préservés (forward-compat). Identique entre chemins
  bulk et streaming.
- **CSV BOM UTF-8** + colonnes `ChannelID,Channel,ChannelType` ajoutées
  en tête → Excel Windows n'écrase plus les accents/emojis, CSV
  concaténés multi-salons restent exploitables.
- **HTML imprimable** : `@media print` ajouté — thème clair forcé, pas
  de coupure de message entre pages, URL des liens imprimée. Vespry est
  le premier (vs DCE/Discrub) à le gérer.
- **Markdown URL fix** : la regex auto-linkifier absorbait la ponctuation
  terminale (`https://x.com/foo.` → 404). Désormais relâchée hors du
  `<a>`.

### Légal (2026-05-18)

- **LICENSE** : copyright à jour (« Samuel Muselet (L'Atelier de Sam)
  and Vespry contributors », fin du nom « Vellum contributors »).
- **PRIVACY.md** autonome (politique de confidentialité — éditeur,
  données traitées, 3 sorties réseau opt-in, conformité RGPD, contact,
  procédure de droits).
- **package.json** : `author`, `homepage`, `repository`, `bugs` ajoutés.
- **README** : sections Vie privée + Contact ajoutées, mention
  non-affiliation Discord Inc., crédit éditeur en bas.

### Firefox

- `chrome.alarms` câblé dans `firefox/background.ts` — la planification
  daily/weekly tire désormais réellement sur Firefox (auparavant l'UI
  fonctionnait mais aucun déclenchement, bug silencieux découvert en
  audit pré-publication).


### Moteur d'export

- Capture du jeton de session Discord (interception fetch/XHR, monde MAIN).
- Moteur increvable : checkpoint IndexedDB, reprise après crash / reboot /
  fermeture d'onglet, couvert par les tests automatiques.
- Client API Discord (pagination, back-off 429, gestion 401/403/404).
- Sortie agent-ready : JSON par salon, médias locaux, `INDEX.md`,
  `manifest.json`, zip streamé via Conflux.
- Médias personnalisables par type (images / vidéos / audio / fichiers),
  tout par défaut.
- Sélection des messages :
  - zones granulaires : période, auteur, mot-clé, mention, épinglés,
    `has:` image / vidéo / audio / sticker / embed / link, manuelle ;
  - combinaison ET / OU, négation par zone ;
  - sélection manuelle un-par-un en plus.
- Export incrémental : ne récupère que les messages postés depuis le
  dernier export du même serveur.
- Découpage des gros salons (0 / 5 000 / 10 000 / 25 000 messages par
  fichier).
- Quatre formats simultanés : JSON, HTML, CSV, TXT.
- Performance adaptative selon la machine : trois profils (`fast` /
  `balanced` / `low`) calculés à partir de `navigator.deviceMemory`,
  `hardwareConcurrency`, `performance.memory.jsHeapSizeLimit`. Bulk pour
  les machines costaudes, streaming pour les autres.
- Concurrence salons adaptative (1 à 3 en parallèle selon profil).
- Threads dans les DMs (en plus des threads serveur).
- Récupération opt-in des utilisateurs ayant réagi à chaque message.

### Interface

- Overlay autonome façon Discord, injecté en Shadow DOM.
- Modes Simple / Avancé, mémorisés.
- Thème clair / sombre automatique avec basculement manuel.
- File d'export multi-tâches séquentielle, détail 100 % et console
  temps réel.
- Badge d'icône avec pourcentage de progression.
- Bouton lanceur avec libellé `Vespry · X%`.
- Notifications de fin d'export, mise en pause, échec.
- Minimisation en widget de progression flottant.
- Footer « Mur des soutiens » : compteur animé, bandeau défilant des
  remerciements, paliers (1er, 10e, 100e…), accroche du prochain palier.
- Aperçu central des messages : markdown rendu, réponses citées,
  réactions, stickers, embeds, médias inline.

### Phase 2 — Suppression bulk de messages cochés

- Bouton « Supprimer la sélection » dans le mode Avancé, visible
  uniquement quand au moins un message est coché.
- Modale dédiée affichant nombre + salon, exigeant la frappe du mot
  `SUPPRIMER` (FR) / `DELETE` (EN) avant que le bouton rouge s'active.
- Suppression sérielle ≈ 5/s pour rester dans les rate-limits Discord.
- Idempotente sur 404 (message déjà disparu côté Discord).
- 403 forbidden tracé en console, ne casse pas la file.
- File de purge sérialisée dans `controller.purgeQueue`, progression
  visible dans la UI.

### Phase 3 — Planification d'export récurrent

- Section « Planifier un export » dans le mode Avancé.
- Daily / Weekly à une heure UTC fixe (24 plages horaires).
- Un planning actif à la fois, persisté dans `chrome.storage.local`.
- Réveil via `chrome.alarms`, resync sur startup / install / changement
  storage.
- Export incrémental + médias par défaut + JSON+HTML par défaut au
  déclenchement (réglages utilisateur préservés).
- Notification si l'export planifié rate (Discord déconnecté, par ex.).

### Phase 3 bis — Templates de nom de fichier

- Champ « Nom du fichier zip » dans le mode Avancé.
- Placeholders : `{guildName}`, `{date}` (ISO YYYY-MM-DD), `{datetime}`
  (YYYY-MM-DDTHHMM).
- Aperçu en direct du nom final.
- Sanitization cross-OS (Windows interdit `<>:"/\|?*`).
- Persistance dans `chrome.storage.local`, défaut `vespry-{guildName}`.

### Phase 4 — Chiffrement AES-256

- Section « Chiffrer l'export » dans le mode Avancé.
- Wrapper zip AES-256 (encryptionStrength 3) via `@zip.js/zip.js` —
  ouvrable par 7-Zip, Keka, WinRAR.
- Le mot de passe ne quitte jamais la RAM : non persisté, scrubbé du
  `manifest.json` côté packager.
- Jauge de force du mot de passe (empty / weak / medium / strong).
- Toggle visibilité, message clair sur l'irrécupérabilité en cas
  d'oubli.

### Multi-navigateur

- Build Chrome MV3 (`dist/`) via Vite + `@crxjs/vite-plugin`.
- Build Microsoft Edge identique (Chromium, même `dist/`).
- Build Firefox MV3 (`dist-firefox/`) — moteur déplacé du document
  offscreen vers une event page, port `vespry-keepalive` pour empêcher
  Firefox de mettre la page en sommeil pendant un export long.
  `chrome.alarms` câblé dans l'event page pour parité Schedule.
  `web-ext lint` 0 erreur, 3 warnings (libs externes connues,
  documentées dans `docs/publishing/firefox.md`).
- `data_collection_permissions` (`authenticationInfo` +
  `personalCommunications`) déclarés pour AMO post-EU AI Act.

### Internationalisation

- 15 langues : 🇬🇧 English, 🇫🇷 Français, 🇩🇪 Deutsch, 🇪🇸 Español,
  🇮🇹 Italiano, 🇵🇹 Português, 🇳🇱 Nederlands, 🇵🇱 Polski, 🇫🇮 Suomi,
  🇹🇷 Türkçe, 🇷🇺 Русский, 🇯🇵 日本語, 🇰🇷 한국어, 🇨🇳 中文, 🇮🇳 हिन्दी.
- 217 clés par locale (parité exacte), interpolation avec `{x}`.
- Détection automatique de la langue du navigateur, repli EN.
- Configuration Crowdin (`crowdin.yml`) prête, intégration GitHub Crowdin
  à brancher côté plateforme.

### Confidentialité

- Tout en local : aucune donnée n'est envoyée à un serveur Vespry par
  défaut.
- Trois sorties réseau, toutes explicites : Discord (l'API qu'on
  exporte), Stripe (dons uniquement, popup), télémétrie de schéma
  (opt-in défaut OFF).
- Module de télémétrie auditable en moins de 80 lignes
  (`src/engine/schema-report.ts`) — payload strict :
  `{ version, locale, fields[] }`.
- Diagnostics inhibés en production sauf opt-in.

### Mur des soutiens

- Service `vespry-donors` (Cloudflare Worker + D1) :
  ingestion des webhooks Stripe + GitHub Sponsors, flux public des
  donateurs, modération. Voir `donor-service/README.md`.
- Stripe Checkout via popup depuis l'overlay, sans collecter de carte
  côté Vespry.

### Qualité

- TypeScript strict, pas de `any`.
- 142 tests unitaires (vitest), CI verte sur chaque push.
- `web-ext lint` 0 erreur côté build Firefox.
- Documentation de soumission : `docs/publishing/chrome.md`,
  `docs/publishing/edge.md`, `docs/publishing/firefox.md`.
