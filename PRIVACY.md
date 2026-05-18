# Politique de confidentialité — Vespry

**Dernière mise à jour : 18 mai 2026.**

Vespry est une extension de navigateur (Chrome, Edge, Firefox) qui exporte
l'historique des conversations Discord de l'utilisateur dans un fichier
sauvegardé localement sur sa machine.

Cette politique de confidentialité explique quelles données Vespry traite,
comment, où, et ce qu'elle n'envoie nulle part.

## Éditeur

- **Éditeur** : Samuel Muselet (L'Atelier de Sam)
- **Contact** : via les
  [issues GitHub](https://github.com/ateliersam86/vespry/issues)
- **Code source** : https://github.com/ateliersam86/vespry (MIT)

## Principe : tout reste en local

Toutes les données traitées par Vespry restent sur **ta machine**, à deux
exceptions explicites détaillées ci-dessous (Stripe et télémétrie de
schéma — toutes deux optionnelles).

Aucune base de données distante, aucun pixel de tracking, aucun script
analytique, aucun cookie tiers. Le code est public et auditable.

## Données collectées et traitées

| Donnée | D'où | Où va-t-elle | Pourquoi |
|---|---|---|---|
| Jeton de session Discord | Intercepté dans la page Discord ouverte par l'utilisateur | `chrome.storage.local` (locale, chiffrée par le navigateur) | Appeler l'API Discord au nom de l'utilisateur, exactement comme son client Discord. |
| Messages exportés | API Discord (`GET /channels/{id}/messages`) | IndexedDB local, puis fichier `.zip` téléchargé | Reprise après crash + export final. |
| Médias (images, vidéos, audio, fichiers) | CDN Discord | IndexedDB local, puis dossiers dans le `.zip` | Inclure les médias dans l'archive. |
| Préférences utilisateur (thème, mode Avancé, templates de noms, planning, opt-in télémétrie) | Interactions utilisateur | `chrome.storage.local` | Persistance entre sessions. |
| Mot de passe AES-256 du zip (optionnel) | Saisi par l'utilisateur | **RAM uniquement**, le temps d'un export — jamais persisté, jamais envoyé | Chiffrer l'archive. |

## Sorties réseau (les seules)

Trois sorties réseau, toutes explicites et nécessaires :

### 1. API Discord

Vespry appelle l'API officielle Discord (`discord.com`,
`cdn.discordapp.com`, `media.discordapp.net`) avec le jeton de session de
l'utilisateur. C'est l'opération même de l'export : sans ces appels, aucun
historique ne peut être récupéré.

Vespry ne stocke ni ne transmet ce jeton à un serveur tiers.

### 2. Stripe (uniquement si l'utilisateur fait un don)

Si l'utilisateur clique sur le bouton **Soutenir** et choisit de faire un
don, une fenêtre Stripe Checkout s'ouvre. Vespry ne voit jamais la carte
bancaire — la collecte est faite par Stripe directement dans cette fenêtre.

Si l'utilisateur ne fait pas de don, **rien** n'est envoyé à Stripe.

Stripe est conforme RGPD. Voir : https://stripe.com/fr/privacy

### 3. Télémétrie de schéma (opt-in, désactivée par défaut)

L'utilisateur peut activer dans le mode Avancé l'envoi d'un signal minimal
au service Vespry quand Discord ajoute un champ d'API que Vespry ne sait
pas encore rendre. Le payload est strictement :

```json
{
  "version": "0.1.0",
  "locale": "fr-FR",
  "fields": ["voice_notes_v2", "..."]
}
```

**Jamais envoyé** : le jeton, le contenu d'un message, un identifiant
utilisateur ou de salon, un nom de personne, l'IP stockée, une stack
trace, un identifiant d'installation.

Le code de cette télémétrie est dans `src/engine/schema-report.ts`
(moins de 80 lignes, lisibles). Le serveur Vespry stocke le rapport dans
une issue GitHub publique pour priorisation des futurs développements.

Cette télémétrie est **désactivée par défaut**. L'utilisateur peut
l'activer ou la désactiver à tout moment dans le mode Avancé.

## Conformité RGPD

Vespry ne traite aucune donnée à caractère personnel sur ses propres
serveurs (sauf, pour les soutiens publics qui le choisissent, leur pseudo
et message affichés sur le mur des soutiens — flux public anonymisable à
la demande). Les exports restent locaux à la machine de l'utilisateur.

**Droits RGPD** (accès, rectification, effacement) :

- Pour les exports locaux : l'utilisateur a un contrôle total
  (supprimer le `.zip` et vider le `chrome.storage` suffit).
- Pour le mur des soutiens public : envoyer une demande via les
  [issues GitHub](https://github.com/ateliersam86/vespry/issues) ; le
  donneur ou son message sera masqué.

## Cookies

Vespry ne dépose **aucun cookie**.

## Sécurité

- Code open source, auditable par tous.
- Politique de divulgation : si tu trouves une faille, ouvre une issue
  GitHub privée ou contacte-moi directement.
- AES-256 disponible pour chiffrer l'archive exportée (option utilisateur).

## Modifications de cette politique

Toute modification est publiée sur GitHub avec un historique git complet
(branche `main`, fichier `PRIVACY.md`). Les modifications majeures sont
annoncées dans `CHANGELOG.md`.

## Avertissement Discord

Vespry utilise l'API Discord avec un compte utilisateur, ce qui sort des
conditions d'utilisation de Discord (`https://discord.com/terms`). Vespry
est conçu pour un usage privé sur les propres données de l'utilisateur.
L'utilisateur est seul responsable de son usage de l'outil.

Vespry n'est pas affilié à Discord Inc. « Discord » et le logo Discord
sont des marques de Discord Inc.
