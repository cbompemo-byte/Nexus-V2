-- risque_004_discover_settings.sql
-- Paramètres de discover-wallets en base — modifiables sans redéploiement.
-- À exécuter dans Supabase SQL Editor.

INSERT INTO kymia_risque_settings (key, value, updated_at) VALUES
  ('discover_min_gain_pct',      200,                              now()),
  ('discover_min_gain_h6_pct',   80,                               now()),
  ('discover_min_mcap_usd',      50000,                            now()),
  ('discover_max_mcap_usd',      5000000,                          now()),
  ('discover_allowed_dexids',    '["pumpfun","pumpswap","raydium"]', now()),
  ('discover_max_pair_age_days', 30,                               now()),
  ('discover_min_wins',          2,                                now()),
  ('discover_early_tx_count',    30,                               now()),
  ('discover_min_entry_rank',    15,                               now())
ON CONFLICT (key) DO NOTHING;

-- Vérification
SELECT key, value FROM kymia_risque_settings
WHERE key LIKE 'discover_%'
ORDER BY key;

-- Pour ajuster sans redéployer (exemples) :
--   UPDATE kymia_risque_settings SET value=150  WHERE key='discover_min_gain_pct';
--   UPDATE kymia_risque_settings SET value=1    WHERE key='discover_min_wins';
--   UPDATE kymia_risque_settings SET value=10000000 WHERE key='discover_max_mcap_usd';
