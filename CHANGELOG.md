# Changelog — Vespry

Versionnage sémantique (semver). La version affichée dans le header de
l'overlay et le popup vient de `package.json`.

## [0.1.0] — non publié

Première version fonctionnelle (en construction).

### Ajouté
- Capture du jeton de session Discord (interception fetch/XHR, monde MAIN).
- Moteur d'export increvable : checkpoint IndexedDB, reprise après crash/reboot.
- Client API Discord (pagination, back-off 429, gestion 401).
- Sortie agent-ready : JSON par salon, médias locaux, `INDEX.md`, `manifest.json`,
  zip streamé.
- Médias personnalisables par type (images / vidéos / audio / fichiers),
  tout par défaut.
- Overlay autonome façon Discord, injecté en Shadow DOM.
- File d'export multi-tâches séquentielle, avec détail 100 % et console temps réel.
- Offscreen document : l'export tourne même onglet Discord fermé.
- Badge d'icône, notifications, bouton lanceur avec %.
- Thème clair/sombre automatique.
- Minimisation en widget de progression flottant.
- Footer « Mur des soutiens » : compteur animé, bandeau défilant des
  remerciements, paliers (1er, 10e, 100e…), accroche du prochain palier.
- Service `vespry-donors` (Cloudflare Worker + D1) : ingestion des webhooks
  Ko-Fi et GitHub Sponsors, flux public des donateurs, modération. Voir
  `donor-service/README.md`.
