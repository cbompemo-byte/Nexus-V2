-- risque_014_paper_costs.sql
-- Coûts réalistes pour le paper trading.
-- Ces deux settings sont appliqués dans closePosition et takePartialProfit
-- uniquement sur les positions is_paper=true.
--
-- paper_fee_pct      : frais de plateforme/transaction, prélevés à l'ENTRÉE et à la SORTIE.
--                      Exemple : 1% → 2% de coût total aller-retour.
-- paper_slippage_pct : slippage d'exécution. Le prix d'entrée est majoré de ce %,
--                      le prix de sortie est minoré. Simule l'impact de marché.
--                      Exemple : 2% → prix effectif d'entrée = entry × 1.02,
--                                      prix effectif de sortie = exit  × 0.98.
--
-- Impact sur une position $100 gagnant +20% sans coûts :
--   Sans costs  : pnl = +$20.00  (+20.0%)
--   Avec costs  : entry effectif = ×1.02, exit effectif = ×0.98
--                 pnl price = (exit×0.98 - entry×1.02) / (entry×1.02) × $100
--                           ≈ +$15.69
--                 fees = $100 × 1% × 2 = -$2.00
--                 pnl net ≈ +$13.69  (+13.7%)
--   → Coût total ≈ 6.3 points sur un +20% — réaliste pour pump.fun.

INSERT INTO kymia_risque_settings (key, value, updated_at) VALUES
  ('paper_fee_pct',      '1', now()),   -- 1% par côté (entrée + sortie)
  ('paper_slippage_pct', '2', now())    -- 2% de slippage par côté
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Vérification
SELECT key, value FROM kymia_risque_settings
WHERE key IN ('paper_fee_pct', 'paper_slippage_pct')
ORDER BY key;
