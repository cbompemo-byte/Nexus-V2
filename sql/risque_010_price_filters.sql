-- risque_010_price_filters.sql
-- À exécuter dans Supabase SQL Editor.
-- Deux nouveaux settings de filtrage du prix d'entrée.

INSERT INTO kymia_risque_settings (key, value, updated_at)
VALUES
  -- Couteau qui tombe : skip si prix < X% du mcap du 1er déclencheur.
  -- Ex : 1er acheteur 360K, entrée 180K = 50% < seuil 70% → SKIP.
  ('min_price_vs_first_trigger_pct', '70', now()),
  -- Après le pic : skip si mcap courant a baissé de plus de X% depuis le
  -- pic (max market_cap_at_buy dans la fenêtre 6h).
  -- Ex : pic 594K, entrée 404K = -32% > seuil -20% → SKIP.
  ('max_drawdown_from_peak_pct', '20', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Vérification
SELECT key, value FROM kymia_risque_settings
WHERE key IN (
  'max_price_run_pct',
  'min_price_vs_first_trigger_pct',
  'max_drawdown_from_peak_pct'
)
ORDER BY key;
