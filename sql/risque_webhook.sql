-- Migration : module Risque — webhook Helius
-- À exécuter dans Supabase SQL Editor AVANT le premier déploiement du webhook.
--
-- Tables créées :
--   kymia_risque_webhooks_raw   — filet de sécurité : payload brut écrit avant traitement
--   kymia_risque_tokens         — un token par mint, scores + flags rug
--   kymia_risque_buys           — un achat par (wallet × signature)
--   kymia_risque_sells          — une vente par (wallet × signature)
--   kymia_risque_settings       — configuration clé-valeur (seuils ajustables sans déploiement)
--
-- Tables NON modifiées :
--   kymia_risque_wallets        — 18 wallets, réutilisée telle quelle
--   kymia_risque_signals        — 46 signaux polling archivés, conservée en lecture
--
-- Seuil market cap : stocké dans kymia_risque_settings, filtré à LA LECTURE
-- (pas à l'insertion) — permet d'ajuster le seuil rétroactivement sans perte de données.

-- ── 1. Filet de sécurité — payload brut ──────────────────────────────────────
-- Écrit en premier, avant le 200, avant tout traitement.
-- Si after() plante, processed=false + error=message → rejouable manuellement.

create table if not exists kymia_risque_webhooks_raw (
  id           uuid        primary key default gen_random_uuid(),
  received_at  timestamptz not null    default now(),
  payload      jsonb       not null,
  processed    boolean     not null    default false,
  processed_at timestamptz,
  error        text
);

-- Index pour monitorer les échecs : SELECT * FROM kymia_risque_webhooks_raw WHERE processed=false
create index if not exists kymia_risque_webhooks_raw_unprocessed
  on kymia_risque_webhooks_raw (processed, received_at desc);


-- ── 2. Tokens — un mint par ligne ────────────────────────────────────────────

create table if not exists kymia_risque_tokens (
  mint                  text        primary key,
  symbol                text,
  name                  text,

  -- Market cap (lecture on-chain bonding curve, fallback DexScreener si gradué)
  market_cap_usd        numeric,
  mcap_source           text,       -- 'onchain' | 'dexscreener'

  -- Flags rug bruts (pour queries SQL futures, ex: WHERE dev_pct > 10)
  dev_pct               numeric,    -- % tokens tenus par le créateur
  top10_pct             numeric,    -- % top 10 holders non-dev
  dev_sold              boolean,    -- true = créateur a vendu
  bundled               boolean,    -- true = lancement en bundle confirmé, null = non détecté
  mint_auth_revoked     boolean,    -- true = safe
  freeze_auth_revoked   boolean,    -- true = safe

  -- Score final
  risque_score          text,       -- 'CLEAN' | 'CAUTION' | 'DANGER' | 'DATA_UNAVAILABLE'
  score_reason          text,       -- premier flag déclencheur (ex: "dev holds 12.3%")
  rug_flags             jsonb,      -- détail complet pour affichage / debug

  -- Compteurs dénormalisés (mis à jour par upsert à chaque buy/sell)
  buyer_count           int         not null default 0,
  seller_count          int         not null default 0,

  first_seen_at         timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);


-- ── 3. Achats — un par (wallet × signature) ──────────────────────────────────
-- Pas de FK sur token_mint : l'ordre d'arrivée webhook n'est pas garanti.
-- La cohérence est gérée dans le code (upsert token avant insert buy).

create table if not exists kymia_risque_buys (
  id                uuid        primary key default gen_random_uuid(),
  token_mint        text        not null,   -- pas de FK — voir commentaire ci-dessus
  wallet_address    text        not null,
  wallet_label      text,
  tx_signature      text        not null unique,   -- déduplique les replays
  bought_at         timestamptz not null,
  sol_amount        numeric,
  usdc_amount       numeric,
  market_cap_at_buy numeric,
  created_at        timestamptz not null default now()
);

create index if not exists kymia_risque_buys_token   on kymia_risque_buys (token_mint, bought_at desc);
create index if not exists kymia_risque_buys_wallet  on kymia_risque_buys (wallet_address);
create index if not exists kymia_risque_buys_time    on kymia_risque_buys (bought_at desc);


-- ── 4. Ventes — même structure, direction inverse ────────────────────────────

create table if not exists kymia_risque_sells (
  id                uuid        primary key default gen_random_uuid(),
  token_mint        text        not null,
  wallet_address    text        not null,
  wallet_label      text,
  tx_signature      text        not null unique,
  sold_at           timestamptz not null,
  sol_received      numeric,
  usdc_received     numeric,
  created_at        timestamptz not null default now()
);

create index if not exists kymia_risque_sells_token   on kymia_risque_sells (token_mint, sold_at desc);
create index if not exists kymia_risque_sells_wallet  on kymia_risque_sells (wallet_address);
create index if not exists kymia_risque_sells_time    on kymia_risque_sells (sold_at desc);


-- ── 5. Configuration — seuils ajustables sans déploiement ────────────────────
-- Le seuil max_mc_usd est lu depuis cette table à chaque traitement webhook.
-- Il filtre à LA CONSULTATION, pas à l'insertion → ajustement rétroactif possible.
--
-- Pour changer le seuil :
--   UPDATE kymia_risque_settings SET value = '75000', updated_at = now()
--   WHERE key = 'max_mc_usd';

create table if not exists kymia_risque_settings (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

insert into kymia_risque_settings (key, value, updated_at) values
  ('max_mc_usd', '50000', now())
on conflict (key) do nothing;


-- ── Vérification rapide post-exécution ───────────────────────────────────────
-- Colle cette requête après pour confirmer que tout est créé :
--
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name LIKE 'kymia_risque_%'
-- ORDER BY table_name;
--
-- Résultat attendu (7 tables) :
--   kymia_risque_buys
--   kymia_risque_sells
--   kymia_risque_settings
--   kymia_risque_signals       ← ancienne table archivée, non modifiée
--   kymia_risque_tokens
--   kymia_risque_wallets       ← existante, non modifiée
--   kymia_risque_webhooks_raw
