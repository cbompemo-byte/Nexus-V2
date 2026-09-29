-- risque_008_mfe.sql
-- À exécuter dans Supabase SQL Editor.
-- Colonnes MFE sur kymia_risque_tokens pour l'endpoint wallet-mfe.

ALTER TABLE kymia_risque_tokens
  ADD COLUMN IF NOT EXISTS mfe_mult_24h        numeric,       -- max(high) / entry_price sur 24h
  ADD COLUMN IF NOT EXISTS mfe_stop_hit_first  boolean,       -- -35% avant +30% (stop déclenché)
  ADD COLUMN IF NOT EXISTS mfe_trail_activated boolean,       -- +30% atteint dans la fenêtre 24h
  ADD COLUMN IF NOT EXISTS mfe_computed_at     timestamptz,   -- NULL = pas encore calculé
  ADD COLUMN IF NOT EXISTS mfe_pool_address    text;          -- pool GeckoTerminal (cache)

-- Index partiel pour la pagination wallet-mfe (?limit=N prend les IS NULL)
CREATE INDEX IF NOT EXISTS idx_risque_tokens_mfe_computed
  ON kymia_risque_tokens (mfe_computed_at)
  WHERE mfe_computed_at IS NULL;

-- Vérification
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE mfe_computed_at IS NULL)     AS a_calculer,
       COUNT(*) FILTER (WHERE mfe_computed_at IS NOT NULL) AS deja_calcules,
       COUNT(*) FILTER (WHERE mfe_mult_24h IS NOT NULL)    AS avec_donnees
FROM kymia_risque_tokens;
