-- Schéma D1 du mur des soutiens Vespry.
-- Appliquer une fois :
--   npx wrangler d1 execute vespry-donors --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS donors (
  -- Numéro de soutien séquentiel. Source de vérité des paliers
  -- (le 1er, le 10e, le 100e…). N'est jamais réutilisé.
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'kofi' | 'github'
  source       TEXT    NOT NULL,
  -- Identifiant externe unique → idempotence des webhooks (rejeux Ko-Fi).
  external_id  TEXT    NOT NULL UNIQUE,
  -- Nom affiché, NULL si le donateur a choisi l'anonymat.
  name         TEXT,
  -- Petit mot modéré, NULL si absent ou retiré par le filtre.
  message      TEXT,
  -- 1 si le donateur a accepté l'affichage public.
  is_public    INTEGER NOT NULL DEFAULT 0,
  -- 1 = masqué par modération (toujours compté dans le total ? non : exclu).
  hidden       INTEGER NOT NULL DEFAULT 0,
  -- Epoch millisecondes.
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_donors_created ON donors (created_at DESC);

-- Rapports de schéma automatiques (télémétrie opt-in) : on n'ouvre une issue
-- GitHub qu'une seule fois par signature (version Vespry + ensemble de champs
-- Discord inconnus), pour éviter les doublons.
CREATE TABLE IF NOT EXISTS schema_reports (
  signature   TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  locale      TEXT NOT NULL,
  fields      TEXT NOT NULL, -- JSON array
  issue_url   TEXT,
  count       INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
