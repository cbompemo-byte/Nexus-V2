import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// ── Module-level state ─────────────────────────────────────────────────────────
let priceCache: { data: Record<string, any>; timestamp: number } = { data: {}, timestamp: 0 }
// cycleCountRef removed — cycle counter persisted in kymia_global_state to survive cold starts

// Rounds to N significant digits — preserves precision for low-value tokens like BONK ($0.0000042)
function roundToSignificant(value: number, sigDigits = 6): number {
  if (value === 0) return 0
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  const decimals = Math.max(0, sigDigits - magnitude - 1)
  return parseFloat(value.toFixed(Math.min(decimals, 15)))
}

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

// ── Exchange pair maps ─────────────────────────────────────────────────────────
const KRAKEN_PAIRS: Record<string, string> = {
  'SOL':  'SOLUSD',
  'BTC':  'XBTUSD',
  'ETH':  'ETHUSD',
  'XRP':  'XRPUSD',
  'LINK': 'LINKUSD',
  'AVAX': 'AVAXUSD',
  'BNB':  'BNBUSD',
}

const KUCOIN_PAIRS: Record<string, string> = {
  'JUP':  'JUP-USDT',
  'WIF':  'WIF-USDT',
  'BONK': 'BONK-USDT',
  'JTO':  'JTO-USDT',
  'PYTH': 'PYTH-USDT',
  'RAY':  'RAY-USDT',
}

// ── Price feed (Kraken + KuCoin) ───────────────────────────────────────────────
async function fetchRealPrices(): Promise<Record<string, any>> {
  const now = Date.now()
  if (now - priceCache.timestamp < 60000 && Object.keys(priceCache.data).length > 0) {
    console.log('[prices] Using cache')
    return priceCache.data
  }

  const prices: Record<string, any> = {}

  // Kraken for major pairs
  try {
    const krakenRes = await fetch(
      'https://api.kraken.com/0/public/Ticker' +
      '?pair=SOLUSD,XBTUSD,ETHUSD,XRPUSD,LINKUSD,AVAXUSD',
      { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(8000) }
    )

    if (krakenRes.ok) {
      const kData = await krakenRes.json()
      const r = kData.result || {}

      const KRAKEN_MAP: Record<string, string> = {
        'SOLUSD':  'SOL',
        'XBTUSD':  'BTC',
        'ETHUSD':  'ETH',
        'XRPUSD':  'XRP',
        'LINKUSD': 'LINK',
        'AVAXUSD': 'AVAX',
      }

      Object.entries(r).forEach(([pair, data]: any) => {
        const sym = KRAKEN_MAP[pair]
        if (sym) {
          prices[sym] = {
            price:    parseFloat(data.c[0]),
            change:   parseFloat(data.P[1]),
            volume:   parseFloat(data.v[1]),
            fallback: false,
          }
        }
      })
      console.log(`[prices] Kraken OK: ${Object.keys(prices).length} pairs`)
    }
  } catch (e: any) {
    console.log(`[prices] Kraken error: ${e.message}`)
  }

  // KuCoin for Solana ecosystem tokens
  try {
    const kuRes = await fetch(
      'https://api.kucoin.com/api/v1/prices' +
      '?currencies=JUP,WIF,BONK,JTO,PYTH,RAY,BNB',
      { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(8000) }
    )

    if (kuRes.ok) {
      const kuData = await kuRes.json()
      const kuPrices = kuData.data || {}

      Object.entries(kuPrices).forEach(([sym, price]: any) => {
        if (!prices[sym]) {
          prices[sym] = {
            price:    parseFloat(price),
            change:   0,
            volume:   0,
            fallback: false,
          }
        }
      })
      console.log(`[prices] KuCoin OK: added ${Object.keys(kuPrices).length} pairs`)
    }
  } catch (e: any) {
    console.log(`[prices] KuCoin error: ${e.message}`)
  }

  console.log(
    `[prices] Total: ${Object.keys(prices).length} pairs` +
    ` | SOL=$${prices['SOL']?.price?.toFixed(2) || '?'}` +
    ` | BTC=$${prices['BTC']?.price?.toFixed(0) || '?'}`
  )

  if (Object.keys(prices).length === 0) {
    console.log('[prices] All exchanges failed — using fallback prices (trades blocked)')
    prices['SOL'] = { price: 80,    change: 0, volume: 0, fallback: true }
    prices['BTC'] = { price: 62000, change: 0, volume: 0, fallback: true }
    prices['ETH'] = { price: 1760,  change: 0, volume: 0, fallback: true }
    prices['JUP'] = { price: 1.1,   change: 0, volume: 0, fallback: true }
  } else {
    priceCache = { data: prices, timestamp: now }
  }

  return prices
}

// ── Candle fetcher (Kraken OHLC → KuCoin fallback) ────────────────────────────
async function getCandles(sym: string): Promise<number[] | null> {
  // Try Kraken first
  if (KRAKEN_PAIRS[sym]) {
    try {
      const res = await fetch(
        `https://api.kraken.com/0/public/OHLC` +
        `?pair=${KRAKEN_PAIRS[sym]}&interval=60&count=52`,
        { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(8000) }
      )
      if (res.ok) {
        const data = await res.json()
        const pairKey = Object.keys(data.result || {}).find(k => k !== 'last')
        if (pairKey) {
          const closes = data.result[pairKey].map((c: any) => parseFloat(c[4]))
          if (closes.length >= 30) {
            console.log(`[${sym}] Kraken OHLC OK (${closes.length} candles)`)
            return closes
          }
        }
      }
    } catch (e: any) {
      console.log(`[${sym}] Kraken OHLC error: ${e.message}`)
    }
  }

  // KuCoin for Solana ecosystem tokens
  if (KUCOIN_PAIRS[sym]) {
    try {
      const endTime   = Math.floor(Date.now() / 1000)
      const startTime = endTime - 52 * 3600
      const res = await fetch(
        `https://api.kucoin.com/api/v1/market/candles` +
        `?symbol=${KUCOIN_PAIRS[sym]}&type=1hour&startAt=${startTime}&endAt=${endTime}`,
        { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(8000) }
      )
      if (res.ok) {
        const data = await res.json()
        const candles = data.data || []
        // KuCoin: [time, open, close, high, low, vol, turnover] — newest first
        const closes = candles.reverse().map((c: any) => parseFloat(c[2]))
        if (closes.length >= 30) {
          console.log(`[${sym}] KuCoin candles OK (${closes.length} candles)`)
          return closes
        }
      }
    } catch (e: any) {
      console.log(`[${sym}] KuCoin error: ${e.message}`)
    }
  }

  return null
}

// ── Hybrid EMA/RSI strategy ────────────────────────────────────────────────────
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
    const closes = await getCandles(sym)
    if (!closes) return { ...NONE, reason: 'no candle data' }

    // Indicators
    const ema9  = calcEMA(closes, 9)
    const ema21 = calcEMA(closes, 21)
    const ema50 = calcEMA(closes, 50)
    const rsi   = calcRSI(closes.slice(-15))
    const last3 = closes.slice(-3)
    const momentum  = (last3[2] - last3[0]) / last3[0] * 100
    const change24h = prices[sym]?.change || 0

    // ATR
    const trs = closes.slice(1).map((c, i) => Math.abs(c - closes[i]))
    const atr  = trs.slice(-14).reduce((a: number, b: number) => a + b, 0) / 14

    // Trend strength (% of candles that closed in the dominant direction)
    let trend = 0
    for (let i = 1; i < closes.length; i++) {
      trend += closes[i] > closes[i - 1] ? 1 : -1
    }
    const adx = Math.abs(trend) / closes.length * 100

    const isTrending = adx > 55
    const isRanging  = adx < 40

    const slDist = Math.max(atr * 2, price * 0.012)
    const tpDist = Math.max(slDist * 2.5, price * 0.03)

    // Absolute minimum distance floors — prevents instant-close on low-ATR / tiny-price tokens
    const MIN_SL_PCT = 0.008  // SL never closer than 0.8% from entry
    const MIN_TP_PCT = 0.020  // TP never closer than 2.0% from entry
    const floorSl = (sl: number, isBuy: boolean) =>
      isBuy ? Math.min(sl, price * (1 - MIN_SL_PCT)) : Math.max(sl, price * (1 + MIN_SL_PCT))
    const floorTp = (tp: number, isBuy: boolean) =>
      isBuy ? Math.max(tp, price * (1 + MIN_TP_PCT)) : Math.min(tp, price * (1 - MIN_TP_PCT))

    console.log(
      `[${sym}] price=${price.toFixed(4)}` +
      ` ema9=${ema9.toFixed(4)} ema21=${ema21.toFixed(4)}` +
      ` rsi=${rsi.toFixed(1)} mom=${momentum.toFixed(2)}%` +
      ` trend=${adx.toFixed(0)}% regime=${isTrending ? 'TREND' : isRanging ? 'RANGE' : 'MIXED'}`
    )

    // ── TRENDING → EMA trend following ────────────────────────────────────
    if (isTrending) {
      const bullTrend = ema9 > ema21 && ema21 > ema50
      const bearTrend = ema9 < ema21 && ema21 < ema50

      if (bullTrend && price > ema9 && rsi > 45 && rsi < 72 && momentum > 0.1 && change24h > -1) {
        const sl   = price - slDist
        const tp   = price + tpDist
        const conf = Math.min(95,
          65 + (adx > 70 ? 20 : 10) +
          (momentum > 0.3 ? 8 : 3) +
          (change24h > 2  ? 7 : 0)
        )
        const fsl = floorSl(sl, true), ftp = floorTp(tp, true)
        console.log(`[${sym}] TREND BUY: sl=${fsl.toFixed(4)} tp=${ftp.toFixed(4)} conf=${conf}`)
        return {
          signal: 'BUY', confidence: conf,
          reason: `TREND Bull EMA trend=${adx.toFixed(0)}% RSI:${rsi.toFixed(0)}`,
          entry: price, sl: fsl, tp: ftp,
          size_pct: conf >= 85 ? 0.10 : 0.07,
        }
      }

      if (bearTrend && price < ema9 && rsi > 28 && rsi < 55 && momentum < -0.1 && change24h < 1) {
        const sl   = price + slDist
        const tp   = price - tpDist
        const conf = Math.min(95,
          65 + (adx > 70 ? 20 : 10) +
          (momentum < -0.3 ? 8 : 3) +
          (change24h < -2  ? 7 : 0)
        )
        const fsl = floorSl(sl, false), ftp = floorTp(tp, false)
        console.log(`[${sym}] TREND SELL: sl=${fsl.toFixed(4)} tp=${ftp.toFixed(4)} conf=${conf}`)
        return {
          signal: 'SELL', confidence: conf,
          reason: `TREND Bear EMA trend=${adx.toFixed(0)}% RSI:${rsi.toFixed(0)}`,
          entry: price, sl: fsl, tp: ftp,
          size_pct: conf >= 85 ? 0.10 : 0.07,
        }
      }
    }

    // ── RANGING → RSI mean reversion ──────────────────────────────────────
    if (isRanging) {
      if (rsi < 32 && momentum > -0.5) {
        const sl   = price - Math.max(price * 0.015, slDist)
        const tp   = price + Math.max(price * 0.035, tpDist)
        const conf = Math.min(90, 60 + (rsi < 25 ? 20 : 10) + (momentum > 0 ? 5 : 0))
        const fsl = floorSl(sl, true), ftp = floorTp(tp, true)
        console.log(`[${sym}] RANGE BUY: rsi=${rsi.toFixed(1)} sl=${fsl.toFixed(4)} tp=${ftp.toFixed(4)} conf=${conf}`)
        return {
          signal: 'BUY', confidence: conf,
          reason: `RANGE Oversold RSI:${rsi.toFixed(0)} trend=${adx.toFixed(0)}%`,
          entry: price, sl: fsl, tp: ftp,
          size_pct: 0.06,
        }
      }

      if (rsi > 68 && momentum < 0.5) {
        const sl   = price + Math.max(price * 0.015, slDist)
        const tp   = price - Math.max(price * 0.035, tpDist)
        const conf = Math.min(90, 60 + (rsi > 75 ? 20 : 10) + (momentum < 0 ? 5 : 0))
        const fsl = floorSl(sl, false), ftp = floorTp(tp, false)
        console.log(`[${sym}] RANGE SELL: rsi=${rsi.toFixed(1)} sl=${fsl.toFixed(4)} tp=${ftp.toFixed(4)} conf=${conf}`)
        return {
          signal: 'SELL', confidence: conf,
          reason: `RANGE Overbought RSI:${rsi.toFixed(0)} trend=${adx.toFixed(0)}%`,
          entry: price, sl: fsl, tp: ftp,
          size_pct: 0.06,
        }
      }
    }

    // ── MIXED → only very strong setups ───────────────────────────────────
    const veryBull = ema9 > ema21 && rsi > 50 && momentum > 0.2
    const veryBear = ema9 < ema21 && rsi < 50 && momentum < -0.2

    if (veryBull && change24h > 2) {
      return {
        signal: 'BUY', confidence: 72,
        reason: `MIXED Bull RSI:${rsi.toFixed(0)} mom:${momentum.toFixed(2)}%`,
        entry: price,
        sl: floorSl(price - Math.max(price * 0.018, slDist), true),
        tp: floorTp(price + Math.max(price * 0.045, tpDist), true),
        size_pct: 0.05,
      }
    }

    if (veryBear && change24h < -2) {
      return {
        signal: 'SELL', confidence: 72,
        reason: `MIXED Bear RSI:${rsi.toFixed(0)} mom:${momentum.toFixed(2)}%`,
        entry: price,
        sl: floorSl(price + Math.max(price * 0.018, slDist), false),
        tp: floorTp(price - Math.max(price * 0.045, tpDist), false),
        size_pct: 0.05,
      }
    }

    console.log(`[${sym}] NO SIGNAL:`, {
      bullTrend:  ema9 > ema21 && ema21 > ema50,
      bearTrend:  ema9 < ema21 && ema21 < ema50,
      rsi:        rsi.toFixed(1),
      momentum:   momentum.toFixed(3),
      change24h:  change24h.toFixed(2),
      trend:      adx.toFixed(1) + '%',
    })
    return {
      ...NONE,
      reason: `No signal: ema9=${ema9.toFixed(1)} rsi=${rsi.toFixed(0)} trend=${adx.toFixed(0)}%`,
    }
  } catch (e: any) {
    console.log(`[strategy] ${sym} error: ${e.message}`)
    return { ...NONE, reason: e.message }
  }
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
  const partiallyClosedThisCycle = new Set<string>()

  for (const [sym, pos] of Object.entries(positions) as [string, any][]) {
    const priceEntry = prices[sym]
    if (!priceEntry || priceEntry.fallback) {
      console.log(`[SL check] ${sym} SKIP — fallback price, not evaluating SL/TP`)
      continue
    }
    const cur = priceEntry.price
    if (!cur) continue

    const isLong = pos.side === 'LONG' || pos.side === 'BUY'

    const sl: number = pos.sl || (isLong ? pos.avg * 0.982 : pos.avg * 1.018)
    const tp: number = pos.tp || (isLong ? pos.avg * 1.055 : pos.avg * 0.95)

    // ── Trailing stop + partial TP ────────────────────────────────────────────
    try {
      const distanceToTp  = Math.abs(tp - pos.avg)
      const currentProfit = isLong ? cur - pos.avg : pos.avg - cur
      const profitRatio   = distanceToTp > 0 ? currentProfit / distanceToTp : 0

      if (profitRatio > 0) {
        // 50% to TP → move SL to break-even
        if (profitRatio >= 0.5 && (pos.trailingSl == null || (isLong ? pos.trailingSl < pos.avg : pos.trailingSl > pos.avg))) {
          updates[sym] = { ...updates[sym], trailingSl: pos.avg }
          console.log(`[TRAIL] ${sym} reached 50% to TP — SL moved to breakeven $${pos.avg}`)
        }

        // 75% to TP → tighten SL to lock in 50% of current profit
        if (profitRatio >= 0.75) {
          const lockedProfit = currentProfit * 0.5
          const newSl = isLong ? pos.avg + lockedProfit : pos.avg - lockedProfit
          // Only move the trailing SL in the profitable direction
          const shouldUpdate = pos.trailingSl == null ||
            (isLong ? newSl > (pos.trailingSl ?? -Infinity) : newSl < (pos.trailingSl ?? Infinity))
          if (shouldUpdate) {
            updates[sym] = { ...updates[sym], trailingSl: roundToSignificant(newSl) }
            console.log(`[TRAIL] ${sym} reached 75% to TP — SL tightened to $${newSl.toFixed(6)}`)
          }
        }

        // 60% to TP → close half the position
        if (profitRatio >= 0.6 && !pos.halfClosed) {
          // Idempotency guard: re-fetch live positions before touching cash or inserting a trade
          const { data: liveState1 } = await supabase
            .from('kymia_agent_state')
            .select('positions')
            .eq('user_id', userId)
            .single()
          if (!liveState1?.positions?.[sym]) {
            console.log(`[DEDUP] ${sym} already closed by concurrent request — skipping cash debit and insert`)
            continue
          }

          const halfQty    = pos.qty / 2
          const partialPnl = isLong
            ? (cur - pos.avg) * halfQty
            : (pos.avg - cur) * halfQty

          await supabase.from('kymia_trades').insert({
            user_id:   userId,
            sym,
            side:      pos.side,
            entry:     pos.avg,
            exit:      cur,
            pnl:       parseFloat(partialPnl.toFixed(2)),
            pct:       parseFloat((profitRatio * 100).toFixed(2)),
            agent:     (pos.agent || 'HYBRID') + '_PARTIAL',
            opened_at: pos.openedAt,
            closed_at: new Date().toISOString(),
          })

          updates[sym] = {
            ...updates[sym],
            qty:        parseFloat((pos.qty - halfQty).toFixed(6)),
            halfClosed: true,
          }

          cash += partialPnl
          console.log(
            `[PARTIAL TP] ${sym} closed 50% @ $${cur} for +$${partialPnl.toFixed(2)},` +
            ` remaining qty ${(pos.qty - halfQty).toFixed(6)} riding trailing stop`
          )
          partiallyClosedThisCycle.add(sym)
        }
      }
    } catch (trailError: any) {
      console.log(`[TRAIL ERROR] ${sym} failed: ${trailError.message}`, trailError.stack)
    }

    // If we just partially closed this symbol this cycle, skip the final close
    // check — the remaining half will be re-evaluated on the next cycle with
    // its updated qty and trailingSl already written to updates.
    if (partiallyClosedThisCycle.has(sym)) continue

    // Use trailing SL if it exists, otherwise fall back to hard SL
    // For LONG: trailing SL must be >= original SL (only tightens, never loosens)
    // For SHORT: trailing SL must be <= original SL
    const currentPos = updates[sym] ?? pos
    const rawSl = currentPos.trailingSl ?? sl

    const hardStop    = isLong ? pos.avg * 0.95 : pos.avg * 1.05
    const effectiveSL = isLong
      ? Math.max(rawSl, hardStop)
      : Math.min(rawSl, hardStop)

    console.log(
      `[SL check] ${sym}: cur=${cur.toFixed(4)} sl=${effectiveSL.toFixed(4)}` +
      ` tp=${tp.toFixed(4)} trail=${currentPos.trailingSl?.toFixed(4) ?? 'none'}` +
      ` halfClosed=${!!currentPos.halfClosed}` +
      ` hit=${isLong ? cur <= effectiveSL : cur >= effectiveSL}`
    )

    const slHit = isLong ? cur <= effectiveSL : cur >= effectiveSL
    const tpHit = isLong ? cur >= tp : cur <= tp

    if (slHit || tpHit) {
      // Idempotency guard: re-fetch live positions before touching cash or inserting a trade
      const { data: liveState2 } = await supabase
        .from('kymia_agent_state')
        .select('positions')
        .eq('user_id', userId)
        .single()
      if (!liveState2?.positions?.[sym]) {
        console.log(`[DEDUP] ${sym} already closed by concurrent request — skipping cash debit and insert`)
        continue
      }

      // Use the (possibly halved) qty from updates
      const closeQty = (updates[sym]?.qty ?? pos.qty)
      const closePnl = isLong ? (cur - pos.avg) * closeQty : (pos.avg - cur) * closeQty
      const closePct = (closePnl / (pos.avg * closeQty)) * 100

      cash += closeQty * cur
      delete updates[sym]

      await supabase.from('kymia_trades').insert({
        user_id:   userId,
        sym,
        side:      pos.side,
        entry:     pos.avg,
        exit:      cur,
        pnl:       parseFloat(closePnl.toFixed(2)),
        pct:       parseFloat(closePct.toFixed(2)),
        agent:     pos.agent || 'HYBRID',
        opened_at: pos.openedAt,
        closed_at: new Date().toISOString(),
      })

      console.log(
        `[KYMIA] CLOSED: ${sym} ${pos.side} @ $${cur.toFixed(4)} | ` +
        `PnL: $${closePnl.toFixed(2)} (${closePct.toFixed(2)}%) | ${slHit ? 'SL' : 'TP'}` +
        `${pos.halfClosed ? ' (remainder after partial TP)' : ''}`
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

  // Time-based rotation — changes every minute, no persistence needed
  const cycleNum = Math.floor(Date.now() / 60000)

  console.log(`[cycle] Time-based cycle number: ${cycleNum}`)

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
            avg:        opp.entry,
            qty:        parseFloat(qty.toFixed(6)),
            side:       opp.signal === 'BUY' ? 'LONG' : 'SHORT',
            size:       parseFloat(size.toFixed(2)),
            sl:         roundToSignificant(opp.sl),
            tp:         roundToSignificant(opp.tp),
            openedAt:   new Date().toISOString(),
            conf:       opp.confidence,
            agent:      'HYBRID',
            reason:     opp.reason,
            trailingSl: null,
            halfClosed: false,
          },
        },
        cash:       parseFloat((currentCash - size).toFixed(2)),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)

    console.log(
      `[KYMIA] OPENED: ${sym} ${opp.signal} @ $${opp.entry.toFixed(4)}` +
      ` size=$${size.toFixed(0)} sl=$${opp.sl.toFixed(4)} tp=$${opp.tp.toFixed(4)} conf=${opp.confidence}%`
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
      console.log('[cycle] No opportunities found — conditions not met')
    }
  }

  await supabase
    .from('kymia_agent_state')
    .update({
      last_cycle:     new Date().toISOString(),
      cycle_count:    (state.cycle_count || 0) + 1,
      last_cycle_log: {
        timestamp:       new Date().toISOString(),
        prices_loaded:   Object.keys(prices).length,
        pairs_analyzed:  pairsToAnalyze || [],
        trade_opened:    tradedThisCycle > 0,
        positions_count: Object.keys(state.positions || {}).length,
      },
    })
    .eq('user_id', userId)
}
