import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { getQuote, toRawAmount } from '@/lib/solana/jupiter'
import { MINTS as SOL_MINTS, getTokenBalance } from '@/lib/solana/wallet'
import { runAllGuards } from '@/lib/solana/risk-guards'
import { runMemeScreening } from '@/lib/memecoin/screen'
import { updatePaperTrades, recheckOpenPositions } from '@/lib/memecoin/paper'

// ── Module-level state ─────────────────────────────────────────────────────────
let priceCache: { data: Record<string, any>; timestamp: number } = { data: {}, timestamp: 0 }
// lastMemeScreenAt supprimé — rate-limit géré via MAX(screened_at) en base
// (survit aux cold starts serverless)

// cycleCountRef removed — cycle counter persisted in kymia_global_state to survive cold starts
// dryRunPositions Map removed — persisted in kymia_dryrun_positions (survit aux cold starts)

// Rounds to N significant digits — preserves precision for low-value tokens like BONK ($0.0000042)
function roundToSignificant(value: number, sigDigits = 6): number {
  if (value === 0) return 0
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  const decimals = Math.max(0, sigDigits - magnitude - 1)
  return parseFloat(value.toFixed(Math.min(decimals, 15)))
}

export async function GET(req: NextRequest) {
  // Auth — accepte le cron natif Vercel OU un secret explicite
  const cronSecret = process.env.CRON_SECRET
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const hasSecret = cronSecret && (
    req.headers.get('x-cron-secret') === cronSecret ||
    req.headers.get('authorization') === `Bearer ${cronSecret}`
  )
  if (!isVercelCron && !hasSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

    let paperResults = 0
    let paperFailed  = 0

    if (!activeUsers?.length) {
      console.log('[cycle] No active users — skipping paper sim')
      // Dry-run et memecoin tournent indépendamment du paper sim
    } else {
      console.log(`[cycle] Running cycle for ${activeUsers.length} active user(s)`)

      const settled = await Promise.allSettled(
        activeUsers.map(state => runUserCycle(supabase, state))
      )

      paperFailed  = settled.filter(r => r.status === 'rejected').length
      paperResults = settled.length
      console.log(`[cycle] Done — ${paperResults - paperFailed} ok, ${paperFailed} failed`)
    }

    // Dry-run Solana — couche séparée, stats séparées (jamais mélangées avec paper sim)
    await runDryRunCycle(supabase).catch(e =>
      console.error('[dryrun] Fatal error:', e.message)
    )

    // Module Memecoin — observation pure, jamais bloquant
    await runMemecoinsModule(supabase).catch(e =>
      console.error('[memecoin] Fatal error:', e.message)
    )

    return NextResponse.json({
      ok: true,
      active: activeUsers?.length ?? 0,
      results: paperResults,
      failed:  paperFailed,
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

function calcATR(closes: number[], period = 14): number {
  if (closes.length < period + 1) return closes[closes.length - 1] * 0.02
  const trs = closes.slice(1).map((c, i) => Math.abs(c - closes[i]))
  return trs.slice(-period).reduce((a: number, b: number) => a + b, 0) / period
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

// Kraken returns legacy pairs with X/Z prefixes (e.g. XXBTZUSD, XETHZUSD).
// Strip the double-prefix pattern so it matches our KRAKEN_MAP keys.
function normalizeKrakenPair(pair: string): string {
  return pair.replace(/^X(XBT|ETH)/, '$1').replace(/Z(USD|EUR)$/, '$1')
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
        const normalizedPair = normalizeKrakenPair(pair)
        const sym = KRAKEN_MAP[normalizedPair] || KRAKEN_MAP[pair]
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
      console.log(`[prices] BTC price: ${prices['BTC']?.price ?? 'MISSING'}, ETH price: ${prices['ETH']?.price ?? 'MISSING'}`)
    }
  } catch (e: any) {
    console.log(`[prices] Kraken error: ${e.message}`)
  }

  // KuCoin for Solana ecosystem tokens
  try {
    const kuRes = await fetch(
      'https://api.kucoin.com/api/v1/prices' +
      '?currencies=SOL,JUP,WIF,BONK,JTO,PYTH,RAY,BNB',
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

// ── 4h candles (EMA200 requires 200+ candles) ─────────────────────────────────
async function getCandles4h(sym: string): Promise<number[] | null> {
  // Kraken: interval=240 (4h), count=220
  if (KRAKEN_PAIRS[sym]) {
    try {
      const res = await fetch(
        `https://api.kraken.com/0/public/OHLC` +
        `?pair=${KRAKEN_PAIRS[sym]}&interval=240&count=220`,
        { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(8000) }
      )
      if (res.ok) {
        const data = await res.json()
        const pairKey = Object.keys(data.result || {}).find(k => k !== 'last')
        if (pairKey) {
          const closes = data.result[pairKey].map((c: any) => parseFloat(c[4]))
          if (closes.length >= 200) {
            console.log(`[dryrun] ${sym} Kraken 4h OK (${closes.length} candles)`)
            return closes
          }
        }
      }
    } catch (e: any) {
      console.log(`[dryrun] ${sym} Kraken 4h error: ${e.message}`)
    }
  }

  // KuCoin: type=4hour
  if (KUCOIN_PAIRS[sym]) {
    try {
      const endTime   = Math.floor(Date.now() / 1000)
      const startTime = endTime - 220 * 4 * 3600
      const res = await fetch(
        `https://api.kucoin.com/api/v1/market/candles` +
        `?symbol=${KUCOIN_PAIRS[sym]}&type=4hour&startAt=${startTime}&endAt=${endTime}`,
        { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(8000) }
      )
      if (res.ok) {
        const data = await res.json()
        const candles = data.data || []
        const closes = candles.reverse().map((c: any) => parseFloat(c[2]))
        if (closes.length >= 200) {
          console.log(`[dryrun] ${sym} KuCoin 4h OK (${closes.length} candles)`)
          return closes
        }
      }
    } catch (e: any) {
      console.log(`[dryrun] ${sym} KuCoin 4h error: ${e.message}`)
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

// ── Dry-run constants (R6 — Whitelist Phase 1) ────────────────────────────────
const WHITELIST_CORE = ['SOL', 'JUP', 'JTO', 'PYTH', 'RAY'] as const
type CoreSymbol = typeof WHITELIST_CORE[number]

// SPL token mints (mainnet) for Jupiter quotes
const WHITELIST_MINTS: Record<CoreSymbol, string> = {
  SOL:  SOL_MINTS.SOL,   // wrapped SOL: So11111111111111111111111111111111111111112
  JUP:  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  JTO:  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  RAY:  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
}

// Capital de référence pour le sizing indicatif en dry-run (R4)
const REFERENCE_CAPITAL_USDC = 200

// Garde-fou global : executeSwap() ne sera JAMAIS appelé tant que cette var est false
const LIVE_TRADING = process.env.LIVE_TRADING === 'true'

// ── logDryRun ─────────────────────────────────────────────────────────────────
async function logDryRun(supabase: SupabaseClient, entry: {
  symbol:         string
  regime:         string | null
  signal:         string | null
  decision:       string
  reason?:        string
  size_calculee?: number | null
  quote_jupiter?: any
  size_basis?:       string
  price_usd?:        number | null
  episode_id?:       string | null
  pnl_pct?:          number | null
  episode_virtual?:  boolean | null
}) {
  const { error } = await supabase.from('kymia_dryrun_decisions').insert({
    timestamp:        new Date().toISOString(),
    symbol:           entry.symbol,
    regime:           entry.regime ?? null,
    signal:           entry.signal ?? null,
    decision:         entry.decision,
    reason:           entry.reason ?? null,
    size_calculee:    entry.size_calculee ?? null,
    quote_jupiter:    entry.quote_jupiter ?? null,
    size_basis:       entry.size_basis ?? null,
    price_usd:        entry.price_usd ?? null,
    episode_id:       entry.episode_id ?? null,
    pnl_pct:          entry.pnl_pct ?? null,
    episode_virtual:  entry.episode_virtual ?? null,
  })
  if (error) console.error('[dryrun] logDryRun insert error:', error.message)
}

// ── runMemecoinsModule ─────────────────────────────────────────────────────────
// Budget temps strict : updatePaperTrades + recheckOpenPositions à chaque cycle
// (5 min). Screening complet limité à 1× par 15 min pour ménager les APIs.
async function runMemecoinsModule(supabase: SupabaseClient) {
  // Position updates + hourly rechecks — chaque cycle (5 min)
  await Promise.allSettled([
    updatePaperTrades(supabase),
    recheckOpenPositions(supabase),
  ])

  // Rate-limit screening via DB — une seule requête, indépendant du cold start
  const { data: lastRow } = await supabase
    .from('kymia_memecoin_screens')
    .select('screened_at')
    .order('screened_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const lastScreenMs   = lastRow ? new Date((lastRow as any).screened_at).getTime() : 0
  const secSinceScreen = Math.floor((Date.now() - lastScreenMs) / 1000)
  const willScreen     = Date.now() - lastScreenMs >= 15 * 60_000

  console.log(
    `[memecoin] module start` +
    ` (screening: ${willScreen ? 'YES' : `NO — ${secSinceScreen}s < 900s depuis dernier screen en base`})`
  )

  if (!willScreen) return

  console.log('[memecoin] calling runMemeScreening...')
  const result = await runMemeScreening(supabase)
  console.log(
    `[memecoin] screening terminé:` +
    ` ${result.screened} screenés, ${result.eligible} éligibles, ${result.opened} ouverts`
  )
}

// ── runDryRunCycle ─────────────────────────────────────────────────────────────
// Tourne en parallèle du paper sim. Stats SÉPARÉES — jamais mélangées.
// LIVE_TRADING=false → getQuote() OK, executeSwap() interdit.
async function runDryRunCycle(supabase: SupabaseClient) {
  console.log('[dryrun] Starting dry-run cycle (R1–R4, R6)')

  // ── Charger les positions ouvertes depuis la DB (cold-start safe) ──────────
  const { data: dbPositions } = await supabase
    .from('kymia_dryrun_positions')
    .select('symbol,entry_price,opened_at,episode_id,virtual')
  const posMap = new Map<string, { entryPrice: number; openedAt: string; episodeId: string; virtual: boolean }>(
    (dbPositions ?? []).map((r: any) => [r.symbol, {
      entryPrice: Number(r.entry_price),
      openedAt:   r.opened_at,
      episodeId:  r.episode_id,
      virtual:    r.virtual,
    }])
  )

  for (const sym of WHITELIST_CORE) {
    try {
      // ── Prix courant (depuis le cache module-level) ────────────────────────
      const price = priceCache.data[sym]?.price as number | undefined
      if (!price) {
        const cacheSize = Object.keys(priceCache.data).length
        const reason = cacheSize === 0
          ? 'price cache empty — Kraken + KuCoin both failed'
          : `${sym} absent from price cache — Kraken failed and KuCoin returned no data for this symbol`
        console.log(`[dryrun] ${sym} ${reason} — skip`)
        await logDryRun(supabase, { symbol: sym, regime: null, signal: null, decision: 'CANDLES_UNAVAILABLE', reason, price_usd: null })
        continue
      }

      // ── R1 — Filtre de régime (EMA50 / EMA200 sur 4h) ────────────────────
      const candles4h = await getCandles4h(sym)
      if (!candles4h || candles4h.length < 200) {
        console.log(`[dryrun] ${sym} bougies 4h indisponibles (${candles4h?.length ?? 0}) — skip safe`)
        await logDryRun(supabase, {
          symbol: sym, regime: null, signal: null,
          decision: 'CANDLES_UNAVAILABLE',
          reason:   `4h candles: ${candles4h?.length ?? 0} < 200`,
          price_usd: price,
        })
        continue
      }

      const ema50_4h  = calcEMA(candles4h, 50)
      const ema200_4h = calcEMA(candles4h, 200)
      const regime: 'BULL' | 'BEAR' = (price > ema200_4h && ema50_4h > ema200_4h) ? 'BULL' : 'BEAR'
      console.log(
        `[dryrun] ${sym} regime=${regime}  price=${price.toFixed(4)}` +
        `  EMA50=${ema50_4h.toFixed(4)}  EMA200=${ema200_4h.toFixed(4)}`
      )

      if (regime === 'BEAR') {
        await logDryRun(supabase, {
          symbol:    sym,
          regime,
          signal:    null,
          decision:  'BEAR_REGIME_SKIP',
          reason:    `price ${price.toFixed(4)} below EMA200 ${ema200_4h.toFixed(4)} or EMA50 < EMA200`,
          price_usd: price,
        })
        continue
      }

      // ── Signal (stratégie EMA/RSI identique au paper sim) ─────────────────
      const opp = await findTradingOpportunity(sym, priceCache.data)

      // ── R2 — Remapping des signaux SHORT ──────────────────────────────────
      if (opp.signal === 'SELL') {
        const pos = posMap.get(sym)
        if (pos) {
          // Position ouverte → fermer l'épisode
          const pnlPct = parseFloat((((price - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2))
          console.log(`[dryrun] ${sym} EPISODE_CLOSED entry=$${pos.entryPrice.toFixed(4)} exit=$${price.toFixed(4)} pnl=${pnlPct}%${pos.virtual ? ' [VIRTUAL]' : ''}`)
          await supabase.from('kymia_dryrun_positions').delete().eq('symbol', sym)
          await logDryRun(supabase, {
            symbol:          sym,
            regime,
            signal:          'SELL',
            decision:        'EPISODE_CLOSED',
            reason:          `entry $${pos.entryPrice.toFixed(4)} → exit $${price.toFixed(4)}`,
            price_usd:       price,
            episode_id:      pos.episodeId,
            pnl_pct:         pnlPct,
            episode_virtual: pos.virtual,
          })
        } else {
          // Pas de position → ignorer (spot only)
          console.log(`[dryrun] ${sym} SHORT_SIGNAL_IGNORED_SPOT`)
          await logDryRun(supabase, {
            symbol: sym, regime, signal: 'SELL',
            decision:  'SHORT_SIGNAL_IGNORED_SPOT',
            reason:    opp.reason,
            price_usd: price,
          })
        }
        continue
      }

      if (opp.signal !== 'BUY') {
        await logDryRun(supabase, {
          symbol: sym, regime, signal: opp.signal,
          decision:  'NO_SIGNAL',
          reason:    opp.reason,
          price_usd: price,
        })
        continue
      }

      // ── Signal BUY — vérifier si déjà en position ─────────────────────────
      const existingPos = posMap.get(sym)
      if (existingPos) {
        await logDryRun(supabase, {
          symbol:     sym,
          regime,
          signal:     'BUY',
          decision:   'ALREADY_IN_POSITION',
          reason:          `episode opened @ $${existingPos.entryPrice.toFixed(4)} on ${existingPos.openedAt}`,
          price_usd:       price,
          episode_id:      existingPos.episodeId,
          episode_virtual: existingPos.virtual,
        })
        continue
      }

      // ── Signal BUY sans position — R3 + R4 ───────────────────────────────

      // R4 — Sizing par volatilité (ATR14 sur bougies 1h)
      const candles1h  = await getCandles(sym)
      const atr14      = candles1h ? calcATR(candles1h, 14) : price * 0.02
      const sizeRaw    = (REFERENCE_CAPITAL_USDC * 0.01) / (atr14 / price)
      const sizeCalculee = parseFloat(
        Math.min(sizeRaw, REFERENCE_CAPITAL_USDC * 0.10).toFixed(2)
      )

      // R3 — Seuil de rentabilité + guards via quote Jupiter
      let quoteJupiter: any = null
      let decision     = 'WOULD_EXECUTE'
      let rejectReason = ''

      const mintOut = WHITELIST_MINTS[sym]
      try {
        const amountRaw = toRawAmount(sizeCalculee, 6)  // USDC = 6 décimales
        const quote = await getQuote(SOL_MINTS.USDC, mintOut, amountRaw, 50)

        quoteJupiter = {
          inAmount:       quote.inAmount,
          outAmount:      quote.outAmount,
          priceImpactPct: quote.priceImpactPct,
        }

        // Coût aller-retour estimé : fee Jupiter ~0.3% × 2 + price impact × 2
        const priceImpact     = Math.abs(parseFloat(quote.priceImpactPct))
        const costEstimatePct = 2 * (0.003 + priceImpact / 100)
        const gainExpectedPct = opp.tp > 0 ? (opp.tp - price) / price : 0

        if (gainExpectedPct < 3 * costEstimatePct) {
          decision     = 'REJECTED_LOW_EDGE'
          rejectReason = (
            `gain ${(gainExpectedPct * 100).toFixed(2)}% < 3×cost ${(costEstimatePct * 100).toFixed(2)}%` +
            ` (impact=${priceImpact.toFixed(3)}%)`
          )
        } else {
          // R3 passé → guards de risque (equity on-chain réelle, pas la référence 200)
          let onchainEquity = 0
          try {
            onchainEquity = await getTokenBalance(SOL_MINTS.USDC)
          } catch {
            // Wallet non configuré / RPC absent → equity=0
            // checkPositionSize refusera → GUARD_REFUSED attendu
          }

          const guard = await runAllGuards(
            supabase,
            sizeCalculee,
            quote.priceImpactPct,
            onchainEquity
          )
          if (!guard.allowed) {
            decision     = 'GUARD_REFUSED'
            rejectReason = guard.reason ?? 'guard failed'
          }
        }

        console.log(
          `[dryrun] ${sym} BUY | regime=${regime} | size=$${sizeCalculee}` +
          ` | ATR=${atr14.toFixed(4)} | impact=${priceImpact.toFixed(3)}%` +
          ` | gain=${(gainExpectedPct * 100).toFixed(2)}% | decision=${decision}`
        )
      } catch (e: any) {
        decision     = 'JUPITER_QUOTE_FAILED'
        rejectReason = e.message
        console.log(`[dryrun] ${sym} Jupiter quote error: ${e.message}`)
      }

      // Ouvrir l'épisode si WOULD_EXECUTE, ou si GUARD_REFUSED pour raison de fonds.
      // Les refus kill-switch ou price-impact n'ouvrent PAS d'épisode.
      const isFundsRefusal = /insuffisant/i.test(rejectReason)
      const isVirtual      = decision === 'GUARD_REFUSED' && isFundsRefusal
      const shouldOpen     = decision === 'WOULD_EXECUTE' || isVirtual

      let episodeId: string | null = null
      if (shouldOpen) {
        episodeId = crypto.randomUUID()
        const openedAt = new Date().toISOString()
        await supabase.from('kymia_dryrun_positions').upsert({
          symbol:      sym,
          entry_price: price,
          opened_at:   openedAt,
          episode_id:  episodeId,
          virtual:     isVirtual,
        })
        console.log(
          `[dryrun] ${sym} EPISODE OPENED @ $${price.toFixed(4)} id=${episodeId}` +
          (isVirtual ? ' [VIRTUAL — fonds insuffisants]' : '')
        )
      }

      await logDryRun(supabase, {
        symbol:          sym,
        regime,
        signal:          'BUY',
        decision,
        reason:          rejectReason || opp.reason,
        size_calculee:   sizeCalculee,
        quote_jupiter:   quoteJupiter,
        size_basis:      'reference_200',
        price_usd:       price,
        episode_id:      episodeId,
        episode_virtual: episodeId ? isVirtual : null,
      })

    } catch (e: any) {
      console.error(`[dryrun] ${sym} erreur inattendue: ${e.message}`)
    }
  }

  console.log('[dryrun] Dry-run cycle terminé')
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
          // Atomic DB claim: SELECT FOR UPDATE marks halfClosed=true, returns pos or null if already claimed
          const { data: claimedPos1, error: claimErr1 } = await supabase
            .rpc('claim_partial_close', { p_user_id: userId, p_sym: sym })
          if (!claimedPos1 || claimErr1) {
            console.log(`[ATOMIC] ${sym} partial close already claimed by concurrent request — skipping`)
            delete updates[sym]  // exclude from final bulk write to avoid overwriting winner's DB state
            continue
          }

          const livePos1 = claimedPos1 as any
          const halfQty    = livePos1.qty / 2
          const partialPnl = isLong
            ? (cur - livePos1.avg) * halfQty
            : (livePos1.avg - cur) * halfQty

          await supabase.from('kymia_trades').insert({
            user_id:   userId,
            sym,
            side:      livePos1.side,
            entry:     livePos1.avg,
            exit:      cur,
            pnl:       parseFloat(partialPnl.toFixed(2)),
            pct:       parseFloat((profitRatio * 100).toFixed(2)),
            agent:     (livePos1.agent || 'HYBRID') + '_PARTIAL',
            opened_at: livePos1.openedAt,
            closed_at: new Date().toISOString(),
          })

          updates[sym] = {
            ...updates[sym],
            qty:        parseFloat((livePos1.qty - halfQty).toFixed(6)),
            halfClosed: true,
          }

          cash += partialPnl
          console.log(
            `[PARTIAL TP] ${sym} closed 50% @ $${cur} for +$${partialPnl.toFixed(2)},` +
            ` remaining qty ${(livePos1.qty - halfQty).toFixed(6)} riding trailing stop`
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
      // Atomic DB claim: SELECT FOR UPDATE removes position, returns pos data or null if already claimed
      const { data: claimedPos2, error: claimErr2 } = await supabase
        .rpc('claim_position_close', { p_user_id: userId, p_sym: sym })
      if (!claimedPos2 || claimErr2) {
        console.log(`[ATOMIC] ${sym} already claimed by concurrent request — skipping`)
        delete updates[sym]  // exclude from final bulk write
        continue
      }

      const livePos2 = claimedPos2 as any
      // Use DB-authoritative qty — correctly reflects any prior partial close written to DB
      const closeQty = livePos2.qty
      const closePnl = isLong ? (cur - livePos2.avg) * closeQty : (livePos2.avg - cur) * closeQty
      const closePct = (closePnl / (livePos2.avg * closeQty)) * 100

      cash += closeQty * cur
      delete updates[sym]  // RPC already removed from DB; exclude from final bulk write too

      await supabase.from('kymia_trades').insert({
        user_id:   userId,
        sym,
        side:      livePos2.side,
        entry:     livePos2.avg,
        exit:      cur,
        pnl:       parseFloat(closePnl.toFixed(2)),
        pct:       parseFloat(closePct.toFixed(2)),
        agent:     livePos2.agent || 'HYBRID',
        opened_at: livePos2.openedAt,
        closed_at: new Date().toISOString(),
      })

      console.log(
        `[KYMIA] CLOSED: ${sym} ${livePos2.side} @ $${cur.toFixed(4)} | ` +
        `PnL: $${closePnl.toFixed(2)} (${closePct.toFixed(2)}%) | ${slHit ? 'SL' : 'TP'}` +
        `${livePos2.halfClosed ? ' (remainder after partial TP)' : ''}`
      )
    }
  }

  // Delta this request contributed to cash (0 if we won no RPC claims this cycle)
  const cashDelta = cash - (state.cash || 10000)

  // Re-fetch authoritative DB state — RPC calls may have already modified positions
  const { data: latestState } = await supabase
    .from('kymia_agent_state')
    .select('positions, cash')
    .eq('user_id', userId)
    .single()

  const latestPositions: any = latestState?.positions || {}
  const latestCash = latestState?.cash ?? (state.cash || 10000)

  // Merge only trailing-stop / halfClosed-qty updates for positions still present in DB.
  // Positions removed by a winning RPC won't appear in latestPositions — don't re-add them.
  const mergedPositions: any = { ...latestPositions }
  for (const [s, upd] of Object.entries(updates) as [string, any][]) {
    if (latestPositions[s]) {
      mergedPositions[s] = { ...latestPositions[s], ...upd }
    }
  }

  // Apply cash delta on top of current DB cash, not stale state.cash
  const finalCash = parseFloat((latestCash + cashDelta).toFixed(2))

  const equity =
    finalCash +
    Object.entries(mergedPositions).reduce((sum: number, [s, p]: any) => {
      const price = prices[s]?.price || p.avg
      return sum + p.qty * price
    }, 0)

  await supabase
    .from('kymia_agent_state')
    .update({ positions: mergedPositions, equity: parseFloat(equity.toFixed(2)), cash: finalCash })
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

  let runningCash = freshState?.cash || state.cash || 10000
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
    const currentCash   = runningCash
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

    runningCash = parseFloat((currentCash - size).toFixed(2))

    console.log(
      `[KYMIA] OPENED: ${sym} ${opp.signal} @ $${opp.entry.toFixed(4)}` +
      ` size=$${size.toFixed(0)} sl=$${opp.sl.toFixed(4)} tp=$${opp.tp.toFixed(4)} conf=${opp.confidence}%` +
      ` runningCash=$${runningCash.toFixed(2)}`
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
