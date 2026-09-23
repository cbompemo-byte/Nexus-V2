// app/api/risque/monitor/route.ts
// Surveillance des positions ouvertes — appelé par cron-job.org toutes les 1-2 min.
// Auth : x-cron-secret ou x-admin-key.
//
// Pour chaque position OPEN :
//   1. Prix courant (bonding curve on-chain, gratuit en RPC standard)
//   2. Mise à jour high_since_entry
//   3. Checks de sortie par ordre de priorité :
//      SIGNAL_REVERSE → STOP_LOSS → TRAILING → TIME_STOP
//   4. Si pas de sortie : persist high + trailing_active
//
// Coût API par cycle (3 positions max) :
//   - 3 × getAccountInfo bonding curve : 0 crédit (RPC standard Helius)
//   - 1 × Jupiter price SOL/USD partagé : 0 crédit (API publique)
//   - ~6 × queries Supabase : 0 (quota gratuit)

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse }                     from 'next/server'
import { createClient }                                  from '@supabase/supabase-js'
import { getTokenMarketData, HeliusRateLimitError }      from '@/lib/risque/pumpfun'
import { closePosition, trailingStopPrice, PositionRow } from '@/lib/risque/positions'

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  const adminKey   = process.env.KYMIA_ADMIN_KEY
  const incoming   = req.headers.get('x-cron-secret') ?? req.headers.get('x-admin-key')
  if (cronSecret && incoming === cronSecret) return true
  if (adminKey   && incoming === adminKey)   return true
  return false
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  // ── Charger les positions ouvertes ──────────────────────────────────────
  const { data: positions, error: posErr } = await supabase
    .from('kymia_risque_positions')
    .select(
      'id, token_mint, token_symbol, entry_at, entry_price_usd, size_usd,' +
      'stop_price_usd, high_since_entry, trailing_active, trigger_wallets, is_paper'
    )
    .eq('status', 'OPEN')

  if (posErr) {
    return NextResponse.json({ error: posErr.message }, { status: 500 })
  }

  if (!positions?.length) {
    return NextResponse.json({ ok: true, positions_checked: 0, exits: {} })
  }

  console.log(`[monitor] ${positions.length} position(s) ouverte(s)`)

  const exits = { stop: 0, trailing: 0, signal_reverse: 0, time: 0 }

  for (const pos of positions as unknown as PositionRow[]) {
    const symbol = pos.token_symbol ?? pos.token_mint.slice(0, 8)

    // ── 1. Prix courant ───────────────────────────────────────────────────
    let marketData: Awaited<ReturnType<typeof getTokenMarketData>>
    try {
      marketData = await getTokenMarketData(pos.token_mint)
    } catch (e: unknown) {
      if (e instanceof HeliusRateLimitError) {
        console.warn('[monitor] Helius quota épuisé (429) — cycle abandonné')
        return NextResponse.json({
          ok:                false,
          quota_exhausted:   true,
          positions_checked: 0,
          exits,
          timestamp:         new Date().toISOString(),
        })
      }
      console.warn(`[monitor] ${symbol} — getTokenMarketData erreur inattendue: ${(e as Error).message} — skip`)
      continue
    }
    if (!marketData || marketData.priceUsd === null) {
      console.warn(`[monitor] ${symbol} — prix USD indisponible (${marketData?.source ?? 'null'}) — skip`)
      continue
    }
    const currentPrice = marketData.priceUsd

    // ── 2. Mise à jour du high ────────────────────────────────────────────
    const newHigh = Math.max(pos.high_since_entry ?? pos.entry_price_usd, currentPrice)

    // ── 3. Activation du trailing ─────────────────────────────────────────
    let trailingActive = pos.trailing_active
    const trailingThreshold = pos.entry_price_usd * (1 + 30 / 100)  // +30% hardcodé (voir settings)
    // Note : on ne recharge pas les settings ici pour éviter N queries par position.
    // Si le seuil change en base, prendre effet au prochain cycle.
    if (!trailingActive && currentPrice >= trailingThreshold) {
      trailingActive = true
      const gainPct = ((currentPrice - pos.entry_price_usd) / pos.entry_price_usd * 100).toFixed(1)
      console.log(`[monitor] ${symbol} trailing activé — price=$${currentPrice} (+${gainPct}%)`)
    }

    // ── 4. Checks de sortie (ordre de priorité strict) ────────────────────

    // ── SIGNAL REVERSE : ≥ 50% des wallets déclencheurs ont vendu ─────────
    if (pos.trigger_wallets.length > 0) {
      const { data: sellerRows } = await supabase
        .from('kymia_risque_sells')
        .select('wallet_label')
        .eq('token_mint', pos.token_mint)
        .gte('sold_at', pos.entry_at)          // uniquement les ventes APRÈS notre entrée
        .in('wallet_label', pos.trigger_wallets)

      const sellersSet   = new Set((sellerRows ?? []).map(r => r.wallet_label as string))
      const sellerCount  = sellersSet.size
      const triggerCount = pos.trigger_wallets.length

      if (sellerCount / triggerCount >= 0.5) {
        const closed = await closePosition(
          supabase, pos, currentPrice, 'CLOSED_SIGNAL_REVERSE',
          `${sellerCount}/${triggerCount} wallets déclencheurs ont vendu`,
        )
        if (closed) exits.signal_reverse++
        continue
      }
    }

    // ── STOP LOSS dur ─────────────────────────────────────────────────────
    if (currentPrice <= pos.stop_price_usd) {
      const lossP = ((currentPrice - pos.entry_price_usd) / pos.entry_price_usd * 100).toFixed(1)
      const closed = await closePosition(
        supabase, pos, currentPrice, 'CLOSED_STOP',
        `prix $${currentPrice} ≤ stop $${pos.stop_price_usd.toFixed(8)} (${lossP}%)`,
      )
      if (closed) exits.stop++
      continue
    }

    // ── TRAILING STOP ─────────────────────────────────────────────────────
    if (trailingActive) {
      const trailStop = trailingStopPrice(newHigh, pos.entry_price_usd)
      if (currentPrice <= trailStop) {
        const gainP = ((newHigh - pos.entry_price_usd) / pos.entry_price_usd * 100).toFixed(1)
        const closed = await closePosition(
          supabase, pos, currentPrice, 'CLOSED_TRAILING',
          `trailing stop $${trailStop.toFixed(8)} (high=$${newHigh}, +${gainP}%)`,
        )
        if (closed) exits.trailing++
        continue
      }
    }

    // ── TIME STOP : 48h si trailing jamais activé ─────────────────────────
    const entryTime  = new Date(pos.entry_at).getTime()
    const elapsed48h = Date.now() - entryTime > 48 * 3600_000
    if (!trailingActive && elapsed48h) {
      const hoursIn = ((Date.now() - entryTime) / 3600_000).toFixed(1)
      const closed  = await closePosition(
        supabase, pos, currentPrice, 'CLOSED_TIME',
        `time stop ${hoursIn}h — trailing jamais activé (token n'a pas atteint +30%)`,
      )
      if (closed) exits.time++
      continue
    }

    // ── Pas de sortie — persister high + état trailing ────────────────────
    const currentPnlPct = ((currentPrice - pos.entry_price_usd) / pos.entry_price_usd * 100).toFixed(1)
    const updates: Record<string, unknown> = {
      high_since_entry: newHigh,
      trailing_active:  trailingActive,
      updated_at:       new Date().toISOString(),
    }

    await supabase
      .from('kymia_risque_positions')
      .update(updates)
      .eq('id', pos.id)
      .eq('status', 'OPEN')   // guard idempotent

    console.log(
      `[monitor] ${symbol} HOLD` +
      ` price=$${currentPrice}` +
      ` pnl=${currentPnlPct}%` +
      ` high=$${newHigh}` +
      (trailingActive ? ` trailing=ON stop=$${trailingStopPrice(newHigh, pos.entry_price_usd).toFixed(8)}` : '')
    )
  }

  const totalExits = exits.stop + exits.trailing + exits.signal_reverse + exits.time
  console.log(
    `[monitor] terminé — ${positions.length} vérifiées, ${totalExits} sortie(s)` +
    ` [stop=${exits.stop} trail=${exits.trailing} signal=${exits.signal_reverse} time=${exits.time}]`
  )

  return NextResponse.json({
    ok:                 true,
    positions_checked:  positions.length,
    exits,
    timestamp:          new Date().toISOString(),
  })
}
