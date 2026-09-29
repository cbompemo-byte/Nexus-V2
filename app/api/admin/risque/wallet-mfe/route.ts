// app/api/admin/risque/wallet-mfe/route.ts
// Calcul du MFE (Maximum Favourable Excursion) sur 24h par token.
//
// ── Ce que fait cet endpoint ──────────────────────────────────────────────────────
//   GET /api/admin/risque/wallet-mfe?limit=20
//   → Charge les tokens de kymia_risque_tokens où mfe_computed_at IS NULL,
//     20 par lot (configurable). Pour chaque token :
//       1. Premier achat TOUS wallets confondus → timestamp d'entrée + entry price
//       2. GET pool depuis GeckoTerminal (sans clé)
//       3. GET OHLCV horaire 24h après l'entrée
//       4. Calcule :
//            mfe_mult_24h       — max(high) / entry_price sur la fenêtre
//            mfe_stop_hit_first — -35% atteint AVANT +30% (simulation trailing stop)
//            mfe_trail_activated — +30% atteint à un moment dans la fenêtre
//       5. Upsert kymia_risque_tokens avec les résultats + mfe_computed_at
//   Les résultats sont lus par GET /api/admin/risque/wallet-winrate.
//
// ── Simulation trailing stop ─────────────────────────────────────────────────────
//   Les bougies sont traitées chronologiquement. Dans chaque bougie :
//     - Si low ≤ entry × 0.65 ET trailing pas encore activé → stop touché en premier
//     - Si high ≥ entry × 1.30 → trailing activé
//   (On assume le pire dans la bougie : low avant high, convention standard.)
//   stop_hit_first = true → la stratégie aurait perdu (-35% stoploss)
//   trail_activated = true && !stop_hit_first → la stratégie aurait capturé la hausse
//
// ── 0 crédit Helius ──────────────────────────────────────────────────────────────
//   GeckoTerminal API gratuite, sans clé.

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'

const GECKO = 'https://api.geckoterminal.com/api/v2'

// 500ms entre appels GeckoTerminal pour rester sous le rate-limit free tier (~30 req/min)
const GECKO_GAP_MS = 500

const STOP_MULT  = 0.65   // -35%
const TRAIL_MULT = 1.30   // +30%

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ── GeckoTerminal helpers ─────────────────────────────────────────────────────────

async function geckoGet(path: string): Promise<unknown> {
  const res = await fetch(`${GECKO}${path}`, {
    headers: { 'Accept': 'application/json;version=20230302', 'User-Agent': 'KYMIA/1.0' },
    signal:  AbortSignal.timeout(10_000),
  })
  if (res.status === 429) throw new Error('GeckoTerminal 429')
  if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`)
  return res.json()
}

// Récupère l'adresse du pool le plus liquide pour un mint Solana.
async function getPoolAddress(mint: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await geckoGet(`/networks/solana/tokens/${mint}/pools?limit=1`) as any
    return (data?.data?.[0]?.attributes?.address as string) ?? null
  } catch { return null }
}

// Récupère les bougies horaires dans la fenêtre [entryTs, entryTs + 24h].
// GeckoTerminal retourne les bougies les plus récentes en premier (DESC).
// before_timestamp = entryTs + 25h pour avoir de la marge.
// [ts, open, high, low, close, volume]
type Candle = [number, number, number, number, number, number]

async function getOhlcv24h(poolAddress: string, entryTs: number): Promise<Candle[]> {
  const beforeTs = entryTs + 25 * 3600
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await geckoGet(
      `/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=60&limit=24&before_timestamp=${beforeTs}`
    ) as any
    const raw: Candle[] = data?.data?.attributes?.ohlcv_list ?? []
    // Filtrer la fenêtre exacte et trier chronologiquement (plus ancien en premier)
    return raw
      .filter((c: Candle) => c[0] >= entryTs && c[0] <= entryTs + 86400)
      .sort((a: Candle, b: Candle) => a[0] - b[0])
  } catch { return [] }
}

// ── computeMfe ────────────────────────────────────────────────────────────────────

type MfeResult = {
  mfeMult:        number    // max(high) / entry_price — multiplicateur maximum 24h
  stopHitFirst:   boolean   // -35% atteint avant +30%
  trailActivated: boolean   // +30% atteint à un moment (peu importe si stop vient après)
}

function computeMfe(candles: Candle[]): MfeResult | null {
  if (candles.length === 0) return null

  // Prix d'entrée = open de la première bougie (la plus ancienne)
  const entryPrice = candles[0][1]   // [ts, open, high, low, close, vol]
  if (!entryPrice || entryPrice <= 0) return null

  const stopPrice  = entryPrice * STOP_MULT
  const trailPrice = entryPrice * TRAIL_MULT

  let mfePrice       = entryPrice
  let trailActivated = false
  let stopHitFirst   = false

  for (const [, , high, low] of candles) {
    if (high > mfePrice) mfePrice = high

    // Simulation : dans la bougie, on assume low avant high (conservateur pour le trader)
    if (!trailActivated && !stopHitFirst) {
      if (low <= stopPrice) {
        stopHitFirst = true
        break   // stop déclenché — on arrête la simulation
      }
    }
    if (!trailActivated && high >= trailPrice) {
      trailActivated = true
    }
  }

  return {
    mfeMult:        parseFloat((mfePrice / entryPrice).toFixed(4)),
    stopHitFirst:   stopHitFirst && !trailActivated,
    trailActivated,
  }
}

// ── Handler GET ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  const sp    = req.nextUrl.searchParams
  const limit = Math.max(1, Math.min(30, parseInt(sp.get('limit') ?? '20', 10)))

  // 1. Tokens pas encore calculés
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

  // 2. Premier achat par token (tous wallets) → timestamp d'entrée
  const { data: firstBuysData } = await supabase
    .from('kymia_risque_buys')
    .select('token_mint, bought_at, market_cap_at_buy')
    .in('token_mint', mints)
    .order('bought_at', { ascending: true })

  // Garder le premier achat par token (le plus ancien)
  const firstBuyByToken = new Map<string, { entryTs: number; entryMcap: number | null }>()
  for (const b of (firstBuysData ?? []) as Array<{ token_mint: string; bought_at: string; market_cap_at_buy: number | null }>) {
    if (!firstBuyByToken.has(b.token_mint)) {
      firstBuyByToken.set(b.token_mint, {
        entryTs:   Math.floor(new Date(b.bought_at).getTime() / 1000),
        entryMcap: b.market_cap_at_buy,
      })
    }
  }

  // 3. Traiter chaque token
  type TokenMfeResult = {
    mint:           string
    entry_ts:       number | null
    pool_address:   string | null
    candles:        number
    mfe_mult_24h:   number | null
    stop_hit_first: boolean | null
    trail_activated: boolean | null
    status:         'ok' | 'no_pool' | 'no_candles' | 'no_entry' | 'error'
  }

  const results: TokenMfeResult[] = []
  const now = new Date().toISOString()

  for (let i = 0; i < mints.length; i++) {
    const mint       = mints[i]
    const firstEntry = firstBuyByToken.get(mint)

    if (!firstEntry) {
      // Token dans kymia_risque_tokens mais aucun achat → marquer computed pour ne pas retraiter
      await supabase.from('kymia_risque_tokens')
        .upsert({ mint, mfe_computed_at: now }, { onConflict: 'mint' })
      results.push({ mint, entry_ts: null, pool_address: null, candles: 0, mfe_mult_24h: null, stop_hit_first: null, trail_activated: null, status: 'no_entry' })
      continue
    }

    // Pause entre appels GeckoTerminal (sauf pour le premier)
    if (i > 0) await sleep(GECKO_GAP_MS)

    // a. Pool address
    const poolAddress = await getPoolAddress(mint)
    await sleep(GECKO_GAP_MS)

    if (!poolAddress) {
      // Token pas encore sur DEX (bonding curve ou mort) → marquer computed
      await supabase.from('kymia_risque_tokens')
        .upsert({ mint, mfe_pool_address: null, mfe_computed_at: now }, { onConflict: 'mint' })
      results.push({ mint, entry_ts: firstEntry.entryTs, pool_address: null, candles: 0, mfe_mult_24h: null, stop_hit_first: null, trail_activated: null, status: 'no_pool' })
      continue
    }

    // b. OHLCV 24h
    let candles: Candle[] = []
    try {
      candles = await getOhlcv24h(poolAddress, firstEntry.entryTs)
    } catch (e: any) {
      console.warn(`[wallet-mfe] OHLCV ${mint.slice(0,8)}…: ${e.message}`)
    }

    if (candles.length === 0) {
      await supabase.from('kymia_risque_tokens')
        .upsert({ mint, mfe_pool_address: poolAddress, mfe_computed_at: now }, { onConflict: 'mint' })
      results.push({ mint, entry_ts: firstEntry.entryTs, pool_address: poolAddress, candles: 0, mfe_mult_24h: null, stop_hit_first: null, trail_activated: null, status: 'no_candles' })
      continue
    }

    // c. Calcul MFE
    const mfe = computeMfe(candles)
    console.log(
      `[wallet-mfe] ${mint.slice(0,8)}… pool=${poolAddress.slice(0,8)}…` +
      ` candles=${candles.length} mfe=${mfe?.mfeMult.toFixed(2) ?? 'null'}` +
      ` stop=${mfe?.stopHitFirst} trail=${mfe?.trailActivated}`
    )

    await supabase.from('kymia_risque_tokens')
      .upsert({
        mint,
        mfe_pool_address:   poolAddress,
        mfe_mult_24h:       mfe?.mfeMult       ?? null,
        mfe_stop_hit_first: mfe?.stopHitFirst  ?? null,
        mfe_trail_activated: mfe?.trailActivated ?? null,
        mfe_computed_at:    now,
      }, { onConflict: 'mint' })

    results.push({
      mint,
      entry_ts:        firstEntry.entryTs,
      pool_address:    poolAddress,
      candles:         candles.length,
      mfe_mult_24h:    mfe?.mfeMult       ?? null,
      stop_hit_first:  mfe?.stopHitFirst  ?? null,
      trail_activated: mfe?.trailActivated ?? null,
      status:          mfe ? 'ok' : 'no_candles',
    })
  }

  // Compter les restants
  const { count: stillRemaining } = await supabase
    .from('kymia_risque_tokens')
    .select('*', { count: 'exact', head: true })
    .is('mfe_computed_at', null)

  // Résumé
  const ok         = results.filter(r => r.status === 'ok').length
  const noPool     = results.filter(r => r.status === 'no_pool').length
  const noCandles  = results.filter(r => r.status === 'no_candles').length
  const noEntry    = results.filter(r => r.status === 'no_entry').length

  return NextResponse.json({
    ok:        true,
    batch:     { limit, processed: mints.length },
    summary:   { ok, no_pool: noPool, no_candles: noCandles, no_entry: noEntry },
    remaining: stillRemaining ?? 0,
    next_step: stillRemaining && stillRemaining > 0
      ? `Relancer GET /api/admin/risque/wallet-mfe?limit=${limit} (${stillRemaining} tokens restants)`
      : 'MFE terminé — GET /api/admin/risque/wallet-winrate pour voir les stats complètes',
    tokens:    results,
  })
}
