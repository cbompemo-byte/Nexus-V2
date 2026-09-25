-- risque_005_strong_buyers.sql
-- À exécuter dans Supabase SQL Editor.
--
-- 1. Setting convergence_strong_buyers
-- 2. Colonne source sur kymia_risque_wallets
-- 3. Tagguer les wallets DISCOVERY existants

-- ── 1. Settings ──────────────────────────────────────────────────────────────
INSERT INTO kymia_risque_settings (key, value, updated_at) VALUES
  ('convergence_strong_buyers',   3,   now()),
  ('strong_path_window_minutes',  360, now()),
  ('min_avg_usd_per_buy',         500, now())
ON CONFLICT (key) DO NOTHING;

-- ── 2. Colonne source ─────────────────────────────────────────────────────────
ALTER TABLE kymia_risque_wallets
  ADD COLUMN IF NOT EXISTS source text;

-- ── 3. Taguer les wallets DISCOVERY existants (label 'alpha_XXXXXX') ──────────
UPDATE kymia_risque_wallets
  SET source = 'DISCOVERY'
  WHERE label LIKE 'alpha_%'
    AND source IS NULL;

-- ── 4. Optionnel : relever min_usd_per_buyer pour le chemin fort ──────────────
-- Le fast-path exige 200$ (hardcodé dans positions.ts STRONG_MIN_USD).
-- Pour aligner le chemin normal sur le même seuil (recommandé) :
--   UPDATE kymia_risque_settings SET value=200, updated_at=now()
--   WHERE key='min_usd_per_buyer';

-- Vérification
SELECT key, value FROM kymia_risque_settings
  WHERE key IN ('convergence_strong_buyers', 'strong_path_window_minutes', 'min_avg_usd_per_buy');
SELECT COUNT(*) AS discovery_wallets FROM kymia_risque_wallets WHERE source='DISCOVERY';
