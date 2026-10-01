// app/api/admin/risque/wallet-audit/route.ts
// Classifie les wallets actuels à partir de kymia_risque_buys.
//
// Usage :
//   GET /api/admin/risque/wallet-audit
//   Header : x-admin-key: <KYMIA_ADMIN_KEY>
//
// Pour chaque wallet dans kymia_risque_wallets :
//   - nb_tokens_bought       : tokens distincts achetés
//   - nb_total_buys          : achats totaux
//   - mm_buy_pct             : % d'achats sur des tokens où ce wallet a > 5 achats (pattern MM)
//   - avg_mcap_entry_usd     : market cap moyen à l'achat (USD)
//   - avg_buy_usd            : taille moyenne d'achat (USD, sol×prix+usdc)
//   - first_seen / last_seen : plage temporelle
//   - median_hold_minutes    : délai médian achat→vente (null si aucune vente)
//   - classification         : NORMAL | SUSPECT_MM | FLIPPER | INACTIVE
//   - note                   : motif détaillé

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

// Prix SOL approximatif (utilisé pour convertir sol_amount sans appel RPC)
const SOL_PRICE_APPROX = 150

// Délai médian achat→vente en dessous duquel un wallet est classé FLIPPER (minutes)
const FLIPPER_MEDIAN_MINUTES = 10

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null
  const s   = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }

  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  // ── 1. Wallets actifs ─────────────────────────────────────────────────────
  const { data: wallets, error: wErr } = await supabase
    .from('kymia_risque_wallets')
    .select('address, label, active')
    .order('label', { ascending: true })

  if (wErr) return NextResponse.json({ error: wErr.message }, { status: 500 })

  // ── 2. Tous les achats — paginés pour dépasser la limite 1 000 lignes ─────
  type BuyRecord = {
    token_mint:        string
    sol_amount:        number | null
    usdc_amount:       number | null
    market_cap_at_buy: number | null
    bought_at:         string
  }
  const allBuysFlat: (BuyRecord & { wallet_address: string })[] = []
  const BUY_PAGE = 1000
  let buyOffset  = 0
  while (true) {
    const { data, error: bErr } = await supabase
      .from('kymia_risque_buys')
      .select('wallet_address, token_mint, sol_amount, usdc_amount, market_cap_at_buy, bought_at')
      .range(buyOffset, buyOffset + BUY_PAGE - 1)
    if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 })
    allBuysFlat.push(...((data ?? []) as (BuyRecord & { wallet_address: string })[]))
    if ((data ?? []).length < BUY_PAGE) break
    buyOffset += BUY_PAGE
  }

  // ── 3. Toutes les ventes — pour détection flipper ─────────────────────────
  type SellRecord = { token_mint: string; sold_at: string }
  const allSellsFlat: (SellRecord & { wallet_address: string })[] = []
  const SELL_PAGE = 1000
  let sellOffset  = 0
  while (true) {
    const { data, error: sErr } = await supabase
      .from('kymia_risque_sells')
      .select('wallet_address, token_mint, sold_at')
      .range(sellOffset, sellOffset + SELL_PAGE - 1)
    if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
    allSellsFlat.push(...((data ?? []) as (SellRecord & { wallet_address: string })[]))
    if ((data ?? []).length < SELL_PAGE) break
    sellOffset += SELL_PAGE
  }

  // Indexer les achats et ventes par wallet
  const buysByWallet  = new Map<string, BuyRecord[]>()
  for (const b of allBuysFlat) {
    const arr = buysByWallet.get(b.wallet_address) ?? []
    arr.push(b)
    buysByWallet.set(b.wallet_address, arr)
  }

  const sellsByWallet = new Map<string, (SellRecord)[]>()
  for (const s of allSellsFlat) {
    const arr = sellsByWallet.get(s.wallet_address) ?? []
    arr.push(s)
    sellsByWallet.set(s.wallet_address, arr)
  }

  const buyUsd = (b: BuyRecord): number =>
    Math.max((b.sol_amount ?? 0) * SOL_PRICE_APPROX, b.usdc_amount ?? 0)

  // ── 4. Classifier chaque wallet ──────────────────────────────────────────
  const report = (wallets ?? []).map(w => {
    const wBuys  = buysByWallet.get(w.address as string)  ?? []
    const wSells = sellsByWallet.get(w.address as string) ?? []

    if (wBuys.length === 0) {
      return {
        address:             w.address,
        label:               w.label,
        active:              w.active,
        nb_total_buys:       0,
        nb_tokens_bought:    0,
        mm_buy_pct:          null,
        avg_mcap_entry_usd:  null,
        avg_buy_usd:         null,
        first_seen:          null,
        last_seen:           null,
        median_hold_minutes: null,
        nb_sells:            0,
        classification:      'INACTIVE' as const,
        note:                'Aucun achat enregistré',
      }
    }

    // Tokens distincts
    const tokenSet = new Set(wBuys.map(b => b.token_mint))
    const nbTokens = tokenSet.size

    // Pattern MM : tokens sur lesquels ce wallet a > 5 achats
    const buyCountByToken = new Map<string, number>()
    for (const b of wBuys) {
      buyCountByToken.set(b.token_mint, (buyCountByToken.get(b.token_mint) ?? 0) + 1)
    }
    const mmTokens = [...buyCountByToken.values()].filter(n => n > 5)
    const mmBuys   = mmTokens.reduce((s, n) => s + n, 0)
    const mmBuyPct = wBuys.length > 0 ? (mmBuys / wBuys.length) * 100 : 0

    // Mcap moyen à l'entrée
    const mcapValues = wBuys.filter(b => b.market_cap_at_buy !== null).map(b => b.market_cap_at_buy!)
    const avgMcap    = mcapValues.length > 0
      ? mcapValues.reduce((s, v) => s + v, 0) / mcapValues.length
      : null

    // Taille moyenne d'achat
    const usdValues = wBuys.map(buyUsd).filter(v => v > 0)
    const avgBuyUsd = usdValues.length > 0
      ? usdValues.reduce((s, v) => s + v, 0) / usdValues.length
      : null

    // Plage temporelle
    const dates    = wBuys.map(b => b.bought_at).sort()
    const firstSeen = dates[0]
    const lastSeen  = dates.at(-1)!

    // ── Détection flipper : délai médian achat→vente par token ───────────
    // Pour chaque token, on apparie le PREMIER achat avec la PREMIÈRE vente
    // postérieure — reflète le comportement réel de sortie rapide.
    const holdTimes: number[] = []
    for (const mint of tokenSet) {
      const firstBuy = wBuys
        .filter(b => b.token_mint === mint)
        .sort((a, b) => a.bought_at.localeCompare(b.bought_at))[0]
      const firstSellAfter = wSells
        .filter(s => s.token_mint === mint && s.sold_at > firstBuy.bought_at)
        .sort((a, b) => a.sold_at.localeCompare(b.sold_at))[0]
      if (firstSellAfter) {
        const holdMin =
          (new Date(firstSellAfter.sold_at).getTime() - new Date(firstBuy.bought_at).getTime()) / 60_000
        holdTimes.push(holdMin)
      }
    }
    const medianHoldMin     = medianOf(holdTimes)
    const isFlipperPattern  = medianHoldMin !== null && medianHoldMin < FLIPPER_MEDIAN_MINUTES

    // ── Classification ────────────────────────────────────────────────────
    let classification: 'NORMAL' | 'SUSPECT_MM' | 'FLIPPER' | 'INACTIVE'
    let note: string

    if (isFlipperPattern) {
      classification = 'FLIPPER'
      note =
        `délai médian achat→vente = ${medianHoldMin!.toFixed(1)}min` +
        ` sur ${holdTimes.length} token(s) avec sortie (<${FLIPPER_MEDIAN_MINUTES}min = flipper)` +
        ` — copier structurellement perdant`
    } else if (mmBuyPct >= 70) {
      classification = 'SUSPECT_MM'
      note = `${mmBuyPct.toFixed(0)}% des achats sont sur des tokens avec >5 achats (${mmTokens.length} token(s) suspect(s))`
    } else if (mmBuyPct >= 30) {
      classification = 'SUSPECT_MM'
      note = `${mmBuyPct.toFixed(0)}% des achats en pattern MM — à surveiller`
    } else {
      classification = 'NORMAL'
      note = `${nbTokens} token(s) distincts, ${mmBuyPct.toFixed(0)}% pattern MM`
    }

    return {
      address:             w.address,
      label:               w.label,
      active:              w.active,
      nb_total_buys:       wBuys.length,
      nb_tokens_bought:    nbTokens,
      nb_sells:            wSells.length,
      mm_buy_pct:          parseFloat(mmBuyPct.toFixed(1)),
      mm_tokens_count:     mmTokens.length,
      avg_mcap_entry_usd:  avgMcap !== null ? Math.round(avgMcap) : null,
      avg_buy_usd:         avgBuyUsd !== null ? parseFloat(avgBuyUsd.toFixed(2)) : null,
      first_seen:          firstSeen,
      last_seen:           lastSeen,
      median_hold_minutes: medianHoldMin !== null ? parseFloat(medianHoldMin.toFixed(1)) : null,
      classification,
      note,
    }
  })

  // Trier : FLIPPER en premier (éviter absolument), puis SUSPECT_MM, NORMAL, INACTIVE
  const order = { FLIPPER: 0, SUSPECT_MM: 1, NORMAL: 2, INACTIVE: 3 }
  report.sort((a, b) => {
    const diff = order[a.classification] - order[b.classification]
    if (diff !== 0) return diff
    return (b.nb_total_buys ?? 0) - (a.nb_total_buys ?? 0)
  })

  const flippers = report.filter(r => r.classification === 'FLIPPER')
  const suspects = report.filter(r => r.classification === 'SUSPECT_MM')
  const normals  = report.filter(r => r.classification === 'NORMAL')
  const inactive = report.filter(r => r.classification === 'INACTIVE')

  console.log(
    `[wallet-audit] ${report.length} wallets — FLIPPER: ${flippers.length},` +
    ` SUSPECT_MM: ${suspects.length}, NORMAL: ${normals.length}, INACTIVE: ${inactive.length}`
  )

  return NextResponse.json({
    ok:             true,
    total:          report.length,
    flippers:       flippers.length,
    suspect_mm:     suspects.length,
    normal:         normals.length,
    inactive:       inactive.length,
    sol_price_used: SOL_PRICE_APPROX,
    flipper_threshold_minutes: FLIPPER_MEDIAN_MINUTES,
    note:           'FLIPPER = délai médian <10min. mm_buy_pct = % achats sur tokens avec >5 achats du même wallet.',
    wallets:        report,
  })
}
