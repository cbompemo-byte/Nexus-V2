import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// ── Module-level price cache (survives across requests on same instance) ───────
let priceCache: { data: Record<string, any>; timestamp: number } = { data: {}, timestamp: 0 }

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

// ── Helpers ────────────────────────────────────────────────────────────────────
function isGoodTradingHour() {
  return { allowed: true, session: 'ALWAYS ON', quality: 80 }
}

function getCGId(sym: string): string {
  const map: Record<string, string> = {
    SOL: 'solana',
    BTC: 'bitcoin',
    ETH: 'ethereum',
    JUP: 'jupiter-ag',
  }
  return map[sym] || sym.toLowerCase()
}

function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0
  const k = 2 / (period + 1)
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k)
  }
  return ema
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff
    else losses += Math.abs(diff)
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

// ── EMA Trend Following strategy ───────────────────────────────────────────────
async function findTradingOpportunity(
  sym: string,
  prices: Record<string, any>
): Promise<{
  signal: 'BUY' | 'SELL' | 'NONE'
  confidence: number
  reason: string
  entry: number
  sl: number
  tp: number
  size_pct: number
}> {
  const NONE = { signal: 'NONE' as const, confidence: 0, reason: '', entry: 0, sl: 0, tp: 0, size_pct: 0 }
  const price = prices[sym]?.price
  if (!price) return { ...NONE, reason: 'no price' }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${getCGId(sym)}/market_chart` +
      `?vs_currency=usd&days=3&interval=hourly`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) throw new Error(`CG ${res.status}`)

    const data = await res.json()
    const closes: number[] = data.prices?.slice(-50)?.map((p: any[]) => p[1]) || []
    if (closes.length < 30) throw new Error('Not enough data')

    const ema9  = calcEMA(closes, 9)
    const ema21 = calcEMA(closes, 21)
    const ema50 = calcEMA(closes, 50)
    const rsi   = calcRSI(closes.slice(-15))
    const last3 = closes.slice(-3)
    const momentum = (last3[2] - last3[0]) / last3[0] * 100
    const change24h = prices[sym]?.change || 0
    const atr = closes.slice(1)
      .map((c, i) => Math.abs(c - closes[i]))
      .slice(-14)
      .reduce((a, b) => a + b, 0) / 14

    console.log(
      `[strategy] ${sym}:` +
      ` ema9=${ema9.toFixed(2)} ema21=${ema21.toFixed(2)} ema50=${ema50.toFixed(2)}` +
      ` rsi=${rsi.toFixed(1)} mom=${momentum.toFixed(2)}% 24h=${change24h.toFixed(2)}% atr=${atr.toFixed(4)}`
    )

    // BULL: all EMAs aligned up + RSI ok + momentum
    const bullTrend     = ema9 > ema21 && ema21 > ema50
    const priceAboveEMA = price > ema9
    const rsiBull       = rsi > 45 && rsi < 72
    const posMom        = momentum > 0.1
    const posDay        = change24h > -1

    if (bullTrend && priceAboveEMA && rsiBull && posMom && posDay) {
      const sl   = price - atr * 2.0
      const tp   = price + atr * 4.0
      const conf = Math.min(95,
        60 +
        (bullTrend     ? 15 : 0) +
        (priceAboveEMA ? 10 : 0) +
        (momentum > 0.3 ? 8 : 3) +
        (change24h > 2  ? 7 : 0)
      )
      return {
        signal: 'BUY', confidence: conf,
        reason: `Bull EMA: ${ema9.toFixed(1)}>${ema21.toFixed(1)}>${ema50.toFixed(1)} RSI:${rsi.toFixed(0)} mom:${momentum.toFixed(2)}%`,
        entry: price, sl, tp,
        size_pct: conf >= 85 ? 0.12 : conf >= 75 ? 0.08 : 0.05,
      }
    }

    // BEAR: all EMAs aligned down + RSI ok + momentum
    const bearTrend      = ema9 < ema21 && ema21 < ema50
    const priceBelowEMA  = price < ema9
    const rsiBear        = rsi > 28 && rsi < 55
    const negMom         = momentum < -0.1
    const negDay         = change24h < 1

    if (bearTrend && priceBelowEMA && rsiBear && negMom && negDay) {
      const sl   = price + atr * 2.0
      const tp   = price - atr * 4.0
      const conf = Math.min(95,
        60 +
        (bearTrend      ? 15 : 0) +
        (priceBelowEMA  ? 10 : 0) +
        (momentum < -0.3 ? 8 : 3) +
        (change24h < -2  ? 7 : 0)
      )
      return {
        signal: 'SELL', confidence: conf,
        reason: `Bear EMA: ${ema9.toFixed(1)}<${ema21.toFixed(1)}<${ema50.toFixed(1)} RSI:${rsi.toFixed(0)} mom:${momentum.toFixed(2)}%`,
        entry: price, sl, tp,
        size_pct: conf >= 85 ? 0.12 : conf >= 75 ? 0.08 : 0.05,
      }
    }

    return {
      ...NONE,
      reason: `No trend: ema9=${ema9.toFixed(1)} ema21=${ema21.toFixed(1)} rsi=${rsi.toFixed(0)}`,
    }
  } catch (e: any) {
    console.log(`[strategy] ${sym} error: ${e.message}`)
    return { ...NONE, reason: e.message }
  }
}

// ── Price feed ─────────────────────────────────────────────────────────────────
async function fetchRealPrices(): Promise<Record<string, any>> {
  const now = Date.now()
  if (now - priceCache.timestamp < 60000 && Object.keys(priceCache.data).length > 0) {
    console.log('[prices] Using cache')
    return priceCache.data
  }

  const prices: Record<string, any> = {}

  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price' +
        '?ids=solana,bitcoin,ethereum,jupiter-ag' +
        '&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true',
      {
        headers: { Accept: 'application/json', 'User-Agent': 'KYMIA/1.0' },
        signal: AbortSignal.timeout(8000),
      }
    )

    if (res.ok) {
      const data = await res.json()
      const mapping: Record<string, string> = {
        solana: 'SOL', bitcoin: 'BTC', ethereum: 'ETH', 'jupiter-ag': 'JUP',
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
    console.log('[prices] CoinGecko unavailable — using fallback prices (trades blocked)')
    prices['SOL'] = { price: 80,    change: 0, volume: 0, fallback: true }
    prices['BTC'] = { price: 62000, change: 0, volume: 0, fallback: true }
    prices['ETH'] = { price: 1760,  change: 0, volume: 0, fallback: true }
    prices['JUP'] = { price: 1.1,   change: 0, volume: 0, fallback: true }
  } else {
    priceCache = { data: prices, timestamp: now }
  }

  return prices
}

// ── SL/TP checker ──────────────────────────────────────────────────────────────
async function checkPositions(
  supabase: SupabaseClient,
  userId: string,
  state: any,
  prices: Record<string, { price: number; change: number; fallback?: boolean }>
) {
  const positions = state.positions || {}
  const updates: any = { ...positions }
  let cash: number = state.cash || 10000

  for (const [sym, pos] of Object.entries(positions) as [string, any][]) {
    const priceEntry = prices[sym]
    if (!priceEntry || priceEntry.fallback) {
      console.log(`[SL check] ${sym} SKIP — fallback price, not evaluating SL/TP`)
      continue
    }
    const cur = priceEntry.price
    if (!cur) continue

    const isLong = pos.side === 'LONG' || pos.side === 'BUY'
    const pnl = isLong ? (cur - pos.avg) * pos.qty : (pos.avg - cur) * pos.qty
    const pct = (pnl / (pos.avg * pos.qty)) * 100

    const sl: number = pos.sl || (isLong ? pos.avg * 0.982 : pos.avg * 1.018)
    const tp: number = pos.tp || (isLong ? pos.avg * 1.055 : pos.avg * 0.95)

    // Hard stop at -5% regardless of stored SL
    const hardStop = isLong ? pos.avg * 0.95 : pos.avg * 1.05
    const effectiveSL = isLong ? Math.max(sl, hardStop) : Math.min(sl, hardStop)

    console.log(`[SL check] ${sym}: cur=${cur.toFixed(2)} sl=${effectiveSL.toFixed(2)} tp=${tp.toFixed(2)} hit=${isLong ? cur <= effectiveSL : cur >= effectiveSL}`)

    const slHit = isLong ? cur <= effectiveSL : cur >= effectiveSL
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
        agent: pos.agent || 'EMA_TREND',
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
  if (!timeCheck.allowed) {
    console.log(`[cycle] Off-hours — skipping`)
    return
  }

  const prices = await fetchRealPrices()
  console.log('[cycle] Prices loaded:', Object.entries(prices).map(([k, v]) => `${k}=$${(v as any).price}`).join(', '))

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
    console.log(`[cycle] Max positions reached — skipping entry scan`)
    await supabase
      .from('kymia_agent_state')
      .update({ last_cycle: new Date().toISOString(), cycle_count: (state.cycle_count || 0) + 1 })
      .eq('user_id', userId)
    return
  }

  const WATCHLIST = ['SOL', 'BTC', 'ETH', 'JUP']
  let tradedThisCycle = false

  for (const sym of WATCHLIST) {
    if (tradedThisCycle) break

    if (currentPositions[sym]) {
      console.log(`[cycle] ${sym} already open`)
      continue
    }

    if (prices[sym]?.fallback) {
      console.log(`[cycle] ${sym} SKIP — fallback price`)
      continue
    }

    const opp = await findTradingOpportunity(sym, prices)

    console.log(`[cycle] ${sym}: ${opp.signal} conf=${opp.confidence} reason="${opp.reason}"`)

    if (opp.signal === 'NONE') continue
    if (opp.confidence < 70) {
      console.log(`[cycle] ${sym} conf too low (${opp.confidence} < 70)`)
      continue
    }

    const currentEquity = freshState?.equity || state.equity || 10000
    const currentCash   = freshState?.cash   || state.cash   || 10000
    const rawSize = currentEquity * opp.size_pct * (config.leverage || 1)
    const size = Math.min(rawSize, currentEquity * 0.20, currentCash * 0.80)

    if (size < 50) {
      console.log(`[cycle] ${sym} size too small: $${size.toFixed(0)}`)
      continue
    }

    const qty = size / opp.entry

    await supabase
      .from('kymia_agent_state')
      .update({
        positions: {
          ...currentPositions,
          [sym]: {
            avg:      opp.entry,
            qty:      parseFloat(qty.toFixed(6)),
            side:     opp.signal === 'BUY' ? 'LONG' : 'SHORT',
            size:     parseFloat(size.toFixed(2)),
            sl:       parseFloat(opp.sl.toFixed(4)),
            tp:       parseFloat(opp.tp.toFixed(4)),
            openedAt: new Date().toISOString(),
            conf:     opp.confidence,
            agent:    'EMA_TREND',
            reason:   opp.reason,
          },
        },
        cash:       parseFloat((currentCash - size).toFixed(2)),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)

    console.log(
      `[KYMIA] OPENED: ${sym} ${opp.signal} @ $${opp.entry.toFixed(2)}` +
      ` size=$${size.toFixed(0)} sl=$${opp.sl.toFixed(2)} tp=$${opp.tp.toFixed(2)} conf=${opp.confidence}%`
    )

    tradedThisCycle = true
  }

  if (!tradedThisCycle) {
    console.log('[cycle] No trade opened this cycle')
  }

  await supabase
    .from('kymia_agent_state')
    .update({ last_cycle: new Date().toISOString(), cycle_count: (state.cycle_count || 0) + 1 })
    .eq('user_id', userId)
}
