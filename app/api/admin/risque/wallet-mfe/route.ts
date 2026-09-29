// app/api/admin/risque/wallet-mfe/route.ts
// Calcul du MFE (Maximum Favourable Excursion) sur 24h par token.
//
// ── Params ────────────────────────────────────────────────────────────────────────
//   ?limit=20            — tokens par lot (défaut 20, max 30)
//   ?reset_null=true     — remet mfe_computed_at=NULL où mfe_mult_24h IS NULL
//                          (tokens marqués no_pool/no_candles à reprocesser)
//   ?debug=true&mint=X   — mode debug : inspecte un seul mint en détail
//
// ── Prix d'entrée (3 niveaux de fallback) ────────────────────────────────────────
//   1. market_cap_at_buy / 1_000_000_000 (mcap USD / supply pump.fun = 1B)
//   2. Open de la première bougie OHLCV postérieure à bought_at
//   3. Open de la première bougie disponible (token arrivé sur DEX après l'achat)
//
// ── Rate limit GeckoTerminal ─────────────────────────────────────────────────────
//   Sur 429 : retry avec sleep(retry-after ou 60s), jusqu'à 3 tentatives.
//   Si rate limit persistant : token NON marqué comme traité → sera repris au prochain lot.
//
// ── Simulation trailing stop ─────────────────────────────────────────────────────
//   stop = -35% (entry × 0.65), trail activation = +30% (entry × 1.30)
//   Dans chaque bougie : low avant high (hypothèse conservatrice).

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const GECKO      = 'https://api.geckoterminal.com/api/v2'
const GECKO_GAP  = 500   // ms entre appels (30 req/min free tier)
const PUMP_SUPPLY = 1_000_000_000   // supply pump.fun standard
const STOP_MULT  = 0.65
const TRAIL_MULT = 1.30

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ── GeckoTerminal helpers ─────────────────────────────────────────────────────────

class GeckoRateLimit extends Error {
  constructor() { super('GeckoTerminal rate limit (429)'); this.name = 'GeckoRateLimit' }
}

async function geckoGet(path: string, attempt = 0): Promise<unknown> {
  const res = await fetch(`${GECKO}${path}`, {
    headers: { 'Accept': 'application/json;version=20230302', 'User-Agent': 'KYMIA/1.0' },
    signal:  AbortSignal.timeout(10_000),
  })
  if (res.status === 429) {
    if (attempt >= 3) throw new GeckoRateLimit()
    const waitMs = Math.max(parseInt(res.headers.get('retry-after') ?? '60', 10) * 1000, 5_000)
    console.warn(`[wallet-mfe] GeckoTerminal 429 — attente ${waitMs}ms (tentative ${attempt + 1}/3)`)
    await sleep(waitMs)
    return geckoGet(path, attempt + 1)
  }
  if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status} for ${path}`)
  return res.json()
}

async function getPoolAddress(mint: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await geckoGet(`/networks/solana/tokens/${mint}/pools?limit=1`) as any
  return (data?.data?.[0]?.attributes?.address as string) ?? null
}

// [ts, open, high, low, close, volume]
type Candle = [number, number, number, number, number, number]

// Récupère les bougies horaires dans la fenêtre [entryTs - 2h, entryTs + 26h].
// Retourne trié chronologiquement (plus ancien en premier).
async function getOhlcv(poolAddress: string, entryTs: number): Promise<Candle[]> {
  // before_timestamp = entryTs + 27h → 26 bougies d'1h → fenêtre [entryTs + 1h, entryTs + 26h]
  // +2h de marge avant entryTs pour capturer la bougie d'entrée si le pool a démarré avant
  const beforeTs = entryTs + 27 * 3600
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await geckoGet(
    `/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=60&limit=26&before_timestamp=${beforeTs}`
  ) as any
  const raw: Candle[] = data?.data?.attributes?.ohlcv_list ?? []
  // Filtrer [entryTs - 2h, entryTs + 24h] et trier chronologiquement
  return raw
    .filter((c: Candle) => c[0] >= entryTs - 7200 && c[0] <= entryTs + 86400)
    .sort((a: Candle, b: Candle) => a[0] - b[0])
}

// ── computeMfe ────────────────────────────────────────────────────────────────────
// entryTs   : timestamp unix du premier achat
// entryMcap : market_cap_at_buy (USD) — null si inconnu

type MfeResult = {
  entryPrice:     number
  entryPriceSrc:  'mcap' | 'candle_after' | 'candle_first'
  mfeMult:        number
  stopHitFirst:   boolean
  trailActivated: boolean
}

function computeMfe(candles: Candle[], entryTs: number, entryMcap: number | null): MfeResult | null {
  if (candles.length === 0) return null

  // Prix d'entrée — 3 niveaux de fallback
  let entryPrice: number
  let entryPriceSrc: MfeResult['entryPriceSrc']

  if (entryMcap && entryMcap > 0) {
    entryPrice    = entryMcap / PUMP_SUPPLY
    entryPriceSrc = 'mcap'
  } else {
    // Première bougie postérieure à entryTs
    const candleAfter = candles.find(c => c[0] >= entryTs)
    if (candleAfter && candleAfter[1] > 0) {
      entryPrice    = candleAfter[1]   // open
      entryPriceSrc = 'candle_after'
    } else {
      // Fallback total : première bougie disponible
      const first = candles[0]
      if (!first || first[1] <= 0) return null
      entryPrice    = first[1]
      entryPriceSrc = 'candle_first'
    }
  }

  if (entryPrice <= 0) return null

  const stopPrice  = entryPrice * STOP_MULT
  const trailPrice = entryPrice * TRAIL_MULT

  // Bougies actives pour la simulation : à partir de entryTs
  // (les bougies avant servent uniquement au fallback de prix)
  const active = candles.filter(c => c[0] >= entryTs)
  if (active.length === 0) {
    // Toutes les bougies sont avant entryTs → MFE depuis la première quand même
    // (token gradué APRÈS l'achat, les premières bougies = juste après graduation)
    const allHigh = Math.max(...candles.map(c => c[2]))
    return {
      entryPrice, entryPriceSrc,
      mfeMult:        parseFloat((allHigh / entryPrice).toFixed(4)),
      stopHitFirst:   false,
      trailActivated: allHigh >= trailPrice,
    }
  }

  let mfePrice       = entryPrice
  let trailActivated = false
  let stopHitFirst   = false

  for (const [, , high, low] of active) {
    if (high > mfePrice) mfePrice = high
    if (!trailActivated && !stopHitFirst) {
      if (low <= stopPrice) { stopHitFirst = true; break }
    }
    if (!trailActivated && high >= trailPrice) trailActivated = true
  }

  return {
    entryPrice,
    entryPriceSrc,
    mfeMult:        parseFloat((mfePrice / entryPrice).toFixed(4)),
    stopHitFirst:   stopHitFirst && !trailActivated,
    trailActivated,
  }
}

// ── processOneMint ────────────────────────────────────────────────────────────────
// Logique isolée pour pouvoir l'appeler aussi depuis le mode debug.

type ProcessResult = {
  mint:             string
  entry_ts:         number | null
  entry_mcap:       number | null
  pool_address:     string | null
  candles_fetched:  number
  candles_active:   number
  entry_price:      number | null
  entry_price_src:  string | null
  mfe_mult_24h:     number | null
  stop_hit_first:   boolean | null
  trail_activated:  boolean | null
  status:           'ok' | 'no_pool' | 'no_candles' | 'no_entry' | 'rate_limited' | 'error'
  error?:           string
}

async function processOneMint(
  mint:          string,
  firstEntry:    { entryTs: number; entryMcap: number | null } | undefined,
  supabase:      SupabaseClient,
  now:           string,
  persist:       boolean,  // false en mode debug
): Promise<ProcessResult> {
  if (!firstEntry) {
    if (persist) {
      await supabase.from('kymia_risque_tokens')
        .upsert({ mint, mfe_computed_at: now }, { onConflict: 'mint' })
    }
    return { mint, entry_ts: null, entry_mcap: null, pool_address: null, candles_fetched: 0, candles_active: 0, entry_price: null, entry_price_src: null, mfe_mult_24h: null, stop_hit_first: null, trail_activated: null, status: 'no_entry' }
  }

  // Pool
  let poolAddress: string | null = null
  try {
    poolAddress = await getPoolAddress(mint)
  } catch (e: any) {
    if (e instanceof GeckoRateLimit) {
      return { mint, entry_ts: firstEntry.entryTs, entry_mcap: firstEntry.entryMcap, pool_address: null, candles_fetched: 0, candles_active: 0, entry_price: null, entry_price_src: null, mfe_mult_24h: null, stop_hit_first: null, trail_activated: null, status: 'rate_limited', error: e.message }
    }
    // Erreur réseau non-429 → marquer comme traité (ne pas boucler indéfiniment)
    if (persist) {
      await supabase.from('kymia_risque_tokens')
        .upsert({ mint, mfe_pool_address: null, mfe_computed_at: now }, { onConflict: 'mint' })
    }
    return { mint, entry_ts: firstEntry.entryTs, entry_mcap: firstEntry.entryMcap, pool_address: null, candles_fetched: 0, candles_active: 0, entry_price: null, entry_price_src: null, mfe_mult_24h: null, stop_hit_first: null, trail_activated: null, status: 'error', error: e.message }
  }

  await sleep(GECKO_GAP)

  if (!poolAddress) {
    if (persist) {
      await supabase.from('kymia_risque_tokens')
        .upsert({ mint, mfe_pool_address: null, mfe_computed_at: now }, { onConflict: 'mint' })
    }
    return { mint, entry_ts: firstEntry.entryTs, entry_mcap: firstEntry.entryMcap, pool_address: null, candles_fetched: 0, candles_active: 0, entry_price: null, entry_price_src: null, mfe_mult_24h: null, stop_hit_first: null, trail_activated: null, status: 'no_pool' }
  }

  // OHLCV
  let candles: Candle[] = []
  try {
    candles = await getOhlcv(poolAddress, firstEntry.entryTs)
  } catch (e: any) {
    if (e instanceof GeckoRateLimit) {
      return { mint, entry_ts: firstEntry.entryTs, entry_mcap: firstEntry.entryMcap, pool_address: poolAddress, candles_fetched: 0, candles_active: 0, entry_price: null, entry_price_src: null, mfe_mult_24h: null, stop_hit_first: null, trail_activated: null, status: 'rate_limited', error: e.message }
    }
    if (persist) {
      await supabase.from('kymia_risque_tokens')
        .upsert({ mint, mfe_pool_address: poolAddress, mfe_computed_at: now }, { onConflict: 'mint' })
    }
    return { mint, entry_ts: firstEntry.entryTs, entry_mcap: firstEntry.entryMcap, pool_address: poolAddress, candles_fetched: 0, candles_active: 0, entry_price: null, entry_price_src: null, mfe_mult_24h: null, stop_hit_first: null, trail_activated: null, status: 'error', error: e.message }
  }

  const activeCandles = candles.filter(c => c[0] >= firstEntry.entryTs)

  if (candles.length === 0) {
    if (persist) {
      await supabase.from('kymia_risque_tokens')
        .upsert({ mint, mfe_pool_address: poolAddress, mfe_computed_at: now }, { onConflict: 'mint' })
    }
    return { mint, entry_ts: firstEntry.entryTs, entry_mcap: firstEntry.entryMcap, pool_address: poolAddress, candles_fetched: 0, candles_active: 0, entry_price: null, entry_price_src: null, mfe_mult_24h: null, stop_hit_first: null, trail_activated: null, status: 'no_candles' }
  }

  const mfe = computeMfe(candles, firstEntry.entryTs, firstEntry.entryMcap)

  if (persist) {
    await supabase.from('kymia_risque_tokens')
      .upsert({
        mint,
        mfe_pool_address:    poolAddress,
        mfe_mult_24h:        mfe?.mfeMult        ?? null,
        mfe_stop_hit_first:  mfe?.stopHitFirst   ?? null,
        mfe_trail_activated: mfe?.trailActivated ?? null,
        mfe_computed_at:     now,
      }, { onConflict: 'mint' })
  }

  return {
    mint,
    entry_ts:        firstEntry.entryTs,
    entry_mcap:      firstEntry.entryMcap,
    pool_address:    poolAddress,
    candles_fetched: candles.length,
    candles_active:  activeCandles.length,
    entry_price:     mfe?.entryPrice      ?? null,
    entry_price_src: mfe?.entryPriceSrc   ?? null,
    mfe_mult_24h:    mfe?.mfeMult         ?? null,
    stop_hit_first:  mfe?.stopHitFirst    ?? null,
    trail_activated: mfe?.trailActivated  ?? null,
    status:          mfe ? 'ok' : 'no_candles',
  }
}

// ── Handler GET ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  const sp         = req.nextUrl.searchParams
  const limit      = Math.max(1, Math.min(30, parseInt(sp.get('limit') ?? '20', 10)))
  const resetNull  = sp.get('reset_null') === 'true'
  const debugMode  = sp.get('debug') === 'true'
  const debugMint  = sp.get('mint') ?? null

  const now = new Date().toISOString()

  // ── reset_null : remet mfe_computed_at=NULL où mfe_mult_24h IS NULL ────────────
  if (resetNull) {
    const { count: resetCount, error: resetErr } = await supabase
      .from('kymia_risque_tokens')
      .update({ mfe_computed_at: null })
      .is('mfe_mult_24h', null)
      .not('mfe_computed_at', 'is', null)
      .select('*', { count: 'exact', head: true })
    if (resetErr) console.warn(`[wallet-mfe] reset_null: ${resetErr.message}`)
    else console.log(`[wallet-mfe] reset_null: ${resetCount ?? 0} tokens remis en attente`)
    if (!debugMode) {
      return NextResponse.json({ ok: true, reset: resetCount ?? 0, message: 'Tokens sans MFE remis en attente — relancer sans ?reset_null' })
    }
  }

  // Premier achat par token (tous wallets) — chargé une seule fois
  const { data: firstBuysData } = await supabase
    .from('kymia_risque_buys')
    .select('token_mint, bought_at, market_cap_at_buy')
    .order('bought_at', { ascending: true })

  const firstBuyByToken = new Map<string, { entryTs: number; entryMcap: number | null }>()
  for (const b of (firstBuysData ?? []) as Array<{ token_mint: string; bought_at: string; market_cap_at_buy: number | null }>) {
    if (!firstBuyByToken.has(b.token_mint)) {
      firstBuyByToken.set(b.token_mint, {
        entryTs:   Math.floor(new Date(b.bought_at).getTime() / 1000),
        entryMcap: b.market_cap_at_buy && b.market_cap_at_buy > 0 ? b.market_cap_at_buy : null,
      })
    }
  }

  // ── Mode debug : un seul mint, résultat détaillé sans persistance ──────────────
  if (debugMode && debugMint) {
    console.log(`[wallet-mfe] DEBUG ${debugMint}`)
    const firstEntry = firstBuyByToken.get(debugMint)
    const result = await processOneMint(debugMint, firstEntry, supabase, now, false)
    return NextResponse.json({ ok: true, debug: true, ...result })
  }

  // ── Mode normal : lot paginé ──────────────────────────────────────────────────
  const { data: pendingTokens, error: tokenErr, count: totalPending } = await supabase
    .from('kymia_risque_tokens')
    .select('mint', { count: 'exact' })
    .is('mfe_computed_at', null)
    .limit(limit)

  if (tokenErr) return NextResponse.json({ error: tokenErr.message }, { status: 500 })

  const mints = ((pendingTokens ?? []) as Array<{ mint: string }>).map(t => t.mint)
  console.log(
    `[wallet-mfe] lot limit=${limit} — ${mints.length} tokens à traiter` +
    ` (${totalPending ?? '?'} en attente au total)`
  )

  const results: ProcessResult[] = []
  let rateLimitHits = 0

  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i]
    if (i > 0) await sleep(GECKO_GAP)

    const firstEntry = firstBuyByToken.get(mint)
    const result     = await processOneMint(mint, firstEntry, supabase, now, true)
    results.push(result)

    if (result.status === 'rate_limited') {
      rateLimitHits++
      console.warn(`[wallet-mfe] rate limit sur ${mint.slice(0, 8)}… — pause 60s`)
      await sleep(60_000)   // pause longue puis le prochain lot continuera
    }

    console.log(
      `[wallet-mfe] ${mint.slice(0, 8)}…` +
      ` pool=${result.pool_address?.slice(0, 8) ?? 'null'}…` +
      ` candles=${result.candles_fetched}/${result.candles_active}` +
      ` mfe=${result.mfe_mult_24h?.toFixed(2) ?? 'null'}` +
      ` src=${result.entry_price_src ?? '-'}` +
      ` status=${result.status}`
    )
  }

  // Compter les restants
  const { count: stillRemaining } = await supabase
    .from('kymia_risque_tokens')
    .select('*', { count: 'exact', head: true })
    .is('mfe_computed_at', null)

  const summary = {
    ok:           results.filter(r => r.status === 'ok').length,
    no_pool:      results.filter(r => r.status === 'no_pool').length,
    no_candles:   results.filter(r => r.status === 'no_candles').length,
    no_entry:     results.filter(r => r.status === 'no_entry').length,
    rate_limited: rateLimitHits,
    error:        results.filter(r => r.status === 'error').length,
  }

  return NextResponse.json({
    ok:         true,
    batch:      { limit, processed: mints.length },
    summary,
    remaining:  stillRemaining ?? 0,
    next_step:  stillRemaining && stillRemaining > 0
      ? `Relancer GET /api/admin/risque/wallet-mfe?limit=${limit} (${stillRemaining} restants)${rateLimitHits > 0 ? ' — rate limit détecté, augmenter GECKO_GAP si besoin' : ''}`
      : 'MFE terminé — GET /api/admin/risque/wallet-winrate pour les stats complètes',
    tokens:     results,
  })
}
