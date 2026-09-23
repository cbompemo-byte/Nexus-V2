-- risque_003_wallet_expansion.sql
-- À exécuter dans Supabase SQL Editor.
--
-- 1. Nouveaux settings checkEntry (PARTIE 3)
-- 2. Nouvelle colonne kymia_risque_tokens.dex_buy_ratio_1h (PARTIE 3)
-- 3. Env var à ajouter : HELIUS_WEBHOOK_ID (optionnel — auto-détecté sinon)

-- ── 1. Nouveaux settings ─────────────────────────────────────────────────────
INSERT INTO kymia_risque_settings (key, value, updated_at) VALUES
  ('convergence_window_minutes', 60,    now()),
  ('max_price_run_pct',          50,    now()),
  ('dex_confirm_enabled',        false, now())
ON CONFLICT (key) DO NOTHING;

-- Vérification
SELECT key, value FROM kymia_risque_settings
WHERE key IN ('convergence_window_minutes', 'max_price_run_pct', 'dex_confirm_enabled')
ORDER BY key;

-- ── 2. Colonne dex_buy_ratio_1h ──────────────────────────────────────────────
-- Stocke le ratio achats/(achats+ventes) sur 1h depuis DexScreener.
-- Valeur entre 0 et 1. NULL = pas encore fetché.
ALTER TABLE kymia_risque_tokens
  ADD COLUMN IF NOT EXISTS dex_buy_ratio_1h float;

-- ── 3. Rappel env vars à ajouter sur Vercel ──────────────────────────────────
-- (ne pas exécuter — pour mémoire)
--
-- HELIUS_WEBHOOK_ID = <id du webhook Helius> (optionnel)
--   → Si absent, sync-webhook auto-détecte le webhook via l'URL de callback.
--   → Récupérer via : GET https://api.helius.xyz/v0/webhooks?api-key=<ta_clé>
--   → Ou via GET /api/admin/risque/sync-webhook (retourne la liste des webhooks trouvés)
--
-- Aucune autre migration requise pour les PARTIES 1 et 2.
-- kymia_risque_wallets existait déjà (colonnes : address, label, active).
