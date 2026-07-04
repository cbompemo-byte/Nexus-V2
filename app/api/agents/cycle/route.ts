import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export async function GET() {
  console.log('[cycle] Starting agent cycle...')
  console.log('[cycle] ENV check:', {
    hasSupabaseUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  })

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[cycle] Missing Supabase env vars — aborting')
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 })
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )

    // Test connection before doing any work
    const { error: connError } = await supabase
      .from('kymia_agent_state')
      .select('count')
      .limit(1)

    if (connError) {
      console.error('[cycle] Supabase connection error:', connError.message)
      return NextResponse.json({ error: connError.message }, { status: 500 })
    }

    console.log('[cycle] Supabase connected OK')

    const { data: activeUsers } = await supabase
      .from('kymia_agent_state')
      .select('*')
      .eq('running', true)

    if (!activeUsers?.length) {
      console.log('[cycle] No active users — done')
      return NextResponse.json({ ok: true, active: 0, timestamp: new Date().toISOString() })
    }

    console.log(`[cycle] Running cycle for ${activeUsers.length} active user(s)`)

    const results = await Promise.allSettled(
      activeUsers.map(state => runUserCycle(supabase, state))
    )

    const failed = results.filter(r => r.status === 'rejected').length
    console.log(`[cycle] Done — ${results.length - failed} ok, ${failed} failed`)

    return NextResponse.json({
      ok: true,
      active: activeUsers.length,
      results: results.length,
      failed,
      timestamp: new Date().toISOString(),
    })
  } catch (e: any) {
    console.error('[cycle] Fatal error:', e.message)
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

// ── CoinGecko ID mapping ───────────────────────────────────────────────────────
function getCGId(sym: string): string {
  const map: Record<string, string> = {
    SOL: 'solana',
    BTC: 'bitcoin',
    ETH: 'ethereum',
    JUP: 'jupiter-ag',
  }
  return map[sym] || sym.toLowerCase()
}

// ── Bollinger Bands engine (CoinGecko market chart) ───────────────────────────
async function calcBollinger(sym: string, period = 20): Promise<{
  upper: number; middle: number; lower: number; current: number
  zScore: number; signal: 'BUY' | 'SELL' | 'HOLD'; strength: number
}> {
  const HOLD = { signal: 'HOLD' as const, zScore: 0, strength: 0, current: 0, upper: 0, lower: 0, middle: 0 }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${getCGId(sym)}/market_chart?vs_currency=usd&days=2&interval=hourly`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    )

    if (!res.ok) {
      console.log(`[bollinger] ${sym} CoinGecko error: ${res.status}`)
      return HOLD
    }

    const data = await res.json()

    if (!data.prices || !Array.isArray(data.prices)) {
      console.log(`[bollinger] ${sym} invalid data format`)
      return HOLD
    }

    const closes: number[] = data.prices.slice(-period).map((p: [number, number]) => p[1])

    if (closes.length < period) {
      console.log(`[bollinger] ${sym} not enough candles (${closes.length}/${period})`)
      return HOLD
    }

    const sma = closes.reduce((a, b) => a + b, 0) / closes.length
    const variance = closes.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / closes.length
    const stdDev = Math.sqrt(variance)

    const upper = sma + stdDev * 2
    const lower = sma - stdDev * 2
    const current = closes[closes.length - 1]
    const zScore = stdDev === 0 ? 0 : (current - sma) / stdDev

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
  } catch (e: any) {
    console.log(`[bollinger] ${sym} failed: ${e.message}`)
    return HOLD
  }
}

// ── Volatility / ATR filter (CoinGecko OHLC) ──────────────────────────────────
async function checkVolatility(sym: string): Promise<{ safe: boolean; atr: number }> {
  try {
    // CoinGecko OHLC — returns [timestamp, open, high, low, close]
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${getCGId(sym)}/ohlc?vs_currency=usd&days=1`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    )

    if (!res.ok) {
      console.log(`[volatility] ${sym} CoinGecko error: ${res.status}`)
      return { safe: true, atr: 0 } // default safe so we don't block on API failure
    }

    const data = await res.json()

    if (!Array.isArray(data) || data.length < 2) {
      return { safe: true, atr: 0 }
    }

    const candles = data.slice(-15)
    const trs: number[] = candles.slice(1).map((c: number[], i: number) => {
      const h = c[2], l = c[3], pc = candles[i][4]
      return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
    })

    const atr = trs.reduce((a, b) => a + b, 0) / trs.length
    const lastClose = candles[candles.length - 1][4]
    const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0

    console.log(`[volatility] ${sym} ATR%: ${atrPct.toFixed(2)}%`)
    return { safe: atrPct > 0.3 && atrPct < 4.0, atr }
  } catch (e: any) {
    console.log(`[volatility] ${sym} failed: ${e.message}`)
    return { safe: true, atr: 0 }
  }
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

// ── Price feed (CoinGecko — works on Vercel servers) ──────────────────────────
async function fetchRealPrices(): Promise<Record<string, any>> {
  const prices: Record<string, any> = {}

  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price' +
        '?ids=solana,bitcoin,ethereum,jupiter-ag' +
        '&vs_currencies=usd' +
        '&include_24hr_change=true' +
        '&include_24hr_vol=true',
      {
        headers: { Accept: 'application/json', 'User-Agent': 'KYMIA/1.0' },
        signal: AbortSignal.timeout(8000),
      }
    )

    if (res.ok) {
      const data = await res.json()
      const mapping: Record<string, string> = {
        solana: 'SOL',
        bitcoin: 'BTC',
        ethereum: 'ETH',
        'jupiter-ag': 'JUP',
      }
      for (const [id, sym] of Object.entries(mapping)) {
        if (data[id]) {
          prices[sym] = {
            price: data[id].usd,
            change: data[id].usd_24h_change || 0,
            volume: data[id].usd_24h_vol || 0,
          }
          console.log(`[prices] ${sym}: $${prices[sym].price} (${prices[sym].change?.toFixed(1)}%)`)
        }
      }
    } else {
      console.log('[prices] CoinGecko error:', res.status)
    }
  } catch (e: any) {
    console.log('[prices] CoinGecko failed:', e.message)
  }

  if (Object.keys(prices).length === 0) {
    console.log('[prices] Using fallback prices')
    prices['SOL'] = { price: 155,   change: 0, volume: 1000000 }
    prices['BTC'] = { price: 60000, change: 0, volume: 1000000 }
    prices['ETH'] = { price: 3200,  change: 0, volume: 1000000 }
    prices['JUP'] = { price: 1.1,   change: 0, volume: 100000  }
  }

  return prices
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

  console.log('[cycle] User state:', {
    running: state.running,
    openPositions: Object.keys(state.positions || {}).length,
    equity: state.equity,
    cash: state.cash,
    profile: config.profile,
    leverage: config.leverage,
  })

  const timeCheck = isGoodTradingHour()
  console.log('[cycle] Time check:', timeCheck)

  if (!timeCheck.allowed) {
    console.log(`[cycle] Off-hours (${timeCheck.session}) — skipping cycle`)
    return
  }

  const prices = await fetchRealPrices()
  console.log('[cycle] Prices loaded:', Object.entries(prices).map(([k,v]) => `${k}=$${(v as any).price}`).join(', '))

  await checkPositions(supabase, userId, state, prices)

  const { data: freshState } = await supabase
    .from('kymia_agent_state')
    .select('positions,cash,equity')
    .eq('user_id', userId)
    .single()

  const currentPositions = freshState?.positions || {}
  const openCount = Object.keys(currentPositions).length
  const maxPositions = config.profile === 'aggressive' ? 3 : 2

  console.log(`[cycle] Open positions: ${openCount}/${maxPositions} — ${JSON.stringify(Object.keys(currentPositions))}`)

  if (openCount >= maxPositions) {
    console.log(`[cycle] Max positions reached (${openCount}/${maxPositions}) — skipping entry scan`)
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

  console.log(`[cycle] Kelly inputs — winRate: ${(winRate*100).toFixed(0)}% avgWin: ${(avgWin*100).toFixed(2)}% avgLoss: ${(avgLoss*100).toFixed(2)}% trades: ${trades.length}`)

  const currentEquity = freshState?.equity || state.equity || 10000
  const currentCash = freshState?.cash || state.cash || 10000
  const btcChange = prices['BTC']?.change || 0
  console.log('[cycle] BTC change:', btcChange)

  let tradeOpened = false

  for (const sym of WATCHLIST) {
    if (currentPositions[sym]) {
      console.log(`[cycle] ${sym} — already in position, skipping`)
      continue
    }

    const price = prices[sym]?.price
    if (!price) {
      console.log(`[cycle] ${sym} — no price data, skipping`)
      continue
    }

    try {
      const bb = await calcBollinger(sym)

      console.log(`[cycle] ${sym} Bollinger:`, {
        signal: bb.signal,
        zScore: bb.zScore.toFixed(2),
        strength: bb.strength.toFixed(1),
        current: bb.current.toFixed(2),
        upper: bb.upper.toFixed(2),
        lower: bb.lower.toFixed(2),
      })

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

      if (bb.signal === 'HOLD') {
        console.log(`[cycle] ${sym} HOLD — z-score ${bb.zScore.toFixed(2)} not extreme enough (need ≤-1.8 or ≥+1.8)`)
        continue
      }

      const vol = await checkVolatility(sym)
      console.log(`[cycle] ${sym} volatility:`, { safe: vol.safe, atr: vol.atr.toFixed(4) })

      if (!vol.safe) {
        console.log(`[cycle] ${sym} SKIP — volatility unsafe (ATR out of 0.3–4.0% range)`)
        continue
      }

      if (bb.signal === 'BUY' && btcChange < -2) {
        console.log(`[cycle] ${sym} SKIP — BUY blocked by BTC macro (${btcChange.toFixed(2)}% < -2%)`)
        continue
      }
      if (bb.signal === 'SELL' && btcChange > 2) {
        console.log(`[cycle] ${sym} SKIP — SELL blocked by BTC macro (${btcChange.toFixed(2)}% > +2%)`)
        continue
      }

      const size = kellySize(currentEquity, winRate, avgWin, avgLoss, bb.strength, config.leverage || 1)
      console.log(`[cycle] ${sym} Kelly size: $${size.toFixed(2)} (equity: $${currentEquity}, cash: $${currentCash})`)

      if (size < 10) {
        console.log(`[cycle] ${sym} SKIP — Kelly size $${size.toFixed(2)} too small (< $10)`)
        continue
      }
      if (size > currentCash * 0.95) {
        console.log(`[cycle] ${sym} SKIP — Kelly size $${size.toFixed(2)} exceeds 95% of cash ($${currentCash})`)
        continue
      }

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
        `[cycle] OPENED: ${sym} ${bb.signal} @ $${price.toFixed(2)} | ` +
        `Size: $${size.toFixed(0)} | Z-Score: ${bb.zScore.toFixed(2)} | ` +
        `SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}`
      )

      tradeOpened = true
      break // 1 trade per cycle max
    } catch (e) {
      console.error(`[cycle] Error processing ${sym}:`, e)
    }
  }

  if (!tradeOpened) {
    console.log('[cycle] No trade opened this cycle — all signals HOLD or filtered')
  }

  await supabase
    .from('kymia_agent_state')
    .update({ last_cycle: new Date().toISOString(), cycle_count: (state.cycle_count || 0) + 1 })
    .eq('user_id', userId)
}
