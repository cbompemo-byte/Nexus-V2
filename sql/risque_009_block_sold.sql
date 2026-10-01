-- risque_009_block_sold.sql
-- À exécuter dans Supabase SQL Editor.
-- Nouveau setting : block_if_sold_within_minutes
-- Skip l'entrée si un wallet suivi a vendu ce token dans les N dernières minutes.

INSERT INTO kymia_risque_settings (key, value, updated_at)
VALUES ('block_if_sold_within_minutes', '30', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Vérification
SELECT key, value FROM kymia_risque_settings WHERE key = 'block_if_sold_within_minutes';
