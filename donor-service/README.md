# vespry-donors — service du mur des soutiens

Cloudflare Worker qui ingère les webhooks **Ko-Fi** et **GitHub Sponsors**,
range les soutiens dans une base **D1** (SQLite), et expose le flux public
consommé par le footer « Mur des soutiens » de l'extension.

Aucun montant n'est stocké ni exposé. Un soutien n'apparaît avec un nom et un
message que si le donateur a accepté l'affichage public.

## Architecture

```
Ko-Fi  ──(webhook)──┐
                    ├──▶  Worker  ──▶  D1 (table donors)
GitHub Sponsors ────┘                   │
                                        ▼
              extension  ◀──(GET /donors)──  flux public (DonorFeed)
```

| Route | Méthode | Auth | Rôle |
|---|---|---|---|
| `/donors` | GET | — (CORS ouvert) | flux public, cache 60 s |
| `/kofi/webhook` | POST | `verification_token` | ingestion Ko-Fi |
| `/github/webhook` | POST | HMAC-SHA256 | ingestion GitHub Sponsors |
| `/admin/list` | GET | `ADMIN_SECRET` | liste complète (masqués inclus) |
| `/admin/hide` | POST | `ADMIN_SECRET` | masque une entrée `{ seq }` |

## Déploiement (à faire une fois)

Pré-requis : un compte Cloudflare (offre gratuite suffisante).

```bash
cd donor-service
npm install
npx wrangler login

# 1. Créer la base D1, puis recopier le database_id renvoyé dans wrangler.toml
npx wrangler d1 create vespry-donors

# 2. Appliquer le schéma
npx wrangler d1 execute vespry-donors --remote --file=schema.sql

# 3. Définir les secrets (valeurs choisies ci-dessous)
npx wrangler secret put KOFI_VERIFICATION_TOKEN
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put ADMIN_SECRET

# 4. Déployer
npm run deploy
```

Le déploiement affiche l'URL du Worker, par exemple
`https://vespry-donors.<compte>.workers.dev`.

## Branchement des plateformes

### Ko-Fi
1. Crée la page Ko-Fi, active le mode « donations ».
2. Réglages → **API / Webhooks**.
3. Webhook URL : `https://vespry-donors.<compte>.workers.dev/kofi/webhook`
4. Copie le **Verification Token** affiché → c'est la valeur du secret
   `KOFI_VERIFICATION_TOKEN`.

### GitHub Sponsors
1. Active GitHub Sponsors sur le compte.
2. Tableau de bord Sponsors → **Webhooks** → *Add webhook*.
3. Payload URL : `https://vespry-donors.<compte>.workers.dev/github/webhook`
4. Content type : `application/json`.
5. Secret : une chaîne aléatoire → c'est la valeur du secret
   `GITHUB_WEBHOOK_SECRET`.

### Extension
Renseigne l'URL du Worker dans `credits.json` du dépôt (champ `donorApiUrl`),
ainsi que `koFiUrl` et `gitHubSponsorsUrl`. L'extension affiche alors le mur.

## Modération

`POST /admin/hide` avec l'en-tête `Authorization: Bearer <ADMIN_SECRET>` et le
corps `{ "seq": 42 }` masque une entrée. `GET /admin/list` liste tout.

```bash
curl -X POST https://vespry-donors.<compte>.workers.dev/admin/hide \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"seq": 42}'
```

Un filtre anti-insultes (`src/moderation.ts`) retire automatiquement les noms
et messages problématiques à l'ingestion.

## Développement

```bash
npm test        # tests unitaires (paliers, modération, parsing, signature)
npm run typecheck
npm run dev     # Worker local (wrangler dev)
```
