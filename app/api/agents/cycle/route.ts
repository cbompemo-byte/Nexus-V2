import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export async function GET() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  try {
    const { data: activeUsers } = await supabase
      .from('kymia_agent_state')
      .select('*')
      .eq('running', true)

    if (!activeUsers?.length) {
      return NextResponse.json({ ok: true, active: 0 })
    }

    const results = await Promise.allSettled(
      activeUsers.map(state => runUserCycle(supabase, state))
    )

    return NextResponse.json({
      ok: true,
      active: activeUsers.length,
      results: results.length,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// ── Time filter ────────────────────────────────────────────────────────────────
function isGoodTradingHour(): { allowed: boolean; session: string; quality: number } {
  const hour = new Date().getUTCHours()
  if (hour >= 7 && hour <= 9)   return { allowed: true,  session: 'EU OPEN',    quality: 95 }
  if (hour >= 13 && hour <= 16) return { allowed: true,  session: 'NY OPEN',    quality: 90 }
  if (hour >= 9 && hour <= 13)  return { allowed: true,  session: 'EU SESSION', quality: 75 }
  if (hour >= 16 && hour <= 20) return { allowed: true,  session: 'NY SESSION', quality: 70 }
  return                                { allowed: false, session: 'OFF-HOURS',  quality: 20 }
}

// ── Bollinger Bands engine ─────────────────────────────────────────────────────
async function calcBollinger(sym: string, period = 20): Promise<{
  upper: number; middle: number; lower: number; current: number
  zScore: number; signal: 'BUY' | 'SELL' | 'HOLD'; strength: number
}> {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1h&limit=${period + 5}`
  )
  const data = await res.json()
  const closes: number[] = data.map((c: any) => parseFloat(c[4]))
  const recent = closes.slice(-period)

  const sma = recent.reduce((a, b) => a + b, 0) / period
  const variance = recent.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period
  const stdDev = Math.sqrt(variance)

  const upper = sma + stdDev * 2
  const lower = sma - stdDev * 2
  const current = closes[closes.length - 1]
  const zScore = (current - sma) / stdDev

  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD'
  let strength = 0

  if (zScore <= -1.8) {
    signal = 'BUY'
    strength = Math.min(100, Math.abs(zScore) * 30)
  } else if (zScore >= 1.8) {
    signal = 'SELL'
    strength = Math.min(100, zScore * 30)
  }

  return { upper, middle: sma, lower, current, zScore, signal, strength }
}

// ── Volatility / ATR filter ────────────────────────────────────────────────────
async function checkVolatility(sym: string): Promise<{ safe: boolean; atr: number }> {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1h&limit=15`
  )
  const data = await res.json()

  const trs: number[] = data.slice(1).map((c: any, i: number) => {
    const h = parseFloat(c[2])
    const l = parseFloat(c[3])
    const pc = parseFloat(data[i][4])
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  })
  const atr = trs.reduce((a, b) => a + b, 0) / 14
  const atrPct = (atr / parseFloat(data[data.length - 1][4])) * 100

  return { safe: atrPct > 0.3 && atrPct < 4.0, atr }
}

// ── Kelly Criterion position sizing ───────────────────────────────────────────
function kellySize(
  equity: number,
  winRate: number,
  avgWinPct: number,
  avgLossPct: number,
  signalStrength: number,
  leverage: number
): number {
  const b = avgWinPct / avgLossPct
  const p = winRate
  const q = 1 - p
  const kelly = Math.max(0, (b * p - q) / b)
  const safeKelly = kelly * 0.25
  const strengthMultiplier = signalStrength / 100
  const raw = equity * safeKelly * strengthMultiplier * leverage
  return Math.min(raw, equity * 0.20)
}

// ── Price feed ────────────────────────────────────────────────────────────────
async function fetchRealPrices(): Promise<Record<string, { price: number; change: number }>> {
  try {
    const [krakenRes, cgRes] = await Promise.all([
      fetch('https://api.kraken.com/0/public/Ticker?pair=SOLUSD,BTCUSD,ETHUSD'),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=jupiter&vs_currencies=usd&include_24hr_change=true'),
    ])
    const kraken = await krakenRes.json()
    const cg = await cgRes.json()
    const result: Record<string, { price: number; change: number }> = {}

    if (kraken.result) {
      const r = kraken.result
      if (r.SOLUSD)   result['SOL'] = { price: parseFloat(r.SOLUSD.c[0]),   change: parseFloat(r.SOLUSD.P[1]) }
      if (r.XXBTZUSD) result['BTC'] = { price: parseFloat(r.XXBTZUSD.c[0]), change: parseFloat(r.XXBTZUSD.P[1]) }
      if (r.XETHZUSD) result['ETH'] = { price: parseFloat(r.XETHZUSD.c[0]), change: parseFloat(r.XETHZUSD.P[1]) }
    }
    if (cg.jupiter) result['JUP'] = { price: cg.jupiter.usd, change: cg.jupiter?.usd_24h_change || 0 }

    return result
  } catch {
    return {}
  }
}

// ── SL/TP checker ─────────────────────────────────────────────────────────────
async function checkPositions(
  supabase: SupabaseClient,
  userId: string,
  state: any,
  prices: Record<string, { price: number; change: number }>
) {
  const positions = state.positions || {}
  const updates: any = { ...positions }
  let cash: number = state.cash || 10000

  for (const [sym, pos] of Object.entries(positions) as [string, any][]) {
    const cur = prices[sym]?.price
    if (!cur) continue

    const isLong = pos.side === 'LONG' || pos.side === 'BUY'
    const pnl = isLong ? (cur - pos.avg) * pos.qty : (pos.avg - cur) * pos.qty
    const pct = (pnl / (pos.avg * pos.qty)) * 100

    const sl: number = pos.sl ?? (isLong ? pos.avg * 0.982 : pos.avg * 1.018)
    const tp: number = pos.tp ?? (isLong ? pos.avg * 1.055 : pos.avg * 0.945)

    const slHit = isLong ? cur <= sl : cur >= sl
    const tpHit = isLong ? cur >= tp : cur <= tp

    if (slHit || tpHit) {
      cash += pos.qty * cur
      delete updates[sym]

      await supabase.from('kymia_trades').insert({
        user_id: userId,
        sym,
        side: pos.side,
        entry: pos.avg,
        exit: cur,
        pnl: parseFloat(pnl.toFixed(2)),
        pct: parseFloat(pct.toFixed(2)),
        agent: 'BOLLINGER',
        opened_at: pos.openedAt,
        closed_at: new Date().toISOString(),
      })

      console.log(
        `[KYMIA] CLOSED: ${sym} ${pos.side} @ $${cur.toFixed(2)} | ` +
        `PnL: $${pnl.toFixed(2)} (${pct.toFixed(2)}%) | ${slHit ? 'SL' : 'TP'}`
      )
    }
  }

  const equity =
    cash +
    Object.entries(updates).reduce((sum: number, [sym, p]: any) => {
      const price = prices[sym]?.price || p.avg
      return sum + p.qty * price
    }, 0)

  await supabase
    .from('kymia_agent_state')
    .update({ positions: updates, equity: parseFloat(equity.toFixed(2)), cash: parseFloat(cash.toFixed(2)) })
    .eq('user_id', userId)
}

// ── Main cycle ─────────────────────────────────────────────────────────────────
async function runUserCycle(supabase: SupabaseClient, state: any) {
  const userId = state.user_id
  const config = state.swarm_config || { profile: 'balanced', leverage: 1 }

  const timeCheck = isGoodTradingHour()
  if (!timeCheck.allowed) {
    console.log(`[KYMIA] Off-hours (${timeCheck.session}) — skipping cycle`)
    return
  }

  const prices = await fetchRealPrices()

  await checkPositions(supabase, userId, state, prices)

  const { data: freshState } = await supabase
    .from('kymia_agent_state')
    .select('positions,cash,equity')
    .eq('user_id', userId)
    .single()

  const currentPositions = freshState?.positions || {}
  const openCount = Object.keys(currentPositions).length
  const maxPositions = config.profile === 'aggressive' ? 3 : 2

  if (openCount >= maxPositions) {
    console.log(`[KYMIA] Max positions reached (${openCount}/${maxPositions})`)
    await supabase
      .from('kymia_agent_state')
      .update({ last_cycle: new Date().toISOString(), cycle_count: (state.cycle_count || 0) + 1 })
      .eq('user_id', userId)
    return
  }

  const WATCHLIST = ['SOL', 'BTC', 'ETH', 'JUP']

  const { data: tradeHistory } = await supabase
    .from('kymia_trades')
    .select('pnl,pct')
    .eq('user_id', userId)
    .limit(30)

  const trades = tradeHistory || []
  const wins = trades.filter((t: any) => t.pnl > 0)
  const losses = trades.filter((t: any) => t.pnl < 0)
  const winRate = trades.length > 5 ? wins.length / trades.length : 0.60
  const avgWin = wins.length > 0
    ? wins.reduce((s: number, t: any) => s + Math.abs(t.pct || 5), 0) / wins.length / 100
    : 0.05
  const avgLoss = losses.length > 0
    ? losses.reduce((s: number, t: any) => s + Math.abs(t.pct || 2), 0) / losses.length / 100
    : 0.02

  const currentEquity = freshState?.equity || state.equity || 10000
  const currentCash = freshState?.cash || state.cash || 10000

  for (const sym of WATCHLIST) {
    if (currentPositions[sym]) continue

    const price = prices[sym]?.price
    if (!price) continue

    try {
      const bb = await calcBollinger(sym)

      await supabase.from('kymia_signals').insert({
        user_id: userId,
        agent_id: 'bollinger',
        sym,
        signal: bb.signal,
        confidence: Math.round(bb.strength),
        reasoning:
          `Z-Score: ${bb.zScore.toFixed(2)} | ` +
          `Price: $${price.toFixed(2)} | ` +
          `BB Lower: $${bb.lower.toFixed(2)} | ` +
          `BB Upper: $${bb.upper.toFixed(2)} | ` +
          `Session: ${timeCheck.session}`,
      })

      if (bb.signal === 'HOLD') continue

      const vol = await checkVolatility(sym)
      if (!vol.safe) {
        console.log(`[${sym}] Volatility unsafe — skip`)
        continue
      }

      const btcChange = prices['BTC']?.change || 0
      if (bb.signal === 'BUY'  && btcChange < -2) continue
      if (bb.signal === 'SELL' && btcChange > 2)  continue

      const size = kellySize(currentEquity, winRate, avgWin, avgLoss, bb.strength, config.leverage || 1)

      if (size < 10 || size > currentCash * 0.95) continue

      const slDistance = vol.atr * 1.5
      const tpDistance = vol.atr * 3.5
      const sl = bb.signal === 'BUY' ? price - slDistance : price + slDistance
      const tp = bb.signal === 'BUY' ? price + tpDistance : price - tpDistance

      const qty = size / price
      const newPositions = {
        ...currentPositions,
        [sym]: {
          avg: price,
          qty: parseFloat(qty.toFixed(6)),
          side: bb.signal === 'BUY' ? 'LONG' : 'SHORT',
          size: parseFloat(size.toFixed(2)),
          sl: parseFloat(sl.toFixed(4)),
          tp: parseFloat(tp.toFixed(4)),
          openedAt: new Date().toISOString(),
          conf: Math.round(bb.strength),
          zScore: parseFloat(bb.zScore.toFixed(3)),
          session: timeCheck.session,
        },
      }

      await supabase
        .from('kymia_agent_state')
        .update({ positions: newPositions, cash: parseFloat((currentCash - size).toFixed(2)) })
        .eq('user_id', userId)

      console.log(
        `[KYMIA] OPENED: ${sym} ${bb.signal} @ $${price.toFixed(2)} | ` +
        `Size: $${size.toFixed(0)} | Z-Score: ${bb.zScore.toFixed(2)} | ` +
        `SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}`
      )

      break // 1 trade per cycle max
    } catch (e) {
      console.error(`[KYMIA] Error processing ${sym}:`, e)
    }
  }

  await supabase
    .from('kymia_agent_state')
    .update({ last_cycle: new Date().toISOString(), cycle_count: (state.cycle_count || 0) + 1 })
    .eq('user_id', userId)
}
