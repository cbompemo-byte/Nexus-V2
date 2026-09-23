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
//   - classification         : NORMAL | SUSPECT_MM | INACTIVE
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

  // ── 2. Tous les achats (pas de filtre wallet_address — on filtre en mémoire) ──
  const { data: buys, error: bErr } = await supabase
    .from('kymia_risque_buys')
    .select('wallet_address, token_mint, sol_amount, usdc_amount, market_cap_at_buy, bought_at')

  if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 })

  // Indexer les achats par wallet
  type BuyRecord = {
    token_mint:        string
    sol_amount:        number | null
    usdc_amount:       number | null
    market_cap_at_buy: number | null
    bought_at:         string
  }
  const buysByWallet = new Map<string, BuyRecord[]>()
  for (const b of (buys ?? []) as (BuyRecord & { wallet_address: string })[]) {
    const arr = buysByWallet.get(b.wallet_address) ?? []
    arr.push(b)
    buysByWallet.set(b.wallet_address, arr)
  }

  const buyUsd = (b: BuyRecord): number =>
    Math.max((b.sol_amount ?? 0) * SOL_PRICE_APPROX, b.usdc_amount ?? 0)

  // ── 3. Classifier chaque wallet ──────────────────────────────────────────
  const report = (wallets ?? []).map(w => {
    const wBuys = buysByWallet.get(w.address as string) ?? []

    if (wBuys.length === 0) {
      return {
        address:          w.address,
        label:            w.label,
        active:           w.active,
        nb_total_buys:    0,
        nb_tokens_bought: 0,
        mm_buy_pct:       null,
        avg_mcap_entry_usd: null,
        avg_buy_usd:      null,
        first_seen:       null,
        last_seen:        null,
        classification:   'INACTIVE' as const,
        note:             'Aucun achat enregistré',
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
    const mmTokens  = [...buyCountByToken.values()].filter(n => n > 5)
    const mmBuys    = mmTokens.reduce((s, n) => s + n, 0)
    const mmBuyPct  = wBuys.length > 0 ? (mmBuys / wBuys.length) * 100 : 0

    // Mcap moyen à l'entrée
    const mcapValues = wBuys.filter(b => b.market_cap_at_buy !== null).map(b => b.market_cap_at_buy!)
    const avgMcap    = mcapValues.length > 0
      ? mcapValues.reduce((s, v) => s + v, 0) / mcapValues.length
      : null

    // Taille moyenne d'achat
    const usdValues  = wBuys.map(buyUsd).filter(v => v > 0)
    const avgBuyUsd  = usdValues.length > 0
      ? usdValues.reduce((s, v) => s + v, 0) / usdValues.length
      : null

    // Plage temporelle
    const dates     = wBuys.map(b => b.bought_at).sort()
    const firstSeen = dates[0]
    const lastSeen  = dates.at(-1)!

    // Classification
    let classification: 'NORMAL' | 'SUSPECT_MM' | 'INACTIVE'
    let note: string

    if (mmBuyPct >= 70) {
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
      address:           w.address,
      label:             w.label,
      active:            w.active,
      nb_total_buys:     wBuys.length,
      nb_tokens_bought:  nbTokens,
      mm_buy_pct:        parseFloat(mmBuyPct.toFixed(1)),
      mm_tokens_count:   mmTokens.length,
      avg_mcap_entry_usd: avgMcap !== null ? Math.round(avgMcap) : null,
      avg_buy_usd:       avgBuyUsd !== null ? parseFloat(avgBuyUsd.toFixed(2)) : null,
      first_seen:        firstSeen,
      last_seen:         lastSeen,
      classification,
      note,
    }
  })

  // Trier : SUSPECT_MM en premier, puis NORMAL, puis INACTIVE
  const order = { SUSPECT_MM: 0, NORMAL: 1, INACTIVE: 2 }
  report.sort((a, b) => {
    const diff = order[a.classification] - order[b.classification]
    if (diff !== 0) return diff
    return (b.nb_total_buys ?? 0) - (a.nb_total_buys ?? 0)
  })

  const suspects = report.filter(r => r.classification === 'SUSPECT_MM')
  const normals  = report.filter(r => r.classification === 'NORMAL')
  const inactive = report.filter(r => r.classification === 'INACTIVE')

  console.log(
    `[wallet-audit] ${report.length} wallets — NORMAL: ${normals.length},` +
    ` SUSPECT_MM: ${suspects.length}, INACTIVE: ${inactive.length}`
  )

  return NextResponse.json({
    ok:              true,
    total:           report.length,
    suspect_mm:      suspects.length,
    normal:          normals.length,
    inactive:        inactive.length,
    sol_price_used:  SOL_PRICE_APPROX,
    note:            'mm_buy_pct = % achats sur tokens avec >5 achats du même wallet. ≥30% = suspect MM.',
    wallets:         report,
  })
}
