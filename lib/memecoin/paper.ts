// lib/memecoin/paper.ts
// KYMIA Phase 1 — Trades fictifs memecoin (R9 — observation uniquement).
// Aucun swap réel. Taille fictive : 4 USDC (2% de 200 USDC de référence).
//
// SL ladder (R9) :
//   Ouverture   : SL = entry × 0.85  (-15%)
//   Après TP1   : SL → entry         (breakeven)
//   Après TP2   : SL → entry × 1.20  (+20%)
//   Après TP3   : SL → entry × 1.50  (+50%)
//   TP4         : trailing stop 22% sous le high depuis l'entrée

import { SupabaseClient } from '@supabase/supabase-js'

const DEXSCREENER    = 'https://api.dexscreener.com'
const RUGCHECK       = 'https://api.rugcheck.xyz/v1'
const PAPER_SIZE     = 4      // USDC fictifs par trade (2% × 200 ref)
const TRAILING_PCT   = 0.22   // trailing stop TP4

// Facteurs de la ladder (par rapport à entry_price)
const SL_INIT        = 0.85
const TP1            = 1.25
const TP2            = 1.50
const TP3            = 2.00
const SL_AFTER_TP1   = 1.00   // breakeven
const SL_AFTER_TP2   = 1.20
const SL_AFTER_TP3   = 1.50

// ── openPaperTrade ─────────────────────────────────────────────────────────────

export async function openPaperTrade(
  supabase:   SupabaseClient,
  mint:       string,
  symbol:     string,
  entryPrice: number
): Promise<boolean> {
  if (entryPrice <= 0) return false

  const { data: existing } = await supabase
    .from('kymia_memecoin_paper')
    .select('id')
    .eq('mint', mint)
    .is('closed_at', null)
    .maybeSingle()

  if (existing) return false   // already tracking this mint

  const { error } = await supabase.from('kymia_memecoin_paper').insert({
    mint,
    symbol,
    entry_price:      entryPrice,
    size_usdc:        PAPER_SIZE,
    sl_price:         entryPrice * SL_INIT,
    tp1_price:        entryPrice * TP1,
    tp2_price:        entryPrice * TP2,
    tp3_price:        entryPrice * TP3,
    sl_current:       entryPrice * SL_INIT,
    qty_remaining:    1.0,
    trailing_high:    entryPrice,
    pnl_realised:     0,
    tp1_hit:          false,
    tp2_hit:          false,
    tp3_hit:          false,
    status:           'OPEN',
    updated_at:       new Date().toISOString(),
  })

  if (error) {
    console.error(`[paper] openPaperTrade ${symbol}:`, error.message)
    return false
  }

  console.log(
    `[paper] OPENED ${symbol} @ $${entryPrice.toFixed(6)}` +
    ` | SL=$${(entryPrice * SL_INIT).toFixed(6)}` +
    ` | TP1=$${(entryPrice * TP1).toFixed(6)}` +
    ` | TP2=$${(entryPrice * TP2).toFixed(6)}` +
    ` | TP3=$${(entryPrice * TP3).toFixed(6)}`
  )
  return true
}

// ── DexScreener price fetch (single token) ────────────────────────────────────

async function fetchPairData(
  mint: string
): Promise<{ priceUsd: number; liquidityUsd: number } | null> {
  try {
    const res = await fetch(`${DEXSCREENER}/latest/dex/tokens/${mint}`, {
      headers: { 'User-Agent': 'KYMIA/1.0' },
      signal:  AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    const data  = await res.json()
    const pairs = data.pairs || []
    if (!pairs.length) return null
    return {
      priceUsd:     parseFloat(pairs[0].priceUsd || '0') || 0,
      liquidityUsd: pairs[0].liquidity?.usd ?? 0,
    }
  } catch {
    return null
  }
}

// ── updatePaperTrades — appelé à chaque cycle (5 min) ─────────────────────────

export async function updatePaperTrades(supabase: SupabaseClient): Promise<void> {
  const { data: trades, error } = await supabase
    .from('kymia_memecoin_paper')
    .select('*')
    .is('closed_at', null)

  if (error || !trades?.length) return

  for (const trade of trades) {
    try {
      const pairData = await fetchPairData(trade.mint)
      if (!pairData || pairData.priceUsd <= 0) continue

      const cur     = pairData.priceUsd
      const entry   = Number(trade.entry_price)
      const slCur   = Number(trade.sl_current)
      const now     = new Date().toISOString()

      let status:      string        = trade.status
      let slNew:       number        = slCur
      let qty:         number        = Number(trade.qty_remaining)
      let pnl:         number        = Number(trade.pnl_realised)
      let trailHigh:   number        = Math.max(Number(trade.trailing_high ?? entry), cur)
      let closeReason: string | null = null
      let tp1Hit = Boolean(trade.tp1_hit)
      let tp2Hit = Boolean(trade.tp2_hit)
      let tp3Hit = Boolean(trade.tp3_hit)

      // ── RUGGED (price -90% or liquidity collapsed) ────────────────────────
      if (cur < entry * 0.10 || pairData.liquidityUsd < 1_000) {
        status      = 'RUGGED'
        closeReason = `price -${(((entry - cur) / entry) * 100).toFixed(0)}% or liq=$${pairData.liquidityUsd.toFixed(0)}`
        pnl        += (cur - entry) / entry * PAPER_SIZE * qty
      }
      // ── TIME STOP (48h, TP1 not yet hit) ─────────────────────────────────
      else if (!tp1Hit && Date.now() - new Date(trade.opened_at).getTime() > 48 * 3600_000) {
        status      = 'TIME_STOP_48H'
        closeReason = '48h elapsed without TP1'
        pnl        += (cur - entry) / entry * PAPER_SIZE * qty
      }
      // ── SL HIT ───────────────────────────────────────────────────────────
      else if (cur <= slCur) {
        status      = 'SL_HIT'
        closeReason = `price $${cur.toFixed(6)} ≤ SL $${slCur.toFixed(6)}`
        pnl        += (cur - entry) / entry * PAPER_SIZE * qty
      }
      // ── TP ladder — vérifie le prochain TP non encore atteint ────────────
      // Ordre ascendant : TP1 → TP2 → TP3, un seul par cycle
      else if (!tp1Hit && cur >= Number(trade.tp1_price)) {
        // TP1 : vend 25%, SL → breakeven (entry)
        pnl   += (cur - entry) / entry * PAPER_SIZE * 0.25
        qty    = parseFloat((qty - 0.25).toFixed(4))
        slNew  = entry * SL_AFTER_TP1   // ← breakeven, conformément à R9
        status = 'TP1_HIT'
        tp1Hit = true
        console.log(`[paper] ${trade.symbol} TP1 +25% @ $${cur.toFixed(6)} — SL → breakeven $${slNew.toFixed(6)}`)
      }
      else if (tp1Hit && !tp2Hit && cur >= Number(trade.tp2_price)) {
        // TP2 : vend 25%, SL → +20%
        pnl   += (cur - entry) / entry * PAPER_SIZE * 0.25
        qty    = parseFloat((qty - 0.25).toFixed(4))
        slNew  = entry * SL_AFTER_TP2
        status = 'TP2_HIT'
        tp2Hit = true
        console.log(`[paper] ${trade.symbol} TP2 +50% @ $${cur.toFixed(6)} — SL → +20% $${slNew.toFixed(6)}`)
      }
      else if (tp2Hit && !tp3Hit && cur >= Number(trade.tp3_price)) {
        // TP3 : vend 25%, SL → +50%
        pnl   += (cur - entry) / entry * PAPER_SIZE * 0.25
        qty    = parseFloat((qty - 0.25).toFixed(4))
        slNew  = entry * SL_AFTER_TP3
        status = 'TP3_HIT'
        tp3Hit = true
        console.log(`[paper] ${trade.symbol} TP3 +100% @ $${cur.toFixed(6)} — SL → +50% $${slNew.toFixed(6)}`)
      }
      // ── Trailing stop TP4 (après TP3, 25% restant) ───────────────────────
      else if (tp3Hit) {
        const trailSl = trailHigh * (1 - TRAILING_PCT)
        slNew = trailSl   // mis à jour pour l'affichage
        if (cur <= trailSl) {
          status      = 'TP4_TRAIL_HIT'
          closeReason = `trailing SL $${trailSl.toFixed(6)} (high $${trailHigh.toFixed(6)})`
          pnl        += (cur - entry) / entry * PAPER_SIZE * qty
        }
      }

      const isClosed = ['SL_HIT', 'TP4_TRAIL_HIT', 'TIME_STOP_48H', 'RUGGED', 'EXIT_CHECK_FAILED'].includes(status)

      await supabase
        .from('kymia_memecoin_paper')
        .update({
          current_price:    cur,
          high_since_entry: Math.max(Number(trade.high_since_entry ?? entry), cur),
          sl_current:       slNew,
          qty_remaining:    Math.max(0, qty),
          trailing_high:    trailHigh,
          pnl_realised:     parseFloat(pnl.toFixed(6)),
          status,
          tp1_hit:          tp1Hit,
          tp2_hit:          tp2Hit,
          tp3_hit:          tp3Hit,
          close_reason:     isClosed ? closeReason : trade.close_reason,
          closed_at:        isClosed ? now : null,
          updated_at:       now,
        })
        .eq('id', trade.id)

    } catch (e: any) {
      console.error(`[paper] updatePaperTrades ${trade.mint.slice(0, 8)}…:`, e.message)
    }
  }
}

// ── recheckOpenPositions — re-vérifie CHECK 2+3 toutes les heures (R9) ────────

export async function recheckOpenPositions(supabase: SupabaseClient): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString()

  const { data: trades } = await supabase
    .from('kymia_memecoin_paper')
    .select('*')
    .is('closed_at', null)
    .or(`last_recheck_at.is.null,last_recheck_at.lt.${oneHourAgo}`)

  if (!trades?.length) return

  for (const trade of trades) {
    try {
      const now      = new Date().toISOString()
      const pairData = await fetchPairData(trade.mint)

      let recheck2: string = 'skipped'
      let recheck3: string = 'skipped'
      let exitNow = false
      let exitReason = ''

      // CHECK 2 re-verify: liquidity still > $50k
      if (pairData) {
        recheck2 = pairData.liquidityUsd >= 50_000 ? 'passed' : 'failed'
        if (recheck2 === 'failed') {
          exitNow    = true
          exitReason = `CHECK2: liquidity $${pairData.liquidityUsd.toFixed(0)} < $50k`
        }
      }

      // CHECK 3 re-verify: holder distribution (RugCheck)
      if (!exitNow) {
        try {
          const res = await fetch(`${RUGCHECK}/tokens/${trade.mint}/report/summary`, {
            headers: { 'User-Agent': 'KYMIA/1.0' },
            signal:  AbortSignal.timeout(6000),
          })
          if (res.ok) {
            const rug      = await res.json()
            const holders  = (rug.topHolders as any[]) || []
            const nonPool  = holders.filter(h => !h.insider)
            const top10Pct = nonPool.slice(0, 10).reduce((s: number, h: any) => s + Number(h.pct), 0)
            const maxSingle = Math.max(...nonPool.map((h: any) => Number(h.pct)), 0)

            recheck3 = (top10Pct <= 30 && maxSingle <= 10) ? 'passed' : 'failed'
            if (recheck3 === 'failed') {
              exitNow    = true
              exitReason = `CHECK3: top10=${top10Pct.toFixed(1)}% max=${maxSingle.toFixed(1)}%`
            }
          }
        } catch { /* RugCheck down — stays skipped */ }
      }

      if (exitNow) {
        const cur   = pairData?.priceUsd ?? 0
        const entry = Number(trade.entry_price)
        const pnl   = Number(trade.pnl_realised) +
          (cur > 0 ? (cur - entry) / entry * PAPER_SIZE * Number(trade.qty_remaining) : 0)

        await supabase.from('kymia_memecoin_paper').update({
          status:          'EXIT_CHECK_FAILED',
          close_reason:    exitReason,
          closed_at:       now,
          pnl_realised:    parseFloat(pnl.toFixed(6)),
          recheck2_result: recheck2,
          recheck3_result: recheck3,
          last_recheck_at: now,
          updated_at:      now,
        }).eq('id', trade.id)

        console.log(`[paper] EXIT_CHECK_FAILED: ${trade.symbol} — ${exitReason}`)
      } else {
        await supabase.from('kymia_memecoin_paper').update({
          recheck2_result: recheck2,
          recheck3_result: recheck3,
          last_recheck_at: now,
          updated_at:      now,
        }).eq('id', trade.id)
      }
    } catch (e: any) {
      console.error(`[paper] recheckOpenPositions ${trade.mint.slice(0, 8)}…:`, e.message)
    }
  }
}
