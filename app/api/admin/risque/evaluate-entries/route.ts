// app/api/admin/risque/evaluate-entries/route.ts
// Évaluation rétrospective des convergences historiques — ouvre les positions paper éligibles.
//
// Usage :
//   POST /api/admin/risque/evaluate-entries
//   Header : x-admin-key: <KYMIA_ADMIN_KEY>
//
// Body (JSON, optionnel) :
//   mcap_threshold?: number       — plafond mcap USD (défaut: settings.max_mc_usd)
//   max_staleness_hours?: number  — âge max du dernier achat déclencheur (défaut: 6)
//   dry_run?: boolean             — true = liste les candidats sans créer (défaut: false)
//
// Logique :
//   1. Tokens : risque_score ≠ DANGER, market_cap_usd ≤ threshold, buyer_count ≥ min
//   2. Filtre : pas de position existante (ouverte ou clôturée) sur ce mint
//   3. Détection MM : wallets avec >max_buys_per_wallet achats qualifiés exclus
//   4. Wallets qualifiés (USD ≥ min) et non-MM : doit y en avoir ≥ minBuyersForEntry
//   5. FRAÎCHEUR : le dernier achat du Nème buyer doit dater de < max_staleness_hours
//      → évite d'ouvrir sur des convergences périmées (prix déjà effondrés)
//   6. entry_price = market_cap_at_buy du Nème buyer / 1e9 (pump.fun 1B supply)
//   7. Guard max_concurrent_positions avant chaque insertion
//   8. is_backfilled = true sur toutes les positions créées ici (stats séparées)
//
// is_paper : toujours dérivé de live_mode en base (safety belt).

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { loadSettings }              from '@/lib/risque/positions'
import { fetchSolPriceUsd }          from '@/lib/risque/pumpfun'

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

interface BuyRow {
  wallet_address:    string
  wallet_label:      string | null
  sol_amount:        number | null
  usdc_amount:       number | null
  bought_at:         string
  market_cap_at_buy: number | null
}

interface TokenRow {
  mint:           string
  symbol:         string | null
  risque_score:   string | null
  market_cap_usd: number | null
  buyer_count:    number | null
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })
  const settings = await loadSettings(supabase)

  // Body optionnel
  let body: { mcap_threshold?: number; max_staleness_hours?: number; dry_run?: boolean } = {}
  try { body = await req.json() } catch { /* pas de body = ok */ }

  const mcapThreshold     = body.mcap_threshold ?? settings.maxMcUsd
  const maxStalenessHours = body.max_staleness_hours ?? 6
  const dryRun            = body.dry_run ?? false
  const stalenessWindow   = new Date(Date.now() - maxStalenessHours * 3600_000).toISOString()

  // SAFETY BELT : is_paper toujours dérivé de live_mode en base
  const isPaper = !settings.liveMode

  // Prix SOL pour convertir sol_amount → USD (fallback 100 si indisponible)
  let solPriceUsd = 100
  try { solPriceUsd = await fetchSolPriceUsd() } catch { /* fallback conservateur */ }

  const buyUsd = (b: { sol_amount: number | null; usdc_amount: number | null }): number =>
    Math.max((b.sol_amount ?? 0) * solPriceUsd, b.usdc_amount ?? 0)

  // ── 1. Tokens candidats ───────────────────────────────────────────────────
  const { data: tokens, error: tokErr } = await supabase
    .from('kymia_risque_tokens')
    .select('mint, symbol, risque_score, market_cap_usd, buyer_count')
    .neq('risque_score', 'DANGER')
    .lte('market_cap_usd', mcapThreshold)
    .gte('buyer_count', settings.minBuyersForEntry)

  if (tokErr) {
    return NextResponse.json({ error: `tokens query: ${tokErr.message}` }, { status: 500 })
  }

  const opened:  object[] = []
  const skipped: object[] = []

  for (const tok of (tokens ?? []) as TokenRow[]) {
    const mint = tok.mint
    const tag  = `[evaluate-entries] ${mint.slice(0, 8)}…`

    // ── 2. Pas de position existante (ouverte ou clôturée) ───────────────────
    const { data: existingPos } = await supabase
      .from('kymia_risque_positions')
      .select('id, status')
      .eq('token_mint', mint)
      .limit(1)
      .maybeSingle()

    if (existingPos) {
      const reason = `position déjà existante (${(existingPos as any).status})`
      console.log(`${tag} SKIP: ${reason}`)
      skipped.push({ mint, symbol: tok.symbol, reason })
      continue
    }

    // ── 3. Charger l'historique complet des achats ───────────────────────────
    const { data: buys } = await supabase
      .from('kymia_risque_buys')
      .select('wallet_address, wallet_label, sol_amount, usdc_amount, bought_at, market_cap_at_buy')
      .eq('token_mint', mint)
      .order('bought_at', { ascending: true })
    // Pas de filtre montant côté DB — filtre USD en mémoire ci-dessous.

    // ── Détection MM : >maxBuysPerWallet achats qualifiés (USD) = market maker → exclu ──
    const walletBuyCount = new Map<string, number>()
    for (const b of (buys ?? []) as BuyRow[]) {
      if (buyUsd(b) < settings.minUsdPerBuyer) continue
      walletBuyCount.set(b.wallet_address, (walletBuyCount.get(b.wallet_address) ?? 0) + 1)
    }

    const mmWallets = new Set(
      [...walletBuyCount.entries()]
        .filter(([, n]) => n > settings.maxBuysPerWallet)
        .map(([wallet]) => wallet)
    )

    if (mmWallets.size > 0) {
      console.log(
        `${tag} MM exclus (>${settings.maxBuysPerWallet} achats ≥$${settings.minUsdPerBuyer} historiques):` +
        ` ${mmWallets.size} wallet(s) — ${[...mmWallets].join(', ')}`
      )
    }

    // ── 4. Reconstruire les acheteurs non-MM qualifiés (USD ≥ seuil) ─────────
    // Suivi du 1er achat par wallet (ordre chronologique + mcap de déclenchement)
    type BuyerInfo = { label: string; totalUsd: number; firstBoughtAt: string; firstMcap: number | null }
    const buyerFirstAppearance = new Map<string, BuyerInfo>()

    for (const b of (buys ?? []) as BuyRow[]) {
      if (mmWallets.has(b.wallet_address)) continue
      const usd = buyUsd(b)
      if (usd < settings.minUsdPerBuyer) continue
      const walletKey = b.wallet_address
      if (!buyerFirstAppearance.has(walletKey)) {
        buyerFirstAppearance.set(walletKey, {
          label:         b.wallet_label ?? walletKey.slice(0, 8),
          totalUsd:      0,
          firstBoughtAt: b.bought_at,
          firstMcap:     b.market_cap_at_buy,
        })
      }
      const prev = buyerFirstAppearance.get(walletKey)!
      buyerFirstAppearance.set(walletKey, { ...prev, totalUsd: prev.totalUsd + usd })
    }

    if (buyerFirstAppearance.size < settings.minBuyersForEntry) {
      const mmNote = mmWallets.size > 0 ? ` (${mmWallets.size} MM exclus)` : ''
      const reason = `${buyerFirstAppearance.size}/${settings.minBuyersForEntry} wallets qualifiés après filtre USD+MM (min $${settings.minUsdPerBuyer})${mmNote}`
      console.log(`${tag} SKIP: ${reason}`)
      skipped.push({ mint, symbol: tok.symbol, reason })
      continue
    }

    // Trier les buyers par ordre d'apparition (1er achat chronologique)
    const sortedBuyers = [...buyerFirstAppearance.entries()]
      .sort((a, b) => a[1].firstBoughtAt.localeCompare(b[1].firstBoughtAt))

    const nthEntry = sortedBuyers[settings.minBuyersForEntry - 1]

    // ── 5. Fraîcheur : le Nème buyer déclencheur doit être récent ────────────
    // Sans ce filtre, on ouvre sur des convergences périmées — prix déjà effondrés,
    // le stop ne peut pas jouer car l'écart entry→prix actuel > stop dès l'ouverture.
    const nthBuyAt = nthEntry[1].firstBoughtAt
    if (nthBuyAt < stalenessWindow) {
      const ageH   = ((Date.now() - new Date(nthBuyAt).getTime()) / 3600_000).toFixed(1)
      const reason = `convergence périmée — ${settings.minBuyersForEntry}e buyer il y a ${ageH}h (max ${maxStalenessHours}h)`
      console.log(`${tag} SKIP: ${reason}`)
      skipped.push({ mint, symbol: tok.symbol, reason, nth_buy_at: nthBuyAt })
      continue
    }

    // ── 6. Guard max positions concurrent (avec garde-fou live) ─────────────
    const safeConcurrentMax = settings.liveMode
      ? Math.min(
          settings.maxConcurrentPositions,
          Math.floor(settings.capitalUsd / Math.max(settings.positionSizeUsd, 1)),
        )
      : settings.maxConcurrentPositions

    const { count: openCount } = await supabase
      .from('kymia_risque_positions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'OPEN')

    if ((openCount ?? 0) >= safeConcurrentMax) {
      const reason = `${openCount}/${safeConcurrentMax} positions concurrent max atteintes`
      console.log(`${tag} SKIP: ${reason}`)
      skipped.push({ mint, symbol: tok.symbol, reason })
      continue
    }

    // ── 6b. Plafond journalier (UTC) ─────────────────────────────────────────
    const todayUtc = new Date()
    todayUtc.setUTCHours(0, 0, 0, 0)
    const { count: todayCount } = await supabase
      .from('kymia_risque_positions')
      .select('*', { count: 'exact', head: true })
      .gte('entry_at', todayUtc.toISOString())
      .eq('is_backfilled', false)

    if ((todayCount ?? 0) >= settings.maxPositionsPerDay) {
      const reason = `${todayCount}/${settings.maxPositionsPerDay} positions ouvertes aujourd'hui (UTC) — relancer demain`
      console.log(`${tag} SKIP: ${reason}`)
      skipped.push({ mint, symbol: tok.symbol, reason })
      continue
    }

    // ── 7. entry_price = mcap au Nème buyer / 1e9 ────────────────────────────
    const nthMcap    = nthEntry[1].firstMcap ?? tok.market_cap_usd
    const entryPrice = nthMcap !== null && nthMcap > 0 ? nthMcap / 1e9 : null

    if (entryPrice === null) {
      const reason = `market_cap_at_buy du ${settings.minBuyersForEntry}e buyer absent — prix d'entrée indisponible`
      console.log(`${tag} SKIP: ${reason}`)
      skipped.push({ mint, symbol: tok.symbol, reason })
      continue
    }

    const stopPriceUsd  = entryPrice * (1 - settings.stopLossPct / 100)
    const totalUsd      = [...buyerFirstAppearance.values()].reduce((s, b) => s + b.totalUsd, 0)
    const triggerLabels = sortedBuyers.map(([, v]) => v.label)
    const triggerReason = `evaluate-entries: ${buyerFirstAppearance.size} wallets, $${totalUsd.toFixed(0)} total`

    const candidateInfo = {
      mint,
      symbol:           tok.symbol,
      mcap_usd:         tok.market_cap_usd,
      buyer_count:      buyerFirstAppearance.size,
      total_usd:        Math.round(totalUsd),
      mm_excluded:      mmWallets.size,
      entry_price_usd:  entryPrice,
      stop_price_usd:   parseFloat(stopPriceUsd.toFixed(12)),
      trigger_wallets:  triggerLabels,
      nth_buyer_mcap:   nthMcap,
    }

    if (dryRun) {
      console.log(
        `${tag} DRY_RUN: candidat — entry=$${entryPrice}` +
        ` mcap=$${tok.market_cap_usd} buyers=${buyerFirstAppearance.size} mm_excl=${mmWallets.size}`
      )
      opened.push(candidateInfo)
      continue
    }

    // ── 7. Insertion position ─────────────────────────────────────────────────
    const { data: inserted, error: insertErr } = await supabase
      .from('kymia_risque_positions')
      .insert({
        token_mint:         mint,
        token_symbol:       tok.symbol ?? null,
        entry_price_usd:    entryPrice,
        entry_market_cap:   tok.market_cap_usd,
        size_usd:           settings.positionSizeUsd,
        trigger_reason:     triggerReason,
        trigger_wallets:    triggerLabels,
        security_score:     tok.risque_score ?? null,
        stop_price_usd:     stopPriceUsd,
        high_since_entry:   entryPrice,
        trailing_active:    false,
        status:             'OPEN',
        is_paper:           isPaper,
        is_backfilled:      true,   // position rétroactive — exclure des stats de performance live
        tx_signature_entry: null,
      })
      .select('id')
      .single()

    if (insertErr) {
      const reason = `insert error: ${insertErr.message}`
      console.error(`${tag} ERROR: ${reason}`)
      skipped.push({ ...candidateInfo, reason })
      continue
    }

    const positionId = (inserted as any).id
    console.log(
      `${tag} OPEN: ${isPaper ? 'PAPER' : 'LIVE'}` +
      ` entry=$${entryPrice}` +
      ` mcap=$${tok.market_cap_usd}` +
      ` stop=$${stopPriceUsd.toFixed(8)}` +
      ` buyers=${buyerFirstAppearance.size}` +
      ` mm_excl=${mmWallets.size}` +
      ` id=${positionId}`
    )

    opened.push({ ...candidateInfo, position_id: positionId })
  }

  const totalTokensChecked = (tokens?.length ?? 0)
  console.log(
    `[evaluate-entries] terminé — ${totalTokensChecked} tokens évalués,` +
    ` ${opened.length} ${dryRun ? 'candidats (dry_run)' : 'positions ouvertes'},` +
    ` ${skipped.length} skippés`
  )

  return NextResponse.json({
    ok:                  true,
    dry_run:             dryRun,
    is_paper:            isPaper,
    mcap_threshold:      mcapThreshold,
    max_staleness_hours: maxStalenessHours,
    sol_price_usd: solPriceUsd,
    settings: {
      minBuyersForEntry:      settings.minBuyersForEntry,
      minUsdPerBuyer:         settings.minUsdPerBuyer,
      maxBuysPerWallet:       settings.maxBuysPerWallet,
      maxMcUsd:               settings.maxMcUsd,
      stopLossPct:            settings.stopLossPct,
      positionSizeUsd:        settings.positionSizeUsd,
      maxConcurrentPositions: settings.maxConcurrentPositions,
    },
    tokens_evaluated: totalTokensChecked,
    opened_count:     opened.length,
    skipped_count:    skipped.length,
    opened,
    skipped,
  })
}
