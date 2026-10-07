-- risque_013_features.sql
-- À exécuter dans Supabase SQL Editor.
-- Trois évolutions : vente partielle TP, tier A wallets, stratégie SCOUT.

-- ── 1. Positions ──────────────────────────────────────────────────────────────
ALTER TABLE kymia_risque_positions
  ADD COLUMN IF NOT EXISTS partial_tp_taken  bool   DEFAULT false,
  ADD COLUMN IF NOT EXISTS realized_pnl_usd  float8,           -- PnL encaissé lors de la vente partielle
  ADD COLUMN IF NOT EXISTS original_size_usd float8,           -- taille initiale, jamais modifiée → base du pnl_pct
  ADD COLUMN IF NOT EXISTS strategy_tag      text;             -- 'CONV' | 'SCOUT' | 'SCOUT+CONV'

-- ── 2. Wallets ────────────────────────────────────────────────────────────────
ALTER TABLE kymia_risque_wallets
  ADD COLUMN IF NOT EXISTS tier text;   -- 'A' = éclaireur (à renseigner manuellement) ; NULL = normal

-- ── 3. Settings ───────────────────────────────────────────────────────────────
INSERT INTO kymia_risque_settings (key, value, updated_at) VALUES
  ('take_profit_sell_pct', '50',     now()),   -- % de la position vendu au TP (100 = sortie totale)
  ('scout_size_usd',       '25',     now()),   -- taille position éclaireur en $
  ('scout_max_mcap_usd',   '300000', now()),   -- mcap max pour déclencher un éclaireur
  ('scout_min_usd',        '1000',   now())    -- achat min $ du wallet tier A pour qualifier
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- ── Vérification ──────────────────────────────────────────────────────────────
SELECT key, value FROM kymia_risque_settings
WHERE key IN (
  'take_profit_sell_pct', 'scout_size_usd', 'scout_max_mcap_usd', 'scout_min_usd',
  'take_profit_pct', 'stop_loss_pct'
)
ORDER BY key;

-- Marquer les wallets tier A (à adapter à tes adresses réelles) :
-- UPDATE kymia_risque_wallets SET tier = 'A' WHERE label IN ('risque_15','risque_04','risque_16');
