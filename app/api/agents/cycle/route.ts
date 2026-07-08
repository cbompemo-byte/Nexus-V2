import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// ── Module-level state ─────────────────────────────────────────────────────────
let priceCache: { data: Record<string, any>; timestamp: number } = { data: {}, timestamp: 0 }
const cycleCountRef = { current: 0 }

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

// ── Binance pair map ───────────────────────────────────────────────────────────
const BINANCE_PAIRS: Record<string, string> = {
  'SOL':  'SOLUSDT',
  'BTC':  'BTCUSDT',
  'ETH':  'ETHUSDT',
  'BNB':  'BNBUSDT',
  'XRP':  'XRPUSDT',
  'AVAX': 'AVAXUSDT',
  'LINK': 'LINKUSDT',
  'JUP':  'JUPUSDT',
  'WIF':  'WIFUSDT',
  'BONK': 'BONKUSDT',
  'JTO':  'JTOUSDT',
  'PYTH': 'PYTHUSDT',
  'RAY':  'RAYUSDT',
}

// ── Hybrid EMA/RSI strategy (Binance klines) ──────────────────────────────────
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
    const pair = BINANCE_PAIRS[sym]
    if (!pair) return { ...NONE, reason: 'unsupported pair' }

    // Fetch 1h candles from Binance (free, no rate limit)
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&limit=52`,
      { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(8000) }
    )

    if (!res.ok) {
      console.log(`[${sym}] Binance error: ${res.status}`)
      return { ...NONE, reason: `Binance ${res.status}` }
    }

    const candles = await res.json()
    if (!Array.isArray(candles) || candles.length < 30) {
      return { ...NONE, reason: 'insufficient candles' }
    }

    const closes = candles.map((c: any) => parseFloat(c[4]))
    const highs  = candles.map((c: any) => parseFloat(c[2]))
    const lows   = candles.map((c: any) => parseFloat(c[3]))
    const vols   = candles.map((c: any) => parseFloat(c[5]))

    // Indicators
    const ema9  = calcEMA(closes, 9)
    const ema21 = calcEMA(closes, 21)
    const ema50 = calcEMA(closes, 50)
    const rsi   = calcRSI(closes.slice(-15))

    const last3    = closes.slice(-3)
    const momentum = (last3[2] - last3[0]) / last3[0] * 100
    const change24h = prices[sym]?.change || 0

    // ATR from real high/low/close
    const trs = candles.slice(1).map((c: any, i: number) => {
      const h  = parseFloat(c[2])
      const l  = parseFloat(c[3])
      const pc = parseFloat(candles[i][4])
      return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
    })
    const atr = trs.slice(-14).reduce((a: number, b: number) => a + b, 0) / 14

    // ADX (inline, uses real highs/lows)
    let plusDM = 0, minusDM = 0, tr = 0
    for (let i = 1; i < Math.min(15, candles.length); i++) {
      const upMove   = highs[i] - highs[i - 1]
      const downMove = lows[i - 1] - lows[i]
      plusDM  += upMove > downMove && upMove > 0 ? upMove : 0
      minusDM += downMove > upMove && downMove > 0 ? downMove : 0
      tr += Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i]  - closes[i - 1])
      )
    }
    const plusDI  = tr > 0 ? (plusDM / tr) * 100 : 0
    const minusDI = tr > 0 ? (minusDM / tr) * 100 : 0
    const adx = (plusDI + minusDI) > 0
      ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100
      : 0

    // Volume ratio (current vs average)
    const avgVol  = vols.slice(0, -1).reduce((a: number, b: number) => a + b, 0) / (vols.length - 1)
    const volRatio = vols[vols.length - 1] / avgVol

    console.log(
      `[${sym}] ema9=${ema9.toFixed(2)} ema21=${ema21.toFixed(2)} ema50=${ema50.toFixed(2)}` +
      ` rsi=${rsi.toFixed(1)} mom=${momentum.toFixed(2)}%` +
      ` adx=${adx.toFixed(1)} vol=${volRatio.toFixed(2)}x`
    )

    const isTrending = adx > 20
    const isRanging  = adx < 18

    console.log(`[${sym}] regime=${isTrending ? 'TREND' : isRanging ? 'RANGE' : 'MIXED'}`)

    // SL/TP distances with ATR floor + minimum 1.2%
    const minSlDist = price * 0.012
    const slDist    = Math.max(atr * 2.0, minSlDist)
    const tpDist    = Math.max(slDist * 2.5, price * 0.03)

    // ── TRENDING → EMA trend following ──────────────────────────────────────
    if (isTrending) {
      const bullTrend = ema9 > ema21 && ema21 > ema50
      const bearTrend = ema9 < ema21 && ema21 < ema50

      if (bullTrend && price > ema9 && rsi > 45 && rsi < 72 && momentum > 0.1 && change24h > -1) {
        const sl   = price - slDist
        const tp   = price + tpDist
        const conf = Math.min(95,
          65 + (adx > 30 ? 20 : 10) +
          (momentum > 0.3 ? 8 : 3) +
          (change24h > 2  ? 7 : 0) +
          (volRatio > 1.2 ? 5 : 0)
        )
        console.log(
          `[${sym}] ATR=${atr.toFixed(2)} SL_dist=${slDist.toFixed(2)}` +
          ` (${(slDist / price * 100).toFixed(2)}%) TP_dist=${tpDist.toFixed(2)}` +
          ` (${(tpDist / price * 100).toFixed(2)}%)`
        )
        return {
          signal: 'BUY', confidence: conf,
          reason: `TREND Bull EMA ADX:${adx.toFixed(0)} RSI:${rsi.toFixed(0)}`,
          entry: price, sl, tp,
          size_pct: conf >= 85 ? 0.10 : 0.07,
        }
      }

      if (bearTrend && price < ema9 && rsi > 28 && rsi < 55 && momentum < -0.1 && change24h < 1) {
        const sl   = price + slDist
        const tp   = price - tpDist
        const conf = Math.min(95,
          65 + (adx > 30 ? 20 : 10) +
          (momentum < -0.3 ? 8 : 3) +
          (change24h < -2  ? 7 : 0) +
          (volRatio > 1.2  ? 5 : 0)
        )
        console.log(
          `[${sym}] ATR=${atr.toFixed(2)} SL_dist=${slDist.toFixed(2)}` +
          ` (${(slDist / price * 100).toFixed(2)}%) TP_dist=${tpDist.toFixed(2)}` +
          ` (${(tpDist / price * 100).toFixed(2)}%)`
        )
        return {
          signal: 'SELL', confidence: conf,
          reason: `TREND Bear EMA ADX:${adx.toFixed(0)} RSI:${rsi.toFixed(0)}`,
          entry: price, sl, tp,
          size_pct: conf >= 85 ? 0.10 : 0.07,
        }
      }
    }

    // ── RANGING → RSI mean reversion ────────────────────────────────────────
    if (isRanging) {
      if (rsi < 32 && momentum > -0.5) {
        const sl   = price - Math.max(price * 0.015, slDist)
        const tp   = price + Math.max(price * 0.035, tpDist)
        const conf = Math.min(90, 60 + (rsi < 25 ? 20 : 10) + (momentum > 0 ? 5 : 0))
        console.log(`[${sym}] RANGE Oversold: sl=${sl.toFixed(2)} tp=${tp.toFixed(2)}`)
        return {
          signal: 'BUY', confidence: conf,
          reason: `RANGE Oversold RSI:${rsi.toFixed(0)} ADX:${adx.toFixed(0)}`,
          entry: price, sl, tp,
          size_pct: 0.06,
        }
      }

      if (rsi > 68 && momentum < 0.5) {
        const sl   = price + Math.max(price * 0.015, slDist)
        const tp   = price - Math.max(price * 0.035, tpDist)
        const conf = Math.min(90, 60 + (rsi > 75 ? 20 : 10) + (momentum < 0 ? 5 : 0))
        console.log(`[${sym}] RANGE Overbought: sl=${sl.toFixed(2)} tp=${tp.toFixed(2)}`)
        return {
          signal: 'SELL', confidence: conf,
          reason: `RANGE Overbought RSI:${rsi.toFixed(0)} ADX:${adx.toFixed(0)}`,
          entry: price, sl, tp,
          size_pct: 0.06,
        }
      }
    }

    // ── MIXED → only very strong setups ─────────────────────────────────────
    const veryBull = ema9 > ema21 && rsi > 50 && momentum > 0.2
    const veryBear = ema9 < ema21 && rsi < 50 && momentum < -0.2

    if (veryBull && change24h > 2) {
      return {
        signal: 'BUY', confidence: 72,
        reason: `MIXED Bull RSI:${rsi.toFixed(0)} mom:${momentum.toFixed(2)}%`,
        entry: price,
        sl: price - Math.max(price * 0.018, slDist),
        tp: price + Math.max(price * 0.045, tpDist),
        size_pct: 0.05,
      }
    }

    if (veryBear && change24h < -2) {
      return {
        signal: 'SELL', confidence: 72,
        reason: `MIXED Bear RSI:${rsi.toFixed(0)} mom:${momentum.toFixed(2)}%`,
        entry: price,
        sl: price + Math.max(price * 0.018, slDist),
        tp: price - Math.max(price * 0.045, tpDist),
        size_pct: 0.05,
      }
    }

    console.log(`[${sym}] NO SIGNAL:`, {
      bullTrend:   ema9 > ema21 && ema21 > ema50,
      bearTrend:   ema9 < ema21 && ema21 < ema50,
      priceVsEMA9: ((price - ema9) / ema9 * 100).toFixed(2) + '%',
      rsi:         rsi.toFixed(1),
      momentum:    momentum.toFixed(3),
      change24h:   change24h.toFixed(2),
      adx:         adx.toFixed(1),
    })
    return {
      ...NONE,
      reason: `No signal: ema9=${ema9.toFixed(1)} rsi=${rsi.toFixed(0)} adx=${adx.toFixed(0)}`,
    }
  } catch (e: any) {
    console.log(`[strategy] ${sym} error: ${e.message}`)
    return { ...NONE, reason: e.message }
  }
}

// ── Price feed (Binance 24hr ticker — free, no rate limit) ────────────────────
const BINANCE_SYMBOLS = Object.values(BINANCE_PAIRS) // all 13 USDT pairs

async function fetchRealPrices(): Promise<Record<string, any>> {
  const now = Date.now()
  if (now - priceCache.timestamp < 60000 && Object.keys(priceCache.data).length > 0) {
    console.log('[prices] Using cache')
    return priceCache.data
  }

  const prices: Record<string, any> = {}

  try {
    const symbolsParam = encodeURIComponent(JSON.stringify(BINANCE_SYMBOLS))
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbols=${symbolsParam}`,
      { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(8000) }
    )

    if (!res.ok) {
      console.log('[prices] Binance ticker error:', res.status)
    } else {
      const tickers = await res.json()
      const reverseMap = Object.fromEntries(
        Object.entries(BINANCE_PAIRS).map(([sym, pair]) => [pair, sym])
      )

      for (const t of tickers) {
        const sym = reverseMap[t.symbol]
        if (!sym) continue
        prices[sym] = {
          price:  parseFloat(t.lastPrice),
          change: parseFloat(t.priceChangePercent),
          volume: parseFloat(t.volume) * parseFloat(t.lastPrice), // volume in USD
        }
        console.log(`[prices] ${sym}: $${prices[sym].price} (${prices[sym].change?.toFixed(1)}%)`)
      }
    }
  } catch (e: any) {
    console.log('[prices] Binance failed:', e.message)
  }

  if (Object.keys(prices).length === 0) {
    console.log('[prices] Binance unavailable — using fallback prices (trades blocked)')
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

    const hardStop    = isLong ? pos.avg * 0.95 : pos.avg * 1.05
    const effectiveSL = isLong ? Math.max(sl, hardStop) : Math.min(sl, hardStop)

    console.log(`[SL check] ${sym}: cur=${cur.toFixed(2)} sl=${effectiveSL.toFixed(2)} tp=${tp.toFixed(2)} hit=${isLong ? cur <= effectiveSL : cur >= effectiveSL}`)

    const slHit = isLong ? cur <= effectiveSL : cur >= effectiveSL
    const tpHit = isLong ? cur >= tp : cur <= tp

    if (slHit || tpHit) {
      cash += pos.qty * cur
      delete updates[sym]

      await supabase.from('kymia_trades').insert({
        user_id:   userId,
        sym,
        side:      pos.side,
        entry:     pos.avg,
        exit:      cur,
        pnl:       parseFloat(pnl.toFixed(2)),
        pct:       parseFloat(pct.toFixed(2)),
        agent:     pos.agent || 'HYBRID',
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

// ── Watchlists ─────────────────────────────────────────────────────────────────
const TIER_A = ['SOL', 'BTC', 'ETH', 'BNB', 'XRP', 'AVAX', 'LINK', 'JUP']
const TIER_B = ['WIF', 'BONK', 'JTO', 'PYTH', 'RAY']

// ── Main cycle ─────────────────────────────────────────────────────────────────
async function runUserCycle(supabase: SupabaseClient, state: any) {
  const userId = state.user_id
  const config = state.swarm_config || { profile: 'balanced', leverage: 1 }

  cycleCountRef.current++
  const cycleNum = cycleCountRef.current

  console.log('[cycle] User state:', {
    running:       state.running,
    openPositions: Object.keys(state.positions || {}).length,
    equity:        state.equity,
    cash:          state.cash,
    profile:       config.profile,
    cycleNum,
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
  const openCount        = Object.keys(currentPositions).length
  const MAX_POSITIONS    = 3

  console.log(`[cycle] Open positions: ${openCount}/${MAX_POSITIONS} — ${JSON.stringify(Object.keys(currentPositions))}`)

  if (openCount >= MAX_POSITIONS) {
    console.log(`[cycle] Max positions reached (${openCount}/${MAX_POSITIONS})`)
    await supabase
      .from('kymia_agent_state')
      .update({ last_cycle: new Date().toISOString(), cycle_count: (state.cycle_count || 0) + 1 })
      .eq('user_id', userId)
    return
  }

  // Pair rotation: 3-4 symbols per cycle
  let pairsToAnalyze: string[]
  if (cycleNum % 5 === 0) {
    pairsToAnalyze = TIER_B
  } else if (cycleNum % 2 === 0) {
    pairsToAnalyze = TIER_A.slice(4, 8)
  } else {
    pairsToAnalyze = TIER_A.slice(0, 4)
  }

  console.log(`[cycle] Analyzing (cycle #${cycleNum}): ${pairsToAnalyze.join(', ')}`)

  let tradedThisCycle        = 0
  const MAX_TRADES_PER_CYCLE = 2
  const signalResults: Record<string, { signal: string; confidence: number }> = {}

  for (const sym of pairsToAnalyze) {
    if (tradedThisCycle >= MAX_TRADES_PER_CYCLE) break

    if (currentPositions[sym]) {
      console.log(`[cycle] ${sym} already open`)
      signalResults[sym] = { signal: 'OPEN', confidence: 0 }
      continue
    }

    if (prices[sym]?.fallback) {
      console.log(`[cycle] ${sym} SKIP — fallback price`)
      signalResults[sym] = { signal: 'SKIP', confidence: 0 }
      continue
    }

    const opp = await findTradingOpportunity(sym, prices)
    signalResults[sym] = { signal: opp.signal, confidence: opp.confidence }

    console.log(`[cycle] ${sym}: ${opp.signal} conf=${opp.confidence} reason="${opp.reason}"`)

    if (opp.signal === 'NONE') continue
    if (opp.confidence < 65) {
      console.log(`[cycle] ${sym} conf too low (${opp.confidence} < 65)`)
      continue
    }

    const currentEquity = freshState?.equity || state.equity || 10000
    const currentCash   = freshState?.cash   || state.cash   || 10000
    const rawSize = currentEquity * opp.size_pct * (config.leverage || 1)
    const size    = Math.min(rawSize, currentEquity * 0.20, currentCash * 0.80)

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
            agent:    'HYBRID',
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

    tradedThisCycle++
  }

  // Cycle summary
  const signals = Object.entries(signalResults)
    .map(([sym, r]) => `${sym}:${r.signal}(${r.confidence}%)`)
    .join(' ')
  console.log(`[cycle] Signals: ${signals || 'none'}`)
  console.log(`[cycle] Trades opened: ${tradedThisCycle}`)

  if (tradedThisCycle === 0 && Object.keys(signalResults).length > 0) {
    const hasSignal = Object.values(signalResults).some(r => r.signal !== 'NONE' && r.signal !== 'OPEN' && r.signal !== 'SKIP')
    if (!hasSignal) {
      console.log('[cycle] No opportunities found — market ranging or conditions not met')
    }
  }

  await supabase
    .from('kymia_agent_state')
    .update({ last_cycle: new Date().toISOString(), cycle_count: (state.cycle_count || 0) + 1 })
    .eq('user_id', userId)
}
