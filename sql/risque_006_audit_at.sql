-- risque_006_audit_at.sql
-- À exécuter dans Supabase SQL Editor.
-- Ajoute audited_at sur kymia_risque_wallets pour le mécanisme de pagination
-- de l'endpoint audit-discovery (?limit=N&offset=M).

ALTER TABLE kymia_risque_wallets
  ADD COLUMN IF NOT EXISTS audited_at timestamptz;

-- Index pour accélérer le filtre IS NULL
CREATE INDEX IF NOT EXISTS idx_risque_wallets_audited_at
  ON kymia_risque_wallets (audited_at)
  WHERE audited_at IS NULL;

-- Vérification
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE audited_at IS NULL) AS non_audites,
       COUNT(*) FILTER (WHERE audited_at IS NOT NULL) AS audites
FROM kymia_risque_wallets
WHERE source = 'DISCOVERY';
