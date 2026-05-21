# Changelog — Vespry

Versionnage sémantique (semver). La version affichée dans le header de
l'overlay et le popup vient de `package.json`.

## [0.1.0] — non publié

Première version fonctionnelle prête pour soumission Chrome Web Store,
Microsoft Edge Add-ons et Mozilla AMO.

### Session 2026-05-21 — onboarding, tooltips, robustesse erreurs

**Tutoriel interactif au premier lancement** : `Tutorial.tsx` + 3 steps
(sélection serveurs/salons, panneau réglages, bouton Lancer). Spotlight via
box-shadow géante autour de l'élément ciblé, backdrop dim, bulle Preact
positionnée selon `step.placement`. Trigger au montage de l'overlay si flag
`vespry.tutoCompleted` absent. Bouton « Revoir le tutoriel » dans le popup
qui reset le flag. 16 clés i18n `tuto.*` × 15 locales.

**Tooltips d'aide contextuelle** : `HelpTip.tsx` (pastille `?` 16 px,
bulle au survol/focus, ARIA propre, Esc ferme). Branchés sur 7 endroits :
chiffrement, planification, format d'export, période, découpage des gros
salons, incrémental, opt-in signalement schéma. `CheckRow` étendu pour
accepter une prop `help?`.

**Section Confidentialité dédiée** : le toggle « signalement anonyme des
nouveaux champs Discord » est sorti de Filtres vers une section Privacy
propre. Wording reformulé en clair, tooltip explique ce qui part
exactement (juste le nom des champs, jamais le contenu).

**Bug filtres résolu** : le mode Simple par défaut masquait toute la
section Filtres, perçu comme « ne fonctionnent pas du tout ». Mode Avancé
activé par défaut au premier launch, choix persisté dans
`chrome.storage.local`. `stopPropagation` préventif sur tous les inputs
texte/date pour neutraliser les raccourcis globaux de Discord. Datalist
auteur en place (alimentation IDB en follow-up #57).

**Date du dernier export visible** : section Planification affiche
maintenant « dernier export auto · prochain », et sous le toggle
Incrémental « dernier export de ce serveur » (ou « aucun export
précédent »). Données depuis `controller.listRuns()` et
`saved.lastFiredAt`. Helpers `formatRelativePast` / `formatRelativeFuture`
extraits dans `src/ui/relative-time.ts` (partage popup + overlay).

**Audit patterns IA dans i18n + HTML** : 0 em-dash restant dans toutes
les chaînes user-facing (15 locales + `exporters.ts`). Tournures marketing
IA remplacées par du langage builder concret. Tests adaptés (un seul
ajustement : séparateur `·` au lieu de `—` dans l'en-tête TXT).

**Error Boundary Preact** : `src/ui/ErrorBoundary.tsx` wrappe maintenant
l'Overlay (via `mount.tsx`) et le popup. `componentDidCatch` →
`recordEvent` + UI fallback avec bouton « Signaler ce problème » qui
ouvre une issue GitHub pré-remplie. Plus d'écran blanc sur crash composant.
Audit des ~56 try/catch : `recordEvent` ajouté dans les muets critiques
(engine, controller, service-worker), commentaires `// silencieux:` sur
les muets intentionnels.

**Bouton « Signaler ce problème » étendu** : déjà présent dans l'overlay
(header), désormais aussi dans le footer du popup. Pré-remplissage
GitHub : version, navigateur, langue, 60 dernières erreurs captées,
champs Discord inconnus rencontrés. Aucun jeton, aucun contenu de
message dans le rapport.

### Session 2026-05-19 — features Discord HTML + UX planification + sécurité

**Rendu HTML enrichi (parité DCE/Discrub)** :

- Avatars utilisateurs téléchargés et intégrés en image (au lieu de la
  pastille HSL). `urlToPath` résolvait déjà les URL ; juste à brancher
  côté `avatarChip()`.
- Emojis custom Discord (`<:nom:id>`, `<a:nom:id>`) rendus en `<img>`
  depuis `cdn.discordapp.com/emojis/{id}.{ext}` quand téléchargés
  (sinon `:nom:` texte en fallback).
- Vidéo / audio en lecteur natif (`<video controls preload=none>` /
  `<audio controls>`) au lieu d'un lien-chip. `preload=none` évite la
  saturation navigateur sur archives multi-médias.
- Mentions Discord en pilule colorée avec `data-user-id` / `data-role-id` /
  `data-channel-id` (couleurs séparées user / rôle / salon).
- Bot tag (badge bleu « BOT ») à côté du nom d'auteur quand
  `author.bot === true`.
- @media print : thème clair forcé, URL des liens imprimées, pas de
  coupure de message entre pages.
- `safeHref()` whitelist http(s) / mailto sur tous les `href` issus
  d'embeds Discord — sécurité XSS contre `javascript:` URL.
- Regex auto-lien markdown ne capture plus la ponctuation finale.

**Bouton CTA & UX export** :

- Libellé dynamique : « Lancer l'exportation » par défaut, « + Ajouter
  à la file » quand un export tourne déjà (plus de mention trompeuse
  d'une file inexistante).
- Shift+clic sur les messages dans l'aperçu central → sélection en
  intervalle (façon Finder / Gmail).
- Modale d'avertissement « gros export » basée sur l'estimation
  **messages** (et non plus salons) — seuil 10 000 messages estimés.
  Pré-flight `~1-3 s` au clic via `controller.estimate()`.
- Format défaut HTML seul (au lieu de JSON + HTML cochés ensemble).
- Section PasswordSection corrigée (CSS manquant) : bouton œil intégré
  au champ, badge « 🔒 Chiffrement activé » dès qu'un mot de passe est
  tapé, jauge de force visible.
- Marges du panneau Vespry resserrées (86vw sur grand écran au lieu de
  70vw).
- Animation subtile du logo hibou (saut toutes les 8 s, désactivé sous
  `prefers-reduced-motion`).
- Crédit éditeur dans le footer : « © {année} L'Atelier de Sam — fait
  avec passion par Samuel Muselet », année dynamique.
- Modale d'avertissement ToS Discord au premier export (lien officiel,
  rappel d'usage privé, opt-out « ne plus afficher »).

**Progression d'export** :

- Pré-comptage des messages via API search Discord au démarrage du run
  pour pondérer la barre par messages réels. Fin du « saut à 80 % puis
  blocage ».
- Dichotomie 1 niveau (snowflake midpoint) sur les salons plafonnés à
  8000 messages, pour estimer jusqu'à ~16 000 précisément.
- Rolling adjust pendant le run : si la réalité dépasse l'estimation
  initiale, on étire — jamais de barre bloquée à 100 %.
- Concurrence pré-comptage baissée à 3 workers parallèles (cascade
  429 évitée).
- Helper `progressPct` partagé entre overlay, popup, badge icône,
  bouton lanceur.

**Système de planification d'export récurrent** :

- Renommé « Backup automatique du serveur » avec texte d'aide explicite
  (incrémental + tous salons accessibles).
- Carte « Planning actif » dans le popup : serveur, fréquence,
  prochaine occurrence, dernière exécution réussie.
- Badge icône teinté ambre quand l'export en cours vient d'un déclenchement
  planifié (vs bleu pour manuel).
- Fix race condition : `lastFiredAt` mis à jour dans storage sans
  re-déclencher `syncScheduledAlarm`.
- Fix bug Firefox : `chrome.alarms` câblé dans l'event page (avant ce
  fix, la planification ne se déclenchait jamais sur Firefox).

**Historique des exports** :

- Section « Exports récents » dans le popup (10 derniers runs lus
  depuis IDB). Statut coloré (completed / partial / failed / paused).
- Bouton suppression irréversible par entrée.
- Estimations + métadonnées exposées via commandes `list-runs` et
  `delete-run`.

**Threads et noms de fichiers** :

- Threads (types 10/11/12) préfixés par le nom du salon parent dans
  le nom du fichier d'export (`général.questions-sam.json` au lieu de
  `questions-sam.json`).

**JSON agent-ready** :

- Enveloppe enrichie : `$schema`, `vespryVersion`, `exportedAt`,
  `guild{id,name}`, `channel{id,name,type,typeName}` (enum lisible),
  `messages[].typeName`.
- Champs Discord snake_case originaux préservés (forward-compat).
- Identique entre chemins bulk et streaming.

**CSV / TXT** :

- CSV : BOM UTF-8 (compatibilité Excel Windows) + colonnes
  `ChannelID,Channel,ChannelType` en tête.
- TXT : typage des attachments (`[image:...]`, `[video:...]`,
  `[audio:...]`, `[file:...]`).

**Sécurité, privacy, légal** :

- Whitelist protocole sur `<a href>` (XSS major fixé).
- PRIVACY.md reformulé : 6 sorties réseau au lieu de 3 documentées,
  ajout sections « GitHub Raw / Worker Cloudflare / API GitHub ».
  Formulation token Discord rectifiée (« accessible uniquement par
  Vespry », pas « chiffré par le navigateur »).
- `host_permissions` Firefox élargies aux 3 endpoints auxiliaires.
- LICENSE : copyright à jour.
- `package.json` : `author`, `homepage`, `repository`, `bugs`.
- `vellum-0.1.0.zip` (artefact pré-rebrand) supprimé du repo.
- `*.zip` ajouté au `.gitignore`.

**Popup** :

- Bannière update : `checkForUpdate()` câblé, propose une release plus
  récente quand `api.github.com/.../releases/latest` en a une.

**Robustesse Firefox** :

- Port `vespry-keepalive` réellement câblé côté `RemoteController`
  (auparavant déclaré dans le background sans jamais être ouvert
  côté UI — l'event page Firefox pouvait s'endormir mid-export).

**Tests** :

- 173 tests verts (était 142 en début de session, +31 tests). Couverture
  progressPct, buildJsonEnvelope, dichotomie estimation, rolling adjust,
  XSS protocole, avatars/emojis/mentions/bot tag/vidéo/audio rendus HTML.

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
