-- risque_012_skipped.sql
-- À exécuter dans Supabase SQL Editor.
-- Table de suivi des convergences rejetées par checkEntry.
-- Objectif : dans 2 semaines, savoir pour chaque filtre s'il a évité des
-- pertes ou raté des gains. Enrichissement price_1h / price_24h via cron.

CREATE TABLE IF NOT EXISTS kymia_risque_skipped (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  token_mint    text        NOT NULL,
  skip_reason   text        NOT NULL,  -- clé courte du filtre (ex: 'max_price_run')
  buyer_count   int         NOT NULL DEFAULT 0,
  price_at_skip float8,               -- prix USD au moment du SKIP
  mcap_at_skip  float8,               -- market cap USD au moment du SKIP
  skipped_at    timestamptz NOT NULL DEFAULT now(),
  price_1h      float8,               -- enrichi par cron : prix DexScreener ~1h après le skip
  price_24h     float8                -- enrichi par cron : prix DexScreener ~24h après le skip
);

-- Index mint pour les JOINs d'analyse
CREATE INDEX IF NOT EXISTS kymia_risque_skipped_mint_idx
  ON kymia_risque_skipped (token_mint);

-- Index partiel pour le cron d'enrichissement
CREATE INDEX IF NOT EXISTS kymia_risque_skipped_enrich_1h_idx
  ON kymia_risque_skipped (skipped_at)
  WHERE price_1h IS NULL;

CREATE INDEX IF NOT EXISTS kymia_risque_skipped_enrich_24h_idx
  ON kymia_risque_skipped (skipped_at)
  WHERE price_24h IS NULL;

-- Vérification
SELECT 'kymia_risque_skipped créée' AS status;

-- ── Requête d'analyse type (à exécuter dans 2 semaines) ──────────────────────
-- SELECT
--   skip_reason,
--   COUNT(*)                                                          AS total,
--   COUNT(*) FILTER (WHERE price_1h  > price_at_skip * 1.15)        AS gain_1h,
--   COUNT(*) FILTER (WHERE price_1h  < price_at_skip * 0.85)        AS perte_1h,
--   COUNT(*) FILTER (WHERE price_24h > price_at_skip * 1.15)        AS gain_24h,
--   COUNT(*) FILTER (WHERE price_24h < price_at_skip * 0.85)        AS perte_24h,
--   ROUND(AVG((price_1h  / NULLIF(price_at_skip,0) - 1) * 100), 1) AS avg_pct_1h,
--   ROUND(AVG((price_24h / NULLIF(price_at_skip,0) - 1) * 100), 1) AS avg_pct_24h
-- FROM kymia_risque_skipped
-- WHERE price_1h IS NOT NULL AND price_24h IS NOT NULL
-- GROUP BY skip_reason
-- ORDER BY total DESC;
