-- risque_007_backfill.sql
-- À exécuter dans Supabase SQL Editor.
-- Prérequis pour l'endpoint GET /api/admin/risque/recent-buys.

-- ── 1. Colonne source sur kymia_risque_buys ───────────────────────────────────────
-- 'BACKFILL' = inséré par recent-buys (RPC public, 48h rétro)
-- NULL       = inséré par le webhook Helius (comportement historique)
ALTER TABLE kymia_risque_buys
  ADD COLUMN IF NOT EXISTS source text;

-- ── 2. Colonne last_backfill_at sur kymia_risque_wallets ──────────────────────────
-- Marqueur de pagination : NULL = non encore traité par recent-buys.
ALTER TABLE kymia_risque_wallets
  ADD COLUMN IF NOT EXISTS last_backfill_at timestamptz;

-- Index partiel pour accélérer le filtre IS NULL
CREATE INDEX IF NOT EXISTS idx_risque_wallets_last_backfill_at
  ON kymia_risque_wallets (last_backfill_at)
  WHERE last_backfill_at IS NULL;

-- ── Vérification ──────────────────────────────────────────────────────────────────
SELECT COUNT(*) AS wallets_actifs,
       COUNT(*) FILTER (WHERE last_backfill_at IS NULL) AS a_backfiller
FROM kymia_risque_wallets
WHERE active = true;
