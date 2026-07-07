import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// ── Module-level caches (survive across requests on the same instance) ─────────
let priceCache: { data: Record<string, any>; timestamp: number } = { data: {}, timestamp: 0 }

// Per-symbol chart cache so CoinGecko is hit at most once per 5 min per symbol
const cgCache = new Map<string, { data: number[]; timestamp: number }>()
const CACHE_TTL = 300_000 // 5 minutes

// Tracks which rotation slice to analyze this cycle
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

function getCGId(sym: string): string {
  const ids: Record<string, string> = {
    'SOL':  'solana',
    'BTC':  'bitcoin',
    'ETH':  'ethereum',
    'JUP':  'jupiter-ag',
    'BNB':  'binancecoin',
    'XRP':  'ripple',
    'AVAX': 'avalanche-2',
    'LINK': 'chainlink',
    'WIF':  'dogwifcoin',
    'BONK': 'bonk',
    'JTO':  'jito-governance-token',
    'PYTH': 'pyth-network',
    'RAY':  'raydium',
  }
  return ids[sym] || sym.toLowerCase()
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

// Simplified ADX — measures directional strength over the closes window
function calcADX(closes: number[]): number {
  if (closes.length < 15) return 20

  const highs = closes.map((c, i) => i === 0 ? c : Math.max(c, closes[i - 1]))
  const lows  = closes.map((c, i) => i === 0 ? c : Math.min(c, closes[i - 1]))

  let plusDM = 0, minusDM = 0, tr = 0
  for (let i = 1; i < closes.length; i++) {
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

  if (tr === 0) return 20
  const plusDI  = (plusDM  / tr) * 100
  const minusDI = (minusDM / tr) * 100
  if (plusDI + minusDI === 0) return 20
  return Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100
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
    // ── Chart data: serve from cache when fresh, else fetch ──────────────────
    let closes: number[]
    const cached = cgCache.get(sym)

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`[${sym}] Using cached chart data (age ${Math.round((Date.now() - cached.timestamp) / 1000)}s)`)
      closes = cached.data
    } else {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/${getCGId(sym)}/market_chart` +
        `?vs_currency=usd&days=3&interval=hourly`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
      )
      if (!res.ok) throw new Error(`CG ${res.status}`)

      const data = await res.json()
      closes = data.prices?.slice(-50)?.map((p: any[]) => p[1]) || []
      if (closes.length < 30) throw new Error('Not enough data')

      cgCache.set(sym, { data: closes, timestamp: Date.now() })
      console.log(`[${sym}] Fetched fresh chart data (${closes.length} candles)`)
    }

    // ── Indicators ───────────────────────────────────────────────────────────
    const ema9  = calcEMA(closes, 9)
    const ema21 = calcEMA(closes, 21)
    const ema50 = calcEMA(closes, 50)
    const rsi   = calcRSI(closes.slice(-15))
    const last3 = closes.slice(-3)
    const momentum  = (last3[2] - last3[0]) / last3[0] * 100
    const change24h = prices[sym]?.change || 0
    const atr = closes.slice(1)
      .map((c, i) => Math.abs(c - closes[i]))
      .slice(-14)
      .reduce((a, b) => a + b, 0) / 14

    // Regime detection
    const adx        = calcADX(closes)
    const isTrending = adx > 22
    const isRanging  = adx < 18

    console.log(
      `[strategy] ${sym}:` +
      ` ema9=${ema9.toFixed(2)} ema21=${ema21.toFixed(2)} ema50=${ema50.toFixed(2)}` +
      ` rsi=${rsi.toFixed(1)} mom=${momentum.toFixed(2)}% 24h=${change24h.toFixed(2)}% atr=${atr.toFixed(4)}`
    )
    console.log(`[${sym}] ADX=${adx.toFixed(1)} regime=${isTrending ? 'TREND' : isRanging ? 'RANGE' : 'MIXED'}`)

    // ── TRENDING MARKET → EMA trend following ────────────────────────────────
    if (isTrending) {
      const bullTrend = ema9 > ema21 && ema21 > ema50
      const bearTrend = ema9 < ema21 && ema21 < ema50

      if (bullTrend && price > ema9 && rsi > 45 && rsi < 72 && momentum > 0.1 && change24h > -1) {
        const sl   = Math.max(price - (atr * 2), price * 0.985)
        const tp   = Math.max(price + (atr * 4), price * 1.03)
        const conf = Math.min(95,
          65 + (adx > 30 ? 20 : 10) +
          (momentum > 0.3 ? 8 : 3) +
          (change24h > 2  ? 7 : 0)
        )
        console.log(`[${sym}] ATR=${atr.toFixed(2)} SL_dist=${(price - sl).toFixed(2)} (${((price - sl) / price * 100).toFixed(2)}%) TP_dist=${(tp - price).toFixed(2)} (${((tp - price) / price * 100).toFixed(2)}%)`)
        return {
          signal: 'BUY', confidence: conf,
          reason: `TREND Bull EMA ADX:${adx.toFixed(0)} RSI:${rsi.toFixed(0)}`,
          entry: price, sl, tp,
          size_pct: conf >= 85 ? 0.10 : 0.07,
        }
      }

      if (bearTrend && price < ema9 && rsi > 28 && rsi < 55 && momentum < -0.1 && change24h < 1) {
        const sl   = Math.min(price + (atr * 2), price * 1.015)
        const tp   = Math.min(price - (atr * 4), price * 0.97)
        const conf = Math.min(95,
          65 + (adx > 30 ? 20 : 10) +
          (momentum < -0.3 ? 8 : 3) +
          (change24h < -2  ? 7 : 0)
        )
        console.log(`[${sym}] ATR=${atr.toFixed(2)} SL_dist=${(sl - price).toFixed(2)} (${((sl - price) / price * 100).toFixed(2)}%) TP_dist=${(price - tp).toFixed(2)} (${((price - tp) / price * 100).toFixed(2)}%)`)
        return {
          signal: 'SELL', confidence: conf,
          reason: `TREND Bear EMA ADX:${adx.toFixed(0)} RSI:${rsi.toFixed(0)}`,
          entry: price, sl, tp,
          size_pct: conf >= 85 ? 0.10 : 0.07,
        }
      }
    }

    // ── RANGING MARKET → RSI mean reversion ──────────────────────────────────
    if (isRanging) {
      if (rsi < 32 && momentum > -0.5) {
        const sl   = price * 0.985
        const tp   = price * 1.035
        const conf = Math.min(90, 60 + (rsi < 25 ? 20 : 10) + (momentum > 0 ? 5 : 0))
        console.log(`[${sym}] ATR=${atr.toFixed(2)} SL_dist=${(price - sl).toFixed(2)} (1.50%) TP_dist=${(tp - price).toFixed(2)} (3.50%)`)
        return {
          signal: 'BUY', confidence: conf,
          reason: `RANGE Oversold RSI:${rsi.toFixed(0)} ADX:${adx.toFixed(0)}`,
          entry: price, sl, tp,
          size_pct: 0.06,
        }
      }

      if (rsi > 68 && momentum < 0.5) {
        const sl   = price * 1.015
        const tp   = price * 0.965
        const conf = Math.min(90, 60 + (rsi > 75 ? 20 : 10) + (momentum < 0 ? 5 : 0))
        console.log(`[${sym}] ATR=${atr.toFixed(2)} SL_dist=${(sl - price).toFixed(2)} (1.50%) TP_dist=${(price - tp).toFixed(2)} (3.50%)`)
        return {
          signal: 'SELL', confidence: conf,
          reason: `RANGE Overbought RSI:${rsi.toFixed(0)} ADX:${adx.toFixed(0)}`,
          entry: price, sl, tp,
          size_pct: 0.06,
        }
      }
    }

    // ── MIXED MARKET → only very high confidence ──────────────────────────────
    const veryBull = ema9 > ema21 && rsi > 50 && momentum > 0.2
    const veryBear = ema9 < ema21 && rsi < 50 && momentum < -0.2

    if (veryBull && change24h > 2) {
      return {
        signal: 'BUY', confidence: 72,
        reason: `MIXED Bull RSI:${rsi.toFixed(0)} mom:${momentum.toFixed(2)}%`,
        entry: price, sl: price * 0.982, tp: price * 1.045, size_pct: 0.05,
      }
    }

    if (veryBear && change24h < -2) {
      return {
        signal: 'SELL', confidence: 72,
        reason: `MIXED Bear RSI:${rsi.toFixed(0)} mom:${momentum.toFixed(2)}%`,
        entry: price, sl: price * 1.018, tp: price * 0.955, size_pct: 0.05,
      }
    }

    console.log(`[${sym}] NO SIGNAL:`, {
      bullTrend:  ema9 > ema21 && ema21 > ema50,
      bearTrend:  ema9 < ema21 && ema21 < ema50,
      priceVsEMA9: ((price - ema9) / ema9 * 100).toFixed(2) + '%',
      rsi:        rsi.toFixed(1),
      momentum:   momentum.toFixed(3),
      change24h:  change24h.toFixed(2),
      adx:        adx.toFixed(1),
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

// ── Price feed ─────────────────────────────────────────────────────────────────
const CG_IDS = 'solana,bitcoin,ethereum,binancecoin,ripple,avalanche-2,chainlink,jupiter-ag,dogwifcoin,bonk,jito-governance-token,pyth-network,raydium'
const CG_MAPPING: Record<string, string> = {
  'solana':                'SOL',
  'bitcoin':               'BTC',
  'ethereum':              'ETH',
  'binancecoin':           'BNB',
  'ripple':                'XRP',
  'avalanche-2':           'AVAX',
  'chainlink':             'LINK',
  'jupiter-ag':            'JUP',
  'dogwifcoin':            'WIF',
  'bonk':                  'BONK',
  'jito-governance-token': 'JTO',
  'pyth-network':          'PYTH',
  'raydium':               'RAY',
}

async function fetchRealPrices(): Promise<Record<string, any>> {
  const now = Date.now()
  if (now - priceCache.timestamp < 60000 && Object.keys(priceCache.data).length > 0) {
    console.log('[prices] Using cache')
    return priceCache.data
  }

  const prices: Record<string, any> = {}
  const url  = `https://api.coingecko.com/api/v3/simple/price?ids=${CG_IDS}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`
  const opts = { headers: { Accept: 'application/json', 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(8000) }

  try {
    const res = await fetch(url, opts)

    let priceRes = res
    if (res.status === 429) {
      console.log('[prices] CoinGecko rate limited — waiting 30s')
      await new Promise(r => setTimeout(r, 30000))
      const retry = await fetch(url, opts)
      console.log('[prices] CoinGecko retry status:', retry.status)
      priceRes = retry
    }

    if (priceRes.ok) {
      const data = await priceRes.json()
      for (const [id, sym] of Object.entries(CG_MAPPING)) {
        if (data[id]) {
          prices[sym] = {
            price:  data[id].usd,
            change: data[id].usd_24h_change || 0,
            volume: data[id].usd_24h_vol    || 0,
          }
          console.log(`[prices] ${sym}: $${prices[sym].price} (${prices[sym].change?.toFixed(1)}%)`)
        }
      }
    } else {
      console.log('[prices] CoinGecko error:', priceRes.status)
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

  // Increment rotation counter
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

  // Pair rotation: 3-4 symbols per cycle to stay well under CoinGecko rate limits
  // Cycle N%5===0 → Tier B  |  N%2===0 → Tier A[4-7]  |  else → Tier A[0-3]
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

    // 500ms between calls to avoid burst rate-limiting
    await new Promise(r => setTimeout(r, 500))

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
      console.log('[cycle] No opportunities found — market ranging or APIs limited')
    }
  }

  await supabase
    .from('kymia_agent_state')
    .update({ last_cycle: new Date().toISOString(), cycle_count: (state.cycle_count || 0) + 1 })
    .eq('user_id', userId)
}
