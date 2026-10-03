-- risque_011_take_profit.sql
-- À exécuter dans Supabase SQL Editor.
-- Nouveau setting : take_profit_pct
-- Ferme la position dès que le prix atteint entry_price × (1 + take_profit_pct/100).

INSERT INTO kymia_risque_settings (key, value, updated_at)
VALUES ('take_profit_pct', '15', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Vérification
SELECT key, value FROM kymia_risque_settings
WHERE key IN ('take_profit_pct', 'trailing_activation_pct', 'stop_loss_pct')
ORDER BY key;
