import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { getQuote, toRawAmount } from '@/lib/solana/jupiter'
import { MINTS as SOL_MINTS, getTokenBalance } from '@/lib/solana/wallet'
import { runMemeScreening } from '@/lib/memecoin/screen'
import { updatePaperTrades, recheckOpenPositions } from '@/lib/memecoin/paper'
import { CycleContext, AgentVerdict } from '@/lib/agents/types'
import { computeConfluence, ConfluenceResult } from '@/lib/agents/confluence'
import { regimeAgent }   from '@/lib/agents/regime'
import { signalAgent, computeSignal } from '@/lib/agents/signal'
import { sizingAgent }   from '@/lib/agents/sizing'
import { edgeAgent }     from '@/lib/agents/edge'
import { riskAgent }     from '@/lib/agents/risk'
import { universeAgent }              from '@/lib/agents/universe'
import { computeAllShadowVariants }   from '@/lib/agents/regime-shadow'

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

// calcEMA / calcRSI / calcATR → moved to lib/agents/utils.ts

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
  'BTC':  'BTC-USDT',
  'ETH':  'ETH-USDT',
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

  // KuCoin fallback — dynamically built from union of both pair maps to avoid omissions
  const kuCoinCurrencies = [...new Set([...Object.keys(KRAKEN_PAIRS), ...Object.keys(KUCOIN_PAIRS)])].join(',')
  try {
    const kuRes = await fetch(
      'https://api.kucoin.com/api/v1/prices' +
      `?currencies=${kuCoinCurrencies}`,
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

// ── Hybrid EMA/RSI strategy ───────────────────────────────────────────────────
// Thin async wrapper around computeSignal (lib/agents/signal.ts).
// Kept here so runUserCycle (paper sim) can continue calling it unchanged.
async function findTradingOpportunity(
  sym:    string,
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
    const change24h = prices[sym]?.change || 0
    return computeSignal(closes, price, change24h, sym)
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

// REFERENCE_CAPITAL_USDC → moved to lib/agents/sizing.ts

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
  score_total?:      number | null  // R20 — SQL: ALTER TABLE kymia_dryrun_decisions ADD COLUMN IF NOT EXISTS score_total numeric;
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
    score_total:      entry.score_total ?? null,
  })
  if (error) console.error('[dryrun] logDryRun insert error:', error.message)
}

// ── logVerdicts (R22) ─────────────────────────────────────────────────────────
// Batch-inserts agent verdicts into kymia_agent_verdicts.
// Non-fatal: a write failure NEVER interrupts the cycle or blocks logDryRun.
async function logVerdicts(
  supabase:   SupabaseClient,
  verdicts:   AgentVerdict[],
  cycleTs:    string,
  symbol:     string,
  decision:   string,
  episodeId:  string | null,
  scoreTotal: number | null,
) {
  if (verdicts.length === 0) return
  try {
    const rows = verdicts.map(v => ({
      cycle_ts:    cycleTs,
      symbol,
      agent:       v.agent,
      vote:        v.vote,
      confidence:  v.confidence,
      reason:      v.reason,
      data:        v.data ?? null,
      score_total: scoreTotal,   // R20 — même valeur sur toutes les lignes du cycle
      decision,
      episode_id:  episodeId,
    }))
    const { error } = await supabase.from('kymia_agent_verdicts').insert(rows)
    if (error) console.error('[verdicts] insert error:', error.message)
  } catch (e: any) {
    console.error('[verdicts] logVerdicts failed (non-fatal):', e.message)
  }
}

// ── scoreAndAppend ────────────────────────────────────────────────────────────
// Calcule le score de confluence, PUIS ajoute une ligne 'confluence' dans
// verdicts (agent fictif) afin que logVerdicts persiste le breakdown complet
// dans kymia_agent_verdicts.data — nécessaire pour l'auto-audit R23.
function scoreAndAppend(
  verdicts:  AgentVerdict[],
  solCtx:    AgentVerdict | null,
): ConfluenceResult {
  const result = computeConfluence(verdicts, solCtx)
  verdicts.push({
    agent:      'confluence',
    vote:       'APPROVE',  // vote fictif — 'confluence' n'est pas dans WEIGHTS
    confidence: result.score,
    reason:     `score=${result.score}${result.partial_score ? ' (partial)' : ''}`,
    data: {
      score:         result.score,
      score_type:    result.score_type,
      partial_score: result.partial_score,
      active_weight: result.active_weight,
      breakdown:     result.breakdown,
    },
  })
  return result
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

// ── runUniverseCheckJob (R21) ─────────────────────────────────────────────────
// Tournée quotidienne : met à jour liquidity_usd / volume_24h dans kymia_universe
// et applique les transitions de statut avec hystérésis.
// Appelle fetchRealPrices() implicitement via priceCache (doit tourner après fetchRealPrices).
// Rate-limit via MAX(last_check) en DB — survit aux cold starts.
async function runUniverseCheckJob(supabase: SupabaseClient): Promise<void> {
  // Rate-limit : 1× par 23h
  const { data: lastRow } = await supabase
    .from('kymia_universe')
    .select('last_check')
    .not('last_check', 'is', null)
    .order('last_check', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lastRow?.last_check) {
    const elapsed = Date.now() - new Date((lastRow as any).last_check).getTime()
    if (elapsed < 23 * 3600 * 1000) {
      console.log(`[universe] Job skipped — last check ${Math.round(elapsed / 3600000)}h ago`)
      return
    }
  }

  console.log('[universe] Starting daily universe check')

  const { data: tokens } = await supabase
    .from('kymia_universe')
    .select('symbol, mint, status, price_symbol, liquidity_usd, volume_24h')

  for (const token of tokens ?? []) {
    const sym         = (token as any).symbol as string
    const mint        = (token as any).mint as string
    const curStatus   = (token as any).status as string
    const priceSymbol = ((token as any).price_symbol ?? sym) as string

    let liq = 0
    let vol = 0

    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(10000) }
      )
      if (res.ok) {
        const dexData = await res.json()
        // Aggregate ALL Solana pairs — Jupiter routes across all pools
        const solanaPairs = ((dexData.pairs ?? []) as any[]).filter(p => p.chainId === 'solana')
        liq = solanaPairs.reduce((sum, p) => sum + (Number(p.liquidity?.usd) || 0), 0)
        vol = solanaPairs.reduce((sum, p) => sum + (Number(p.volume?.h24) || 0), 0)
        console.log(`[universe] ${sym} liq=$${Math.round(liq / 1000)}k vol=$${Math.round(vol / 1000)}k (${solanaPairs.length} pairs)`)
      }
    } catch (e: any) {
      console.log(`[universe] ${sym} DexScreener error: ${e.message} — skipping`)
      continue
    }

    // ── Hysteresis transitions ────────────────────────────────────────────────
    // Entry:      liq > $500k AND vol > $250k (AND valid price source)
    // Suspension: liq < $250k OR  vol < $100k
    let newStatus   = curStatus
    let statusReason = `liq $${Math.round(liq / 1000)}k vol $${Math.round(vol / 1000)}k`

    if (curStatus === 'CANDIDATE' && liq > 500_000 && vol > 250_000) {
      // Guard: ACTIVE eligibility requires a valid price source (KRAKEN_PAIRS or KUCOIN_PAIRS)
      const hasPrice = !!(KRAKEN_PAIRS[priceSymbol] || KUCOIN_PAIRS[priceSymbol])
      if (hasPrice) {
        newStatus    = 'ACTIVE'
        statusReason = `promoted: ${statusReason}`
      } else {
        statusReason = `thresholds met but no price source for price_symbol=${priceSymbol} — staying CANDIDATE`
        console.log(`[universe] ${sym} CANDIDATE thresholds met but price_symbol='${priceSymbol}' not in KRAKEN_PAIRS/KUCOIN_PAIRS — NOT promoting`)
      }
    } else if (curStatus === 'ACTIVE' && (liq < 250_000 || vol < 100_000)) {
      newStatus    = 'SUSPENDED'
      statusReason = `suspended: ${statusReason}`

      // Force-close any open episode before suspension (Option A)
      try {
        const { data: openPos } = await supabase
          .from('kymia_dryrun_positions')
          .select('symbol, entry_price, episode_id, virtual')
          .eq('symbol', sym)
          .maybeSingle()

        if (openPos) {
          const closePrice = priceCache.data[priceSymbol]?.price as number | undefined
          const entryPrice = Number((openPos as any).entry_price)
          const episodeId  = (openPos as any).episode_id as string
          const isVirtual  = (openPos as any).virtual as boolean
          const pnlPct     = closePrice
            ? parseFloat((((closePrice - entryPrice) / entryPrice) * 100).toFixed(2))
            : null

          await supabase.from('kymia_dryrun_positions').delete().eq('symbol', sym)
          await logDryRun(supabase, {
            symbol:          sym,
            regime:          null,
            signal:          null,
            decision:        'EPISODE_CLOSED',
            reason:          `forced close — UNIVERSE_SUSPENDED (liq $${Math.round(liq / 1000)}k vol $${Math.round(vol / 1000)}k)${closePrice ? ` @ $${closePrice}` : ''}`,
            price_usd:       closePrice ?? null,
            episode_id:      episodeId,
            pnl_pct:         pnlPct,
            episode_virtual: isVirtual,
          })
          console.log(`[universe] ${sym} open episode ${episodeId} force-closed (pnl=${pnlPct}%)`)
        }
      } catch (e: any) {
        console.error(`[universe] ${sym} forced close error: ${e.message}`)
      }
    }

    // ── Persist updated metrics ───────────────────────────────────────────────
    await supabase.from('kymia_universe').update({
      liquidity_usd: liq,
      volume_24h:    vol,
      last_check:    new Date().toISOString(),
      status:        newStatus,
      status_reason: statusReason,
    }).eq('symbol', sym)

    // Log status change to tape
    if (newStatus !== curStatus) {
      await logDryRun(supabase, {
        symbol:   sym,
        regime:   null,
        signal:   null,
        decision: 'UNIVERSE_CHANGE',
        reason:   `${curStatus} → ${newStatus}: ${statusReason}`,
        price_usd: priceCache.data[priceSymbol]?.price ?? null,
      })
      console.log(`[universe] ${sym} status ${curStatus} → ${newStatus}`)
    }
  }

  console.log('[universe] Daily check complete')
}

// ── runBenchmarkJob (R25) ─────────────────────────────────────────────────────
// Job horaire : met à jour last_price dans kymia_benchmark pour chaque symbole ACTIVE.
// Baseline ancrée au PREMIER price_usd historique en base — jamais écrasée.
// Pour un nouveau symbole sans historique (ex. cbBTC → ACTIVE) : baseline = prix courant.
// Rate-limit via MIN(last_update) : tous les symboles doivent être à jour, pas seulement le dernier.
async function runBenchmarkJob(supabase: SupabaseClient): Promise<void> {
  // Rate-limit : skip si le symbole le plus ancien a été mis à jour il y a < 55 min
  const { data: oldestRow } = await supabase
    .from('kymia_benchmark')
    .select('last_update')
    .order('last_update', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (oldestRow?.last_update) {
    const elapsed = Date.now() - new Date((oldestRow as any).last_update).getTime()
    if (elapsed < 55 * 60 * 1000) {
      console.log(`[benchmark] Job skipped — last update ${Math.round(elapsed / 60000)}min ago`)
      return
    }
  }

  const { data: universeRows } = await supabase
    .from('kymia_universe')
    .select('symbol, price_symbol')
    .eq('status', 'ACTIVE')

  const now = new Date().toISOString()

  for (const row of universeRows ?? []) {
    const sym         = (row as any).symbol as string
    const priceSymbol = ((row as any).price_symbol ?? sym) as string
    const price       = priceCache.data[priceSymbol]?.price as number | undefined

    if (!price) {
      console.log(`[benchmark] ${sym} no price (priceSymbol=${priceSymbol}) — skip`)
      continue
    }

    // Vérifie si une baseline existe déjà
    const { data: existing } = await supabase
      .from('kymia_benchmark')
      .select('symbol')
      .eq('symbol', sym)
      .maybeSingle()

    if (!existing) {
      // Nouveau symbole : ancrer la baseline sur la première ligne historique
      // kymia_dryrun_decisions avec price_usd (même fenêtre que les épisodes futurs).
      // Si aucun historique (cbBTC/WETH venant de passer ACTIVE) : baseline = prix courant.
      const { data: earliest } = await supabase
        .from('kymia_dryrun_decisions')
        .select('price_usd, timestamp')
        .eq('symbol', sym)
        .not('price_usd', 'is', null)
        .order('timestamp', { ascending: true })
        .limit(1)
        .maybeSingle()

      const baselinePrice = earliest ? Number((earliest as any).price_usd) : price
      const baselineAt    = earliest ? (earliest as any).timestamp as string : now

      await supabase.from('kymia_benchmark').insert({
        symbol:         sym,
        baseline_price: baselinePrice,
        baseline_at:    baselineAt,
        last_price:     price,
        last_update:    now,
      })
      console.log(`[benchmark] ${sym} baseline @ $${baselinePrice} (${baselineAt})`)
    } else {
      // Symbole connu : update last_price uniquement — baseline jamais modifiée
      await supabase.from('kymia_benchmark').update({
        last_price:  price,
        last_update: now,
      }).eq('symbol', sym)
    }
  }

  console.log('[benchmark] Job complete')
}

// ── runDryRunCycle ─────────────────────────────────────────────────────────────
// Tourne en parallèle du paper sim. Stats SÉPARÉES — jamais mélangées.
// LIVE_TRADING=false → getQuote() OK, executeSwap() interdit.
// R17-R19 : orchestrateur agent. Chaque symbole → 5 agents → décision.
// Les décisions et reasons loggées en base sont IDENTIQUES à l'ancienne version.
async function runDryRunCycle(supabase: SupabaseClient) {
  console.log('[dryrun] Starting dry-run cycle (R1–R4, R6, R21)')

  // ── Prix courants (nécessaires avant universe job pour forced close) ────────
  await fetchRealPrices()

  // ── Universe job quotidien (R21) ───────────────────────────────────────────
  await runUniverseCheckJob(supabase).catch(e =>
    console.error('[universe] Job error (non-fatal):', e.message)
  )

  // ── Benchmark job horaire (R25) ────────────────────────────────────────────
  await runBenchmarkJob(supabase).catch(e =>
    console.error('[benchmark] Job error (non-fatal):', e.message)
  )

  // ── Charger les positions ouvertes depuis la DB (cold-start safe) ──────────
  const { data: dbPositions } = await supabase
    .from('kymia_dryrun_positions')
    .select('symbol,entry_price,opened_at,episode_id,virtual,sl_price,tp_price,opened_regime,high_since_entry,sl_backfilled')
  const posMap = new Map<string, {
    entryPrice:     number
    openedAt:       string
    episodeId:      string
    virtual:        boolean
    slPrice:        number | null
    tpPrice:        number | null
    openedRegime:   string | null
    highSinceEntry: number | null
    slBackfilled:   boolean
  }>(
    (dbPositions ?? []).map((r: any) => [r.symbol, {
      entryPrice:     Number(r.entry_price),
      openedAt:       r.opened_at,
      episodeId:      r.episode_id,
      virtual:        r.virtual,
      slPrice:        r.sl_price        != null ? Number(r.sl_price)        : null,
      tpPrice:        r.tp_price        != null ? Number(r.tp_price)        : null,
      openedRegime:   r.opened_regime   ?? null,
      highSinceEntry: r.high_since_entry != null ? Number(r.high_since_entry) : null,
      slBackfilled:   r.sl_backfilled   ?? false,
    }])
  )

  // ── Charger l'univers actif depuis kymia_universe (R21) ────────────────────
  // SOL doit passer en premier (solRegimeVerdict cache pour les autres symboles).
  // Fallback sur WHITELIST_CORE si la table est vide (safeguard cold-start).
  const { data: universeRows } = await supabase
    .from('kymia_universe')
    .select('symbol, mint, price_symbol, liquidity_usd')
    .eq('status', 'ACTIVE')

  type UniverseRow = { symbol: string; mint: string; price_symbol: string | null; liquidity_usd: number | null }

  const activeTokens: UniverseRow[] = (
    universeRows?.length
      ? universeRows as UniverseRow[]
      : WHITELIST_CORE.map(s => ({
          symbol:       s,
          mint:         WHITELIST_MINTS[s],
          price_symbol: s,
          liquidity_usd: null,
        }))
  ).sort((a, b) => {
    if (a.symbol === 'SOL') return -1
    if (b.symbol === 'SOL') return 1
    return a.symbol.localeCompare(b.symbol)
  })

  console.log(`[dryrun] Active universe: ${activeTokens.map(t => t.symbol).join(', ')}`)

  // Contexte SOL pour le score de confluence (R20) :
  // le verdict regime de SOL est mis en cache à la première itération (SOL est en tête)
  // et réutilisé pour tous les autres symboles comme "vent porteur" (poids 0.15).
  let solRegimeVerdict: AgentVerdict | null = null

  for (const row of activeTokens) {
    // sym = identifiant Solana (ex. 'cbBTC') ; priceSymbol = clé priceCache/candles (ex. 'BTC')
    const sym         = row.symbol
    const priceSymbol = row.price_symbol ?? sym   // cbBTC→BTC, WETH→ETH, autres inchangés

    try {
      // Timestamp partagé par tous les verdicts de ce symbole (R22)
      const cycleTs  = new Date().toISOString()
      const verdicts: AgentVerdict[] = []

      // ── Agent 0 : Universe (R21 — véto dur, tourne en premier) ──────────
      const universeV = universeAgent({ symbol: sym } as CycleContext, row.liquidity_usd)
      verdicts.push(universeV)
      if (universeV.vote === 'REJECT') {
        console.log(`[dryrun] ${sym} UNIVERSE_REJECT — ${universeV.reason}`)
        await logDryRun(supabase, {
          symbol: sym, regime: null, signal: null,
          decision:  'GUARD_REFUSED',
          reason:    universeV.reason,
          price_usd: priceCache.data[priceSymbol]?.price ?? null,
        })
        const { score: scoreUni } = scoreAndAppend(verdicts, sym === 'SOL' ? null : solRegimeVerdict)
        await logVerdicts(supabase, verdicts, cycleTs, sym, 'GUARD_REFUSED', posMap.get(sym)?.episodeId ?? null, scoreUni)
        continue
      }

      // ── Prix courant (priceSymbol = BTC/ETH pour les wrapped tokens) ─────
      const price = priceCache.data[priceSymbol]?.price as number | undefined
      if (!price) {
        const cacheSize = Object.keys(priceCache.data).length
        const reason = cacheSize === 0
          ? 'price cache empty — Kraken + KuCoin both failed'
          : `${priceSymbol} absent from price cache — Kraken failed and KuCoin returned no data for this symbol`
        console.log(`[dryrun] ${sym} (priceSymbol=${priceSymbol}) ${reason} — skip`)
        await logDryRun(supabase, { symbol: sym, regime: null, signal: null, decision: 'CANDLES_UNAVAILABLE', reason, price_usd: null })
        // No agents ran beyond universe — nothing more to insert
        const { score: scoreMissing } = scoreAndAppend(verdicts, sym === 'SOL' ? null : solRegimeVerdict)
        await logVerdicts(supabase, verdicts, cycleTs, sym, 'CANDLES_UNAVAILABLE', posMap.get(sym)?.episodeId ?? null, scoreMissing)
        continue
      }

      // ── Pré-fetch candles via priceSymbol ─────────────────────────────────
      const [candles4h, candles1h] = await Promise.all([
        getCandles4h(priceSymbol),
        getCandles(priceSymbol),
      ])

      // ── Contexte de base ──────────────────────────────────────────────────
      const ctx: CycleContext = {
        symbol:      sym,
        price,
        candles4h,
        candles1h,
        priceData:   priceCache.data,
        mintOut:     row.mint,    // SPL mint pour Jupiter — jamais remplacé par priceSymbol
        priceSymbol,
      }

      // ── Agent 1 : Regime (R1) ─────────────────────────────────────────────
      const regimeV = regimeAgent(ctx)
      verdicts.push(regimeV)
      // Cache pour le sol_context des autres symboles (R20)
      if (sym === 'SOL') solRegimeVerdict = regimeV

      // ── Shadow regime variants (R-shadow) — awaité, non-fatal ───────────
      // Single insert : 5 variantes en 1 aller-retour Supabase par symbole.
      // Zéro appel API supplémentaire — price/candles4h/candles1h déjà en ctx.
      // Inclut les cycles ABSTAIN (candles manquantes → UNKNOWN dans shadow).
      // Await requis en serverless : les promesses non-attendues sont gelées
      // avant complétion sur Vercel → inserts perdus silencieusement.
      try {
        const shadowRows = computeAllShadowVariants({ price, candles4h, candles1h }).map(v => ({
          cycle_ts: cycleTs,
          symbol:   sym,
          variant:  v.variant,
          regime:   v.regime,
          price,
          data:     v.data,
        }))
        const { error: shadowErr } = await supabase.from('kymia_regime_shadow').insert(shadowRows)
        if (shadowErr) console.error(`[regime-shadow] ${sym} insert:`, shadowErr.message)
      } catch (e: any) {
        console.error(`[regime-shadow] ${sym}:`, e.message)
      }

      // ── PARTIE 1 : SL guard — tourne AVANT ABSTAIN et BEAR_REGIME_SKIP ─────
      // Fermeture réelle sur SL uniquement. TP est SHADOW UNIQUEMENT (voir PARTIE 2).
      // Raison TP shadow : benchmark montre que la stratégie rate les hausses (JTO +15%
      // non capté) — un plafond automatique aggraverait ce défaut en coupant les gagnants.
      // Positions ouvertes avant ce déploiement (sl_price=null) : pas de protection SL.
      // Elles se fermeront sur signal SELL. Seuls les épisodes ouverts APRÈS ce
      // déploiement ont sl_price stocké à l'ouverture.
      {
        const openPosSl = posMap.get(sym)
        if (openPosSl?.slPrice != null) {
          const { slPrice, tpPrice, entryPrice, episodeId: epId, virtual: epVirt, highSinceEntry, slBackfilled } = openPosSl
          const pnlPct = parseFloat((((price - entryPrice) / entryPrice) * 100).toFixed(2))

          // Mise à jour high_since_entry — non-bloquant
          const prevHigh = highSinceEntry ?? entryPrice
          const newHigh  = Math.max(prevHigh, price)
          if (newHigh > prevHigh) {
            supabase.from('kymia_dryrun_positions')
              .update({ high_since_entry: newHigh }).eq('symbol', sym)
              .then(({ error: e }) => { if (e) console.error(`[dryrun] ${sym} high_since_entry:`, e.message) })
          }

          if (price <= slPrice) {
            const backfillTag = slBackfilled
              ? ' [BACKFILLED_SL — late trigger, pre-fix episode]'
              : ''
            const reason = `stop loss hit @ $${price.toFixed(6)} (sl=$${slPrice.toFixed(6)})${backfillTag}`
            console.log(`[dryrun] ${sym} SL_HIT @ $${price.toFixed(4)} (sl=$${slPrice.toFixed(4)}) pnl=${pnlPct}%${slBackfilled ? ' [BACKFILLED]' : ''}`)
            await supabase.from('kymia_dryrun_positions').delete().eq('symbol', sym)
            const curRegimeSl = regimeV.vote !== 'ABSTAIN' ? (regimeV.data?.regime as 'BULL' | 'BEAR' ?? null) : null
            await logDryRun(supabase, {
              symbol: sym, regime: curRegimeSl, signal: null,
              decision: 'EPISODE_CLOSED_SL', reason,
              price_usd: price, episode_id: epId, pnl_pct: pnlPct, episode_virtual: epVirt,
            })
            const { score: scoreSl } = scoreAndAppend(verdicts, sym === 'SOL' ? null : solRegimeVerdict)
            await logVerdicts(supabase, verdicts, cycleTs, sym, 'EPISODE_CLOSED_SL', epId, scoreSl)
            continue
          }
          // TP atteint → SHADOW UNIQUEMENT (aucune fermeture — voir PARTIE 2)
          if (tpPrice != null && price >= tpPrice) {
            console.log(`[dryrun] ${sym} TP_SHADOW: price $${price.toFixed(4)} >= tp $${tpPrice.toFixed(4)} pnl=${pnlPct}% — shadow only, no close`)
          }
        }
      }

      if (regimeV.vote === 'ABSTAIN') {
        console.log(`[dryrun] ${sym} bougies 4h indisponibles (${candles4h?.length ?? 0}) — skip safe`)
        await logDryRun(supabase, {
          symbol: sym, regime: null, signal: null,
          decision: 'CANDLES_UNAVAILABLE',
          reason:   regimeV.reason,
          price_usd: price,
        })
        const { score: scoreAbstain } = scoreAndAppend(verdicts, sym === 'SOL' ? null : solRegimeVerdict)
        await logVerdicts(supabase, verdicts, cycleTs, sym, 'CANDLES_UNAVAILABLE', posMap.get(sym)?.episodeId ?? null, scoreAbstain)
        continue
      }

      const regime = regimeV.data!.regime as 'BULL' | 'BEAR'
      console.log(
        `[dryrun] ${sym} regime=${regime}  price=${price.toFixed(4)}` +
        `  EMA50=${(regimeV.data!.ema50_4h as number).toFixed(4)}` +
        `  EMA200=${(regimeV.data!.ema200_4h as number).toFixed(4)}`
      )

      // ── PARTIE 2 : Exit shadow — SHADOW UNIQUEMENT, aucune fermeture ─────
      // Mesure ce qu'auraient donné regime_flip, time_stop et TP AVANT de les
      // implémenter. Données de comparaison pour l'auto-audit dans 2 semaines.
      {
        const openPosEx = posMap.get(sym)
        if (openPosEx != null) {
          const pnlEx    = parseFloat((((price - openPosEx.entryPrice) / openPosEx.entryPrice) * 100).toFixed(2))
          const hoursOpen = (Date.now() - new Date(openPosEx.openedAt).getTime()) / 3_600_000
          try {
            await supabase.from('kymia_regime_shadow').insert({
              cycle_ts: cycleTs,
              symbol:   sym,
              variant:  'EXIT_shadow',
              regime,
              price,
              data: {
                would_exit_regime_flip: openPosEx.openedRegime === 'BULL' && regime === 'BEAR',
                would_exit_time_stop:   hoursOpen > 48,
                would_exit_tp:          openPosEx.tpPrice != null && price >= openPosEx.tpPrice,
                pnl_pct:                pnlEx,
                hours_open:             parseFloat(hoursOpen.toFixed(1)),
                opened_at:              openPosEx.openedAt,
                opened_regime:          openPosEx.openedRegime,
                tp_price:               openPosEx.tpPrice,
              },
            })
          } catch (e: any) {
            console.error(`[exit-shadow] ${sym}:`, e.message)
          }
        }
      }

      // ── Agent 2 : Signal (véto doux : tourne aussi en BEAR) ──────────────
      const signalV = signalAgent(ctx)
      verdicts.push(signalV)
      const sigData = signalV.data as { signal: string; tp: number; sl: number }

      // ── Agent 3 : Sizing (véto doux : tourne aussi en BEAR) ──────────────
      const sizingV = sizingAgent(ctx)
      verdicts.push(sizingV)

      if (regimeV.vote === 'REJECT') {
        // Véto doux : verdicts écrits en base (signal + sizing visibles)
        console.log(`[dryrun] ${sym} BEAR — signal=${signalV.vote} sizing=${(sizingV.data as any)?.sizeCalculee}`)
        await logDryRun(supabase, {
          symbol:    sym,
          regime,
          signal:    null,
          decision:  'BEAR_REGIME_SKIP',
          reason:    regimeV.reason,
          price_usd: price,
        })
        const { score: scoreBear } = scoreAndAppend(verdicts, sym === 'SOL' ? null : solRegimeVerdict)
        await logVerdicts(supabase, verdicts, cycleTs, sym, 'BEAR_REGIME_SKIP', posMap.get(sym)?.episodeId ?? null, scoreBear)
        continue
      }

      // ── BULL — routing du signal ──────────────────────────────────────────

      // R2 : SELL → close épisode ou ignorer (spot only)
      if (sigData.signal === 'SELL') {
        const pos = posMap.get(sym)
        if (pos) {
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
          const { score: scoreClose } = scoreAndAppend(verdicts, sym === 'SOL' ? null : solRegimeVerdict)
          await logVerdicts(supabase, verdicts, cycleTs, sym, 'EPISODE_CLOSED', pos.episodeId, scoreClose)
        } else {
          console.log(`[dryrun] ${sym} SHORT_SIGNAL_IGNORED_SPOT`)
          await logDryRun(supabase, {
            symbol: sym, regime, signal: 'SELL',
            decision:  'SHORT_SIGNAL_IGNORED_SPOT',
            reason:    signalV.reason,
            price_usd: price,
          })
          const { score: scoreShort } = scoreAndAppend(verdicts, sym === 'SOL' ? null : solRegimeVerdict)
          await logVerdicts(supabase, verdicts, cycleTs, sym, 'SHORT_SIGNAL_IGNORED_SPOT', null, scoreShort)
        }
        continue
      }

      if (sigData.signal !== 'BUY') {
        await logDryRun(supabase, {
          symbol: sym, regime, signal: sigData.signal as any,
          decision:  'NO_SIGNAL',
          reason:    signalV.reason,
          price_usd: price,
        })
        const { score: scoreNone } = scoreAndAppend(verdicts, sym === 'SOL' ? null : solRegimeVerdict)
        await logVerdicts(supabase, verdicts, cycleTs, sym, 'NO_SIGNAL', posMap.get(sym)?.episodeId ?? null, scoreNone)
        continue
      }

      // BUY — déjà en position ?
      const existingPos = posMap.get(sym)
      if (existingPos) {
        await logDryRun(supabase, {
          symbol:          sym,
          regime,
          signal:          'BUY',
          decision:        'ALREADY_IN_POSITION',
          reason:          `episode opened @ $${existingPos.entryPrice.toFixed(4)} on ${existingPos.openedAt}`,
          price_usd:       price,
          episode_id:      existingPos.episodeId,
          episode_virtual: existingPos.virtual,
        })
        const { score: scoreHeld } = scoreAndAppend(verdicts, sym === 'SOL' ? null : solRegimeVerdict)
        await logVerdicts(supabase, verdicts, cycleTs, sym, 'ALREADY_IN_POSITION', existingPos.episodeId, scoreHeld)
        continue
      }

      // ── Sizing déjà calculé par Agent 3 ──────────────────────────────────
      const sizeCalculee = (sizingV.data as { sizeCalculee: number }).sizeCalculee
      const atr14        = (sizingV.data as { atr14: number }).atr14

      // ── Jupiter quote → Agents 4 (Edge) + 5 (Risk) ───────────────────────
      let quoteJupiter: any = null
      let decision     = 'WOULD_EXECUTE'
      let rejectReason = ''

      try {
        const amountRaw = toRawAmount(sizeCalculee, 6)  // USDC = 6 décimales
        const quote = await getQuote(SOL_MINTS.USDC, ctx.mintOut, amountRaw, 50)
        quoteJupiter = { inAmount: quote.inAmount, outAmount: quote.outAmount, priceImpactPct: quote.priceImpactPct }

        const enrichedCtx: CycleContext = { ...ctx, sizeCalculee, quoteJupiter }

        // ── Agent 4 : Edge (R3) ────────────────────────────────────────────
        const edgeV = edgeAgent(enrichedCtx, sigData.tp)
        verdicts.push(edgeV)
        const priceImpact = Math.abs(parseFloat(quote.priceImpactPct))

        if (edgeV.vote === 'REJECT') {
          decision     = 'REJECTED_LOW_EDGE'
          rejectReason = edgeV.reason
        } else {
          // ── Agent 5 : Risk (guards) ──────────────────────────────────────
          let onchainEquity = 0
          try {
            onchainEquity = await getTokenBalance(SOL_MINTS.USDC)
          } catch {
            // Wallet non configuré / RPC absent → equity=0 → GUARD_REFUSED attendu
          }

          const fullCtx: CycleContext = { ...enrichedCtx, onchainEquity }
          const riskV = await riskAgent(fullCtx, supabase)
          verdicts.push(riskV)

          if (riskV.vote === 'REJECT') {
            decision     = 'GUARD_REFUSED'
            rejectReason = riskV.reason
          }
        }

        const gainExpectedPct = sigData.tp > 0 ? (sigData.tp - price) / price : 0
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

      // ── Score de confluence (R20) ─────────────────────────────────────────
      // Calculé après tous les agents du cycle (edge ± risk inclus si atteints).
      // Pour SOL, solContext=null (évite le double-comptage avec son propre regime).
      const solCtx = sym === 'SOL' ? null : solRegimeVerdict
      const { score, partial_score } = scoreAndAppend(verdicts, solCtx)

      // Application du score — uniquement sur WOULD_EXECUTE (les autres décisions
      // sont déjà definies par un véto ou une condition structurelle).
      let sizeEffective = sizeCalculee
      if (decision === 'WOULD_EXECUTE') {
        if (score < 50) {
          decision     = 'REJECTED_LOW_SCORE'
          rejectReason = `confluence score ${score} < 50${partial_score ? ' (partial)' : ''}`
        } else if (score < 70) {
          // Tranche 50-70 : taille réduite à 50%
          sizeEffective = parseFloat((sizeCalculee * 0.5).toFixed(2))
        }
        // ≥70 : taille pleine (trailing élargi à implémenter avec R23/vrai exécution)
      }

      console.log(`[dryrun] ${sym} confluence score=${score}${partial_score ? '(p)' : ''} → decision=${decision}${sizeEffective !== sizeCalculee ? ` size=${sizeEffective}(50%)` : ''}`)

      // ── Ouvrir l'épisode ──────────────────────────────────────────────────
      const isFundsRefusal = /insuffisant/i.test(rejectReason)
      const isVirtual      = decision === 'GUARD_REFUSED' && isFundsRefusal
      const shouldOpen     = decision === 'WOULD_EXECUTE' || isVirtual

      let episodeId: string | null = null
      if (shouldOpen) {
        episodeId = crypto.randomUUID()
        const openedAt = new Date().toISOString()
        await supabase.from('kymia_dryrun_positions').upsert({
          symbol:           sym,
          entry_price:      price,
          opened_at:        openedAt,
          episode_id:       episodeId,
          virtual:          isVirtual,
          sl_price:         sigData.sl > 0 ? sigData.sl : null,
          tp_price:         sigData.tp > 0 ? sigData.tp : null,
          opened_regime:    regime,
          high_since_entry: price,
          sl_backfilled:    false,
        })
        console.log(
          `[dryrun] ${sym} EPISODE OPENED @ $${price.toFixed(4)} id=${episodeId}` +
          (isVirtual ? ' [VIRTUAL — fonds insuffisants]' : '') +
          (sigData.sl > 0 ? ` sl=$${sigData.sl.toFixed(4)} tp=$${sigData.tp.toFixed(4)}` : '')
        )
      }

      await logDryRun(supabase, {
        symbol:          sym,
        regime,
        signal:          'BUY',
        decision,
        reason:          rejectReason || signalV.reason,
        size_calculee:   sizeEffective,   // taille effective (50% si score 50-70)
        quote_jupiter:   quoteJupiter,
        size_basis:      'reference_200',
        price_usd:       price,
        episode_id:      episodeId,
        episode_virtual: episodeId ? isVirtual : null,
        score_total:     score,
      })
      // Verdicts : episodeId = nouvel épisode si ouvert, sinon null (pas de position ouverte à ce stade)
      await logVerdicts(supabase, verdicts, cycleTs, sym, decision, episodeId, score)

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
