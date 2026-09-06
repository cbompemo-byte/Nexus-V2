// app/api/admin/risque/probe/route.ts
// Sonde temporaire — vérifie le profil Helius de 3 wallets pump.fun
// pour valider que le quota tient avant de construire le module Risque.
//
// Auth : header x-admin-key = KYMIA_ADMIN_KEY

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

const HELIUS_API_KEY = process.env.NEXT_PUBLIC_HELIEUS_KEY ?? ''
const HELIUS_BASE    = 'https://api.helius.xyz/v0'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const STABLE    = new Set([USDC_MINT, WSOL_MINT])

const PROBE_WALLETS = [
  'J23qr98GjGJJqKq9CBEnyRhHbmkaVxtTJNNxKu597wsA',
  '74YxQkkVCAPk4njqfwJSE6MFKcVECgZv3S4wuynnDGrD',
  '6mrqa4cDaqBCD9UrUiUyoK78e4AJ8XzRaF8uTbcuTVae',
]

function isAuthorized(req: NextRequest): boolean {
  const key = process.env.KYMIA_ADMIN_KEY
  if (!key) return false
  return req.headers.get('x-admin-key') === key
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid    = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

interface HeliusTx {
  signature:        string
  timestamp:        number   // unix seconds
  transactionError: any
  events?: {
    swap?: {
      tokenOutputs?: Array<{ mint: string }>
      tokenInputs?:  Array<{ mint: string }>
    }
  }
}

async function probeWallet(address: string): Promise<{
  address:          string
  swaps_50:         number    // total swaps dans les 50 derniers SWAP-type txs
  swaps_24h:        number    // parmi les 50, combien dans les 24 dernières heures
  median_gap_min:   number | null  // écart médian entre swaps consécutifs (min)
  distinct_mints:   number    // mints uniques (tokens achetés) dans les 50 swaps
  credits:          number
  raw_sample:       Array<{ ts: string; mint_out: string | null }>
  error?:           string
}> {
  const url = new URL(`${HELIUS_BASE}/addresses/${address}/transactions`)
  url.searchParams.set('api-key', HELIUS_API_KEY)
  url.searchParams.set('type',    'SWAP')
  url.searchParams.set('limit',   '50')

  let txs: HeliusTx[]
  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'KYMIA-PROBE/1.0' },
      signal:  AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        address, swaps_50: 0, swaps_24h: 0, median_gap_min: null,
        distinct_mints: 0, credits: 0, raw_sample: [],
        error: `Helius HTTP ${res.status}: ${body.slice(0, 200)}`,
      }
    }
    txs = await res.json()
    if (!Array.isArray(txs)) txs = []
  } catch (e: any) {
    return {
      address, swaps_50: 0, swaps_24h: 0, median_gap_min: null,
      distinct_mints: 0, credits: 0, raw_sample: [],
      error: `fetch error: ${e.message}`,
    }
  }

  const credits    = txs.length
  const cutoff24h  = Math.floor(Date.now() / 1000) - 86_400
  const swaps_24h  = txs.filter(t => t.timestamp > cutoff24h).length

  // Écarts entre swaps consécutifs (txs triées desc par timestamp)
  const gaps: number[] = []
  for (let i = 0; i < txs.length - 1; i++) {
    const gapSec = txs[i].timestamp - txs[i + 1].timestamp
    if (gapSec >= 0) gaps.push(gapSec / 60)   // en minutes
  }
  const median_gap_min = median(gaps)

  // Mints achetés (token non-stable en sortie)
  const mints = new Set<string>()
  for (const tx of txs) {
    if (tx.transactionError !== null) continue
    const outs = tx.events?.swap?.tokenOutputs ?? []
    for (const o of outs) {
      if (!STABLE.has(o.mint)) mints.add(o.mint)
    }
  }

  // Échantillon lisible pour vérification manuelle
  const raw_sample = txs.slice(0, 5).map(tx => ({
    ts:       new Date(tx.timestamp * 1000).toISOString(),
    mint_out: tx.events?.swap?.tokenOutputs?.find(o => !STABLE.has(o.mint))?.mint ?? null,
  }))

  return {
    address,
    swaps_50:       txs.length,
    swaps_24h,
    median_gap_min: median_gap_min !== null ? parseFloat(median_gap_min.toFixed(1)) : null,
    distinct_mints: mints.size,
    credits,
    raw_sample,
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!HELIUS_API_KEY) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_HELIEUS_KEY manquant' }, { status: 503 })
  }

  console.log(`[risque/probe] probing ${PROBE_WALLETS.length} wallets`)
  const results = await Promise.all(PROBE_WALLETS.map(probeWallet))

  const total_credits = results.reduce((s, r) => s + r.credits, 0)

  // Projection quota : si ces 3 wallets sont représentatifs des 18
  const avg_swaps_per_wallet_day = results
    .filter(r => !r.error)
    .reduce((s, r) => s + r.swaps_24h, 0) / results.filter(r => !r.error).length

  const projected_monthly_18 = Math.round(avg_swaps_per_wallet_day * 18 * 30)

  console.log(`[risque/probe] done — credits=${total_credits} avg_swaps_24h=${avg_swaps_per_wallet_day.toFixed(1)} projected_monthly_18=${projected_monthly_18} fits_quota=${projected_monthly_18 <= 62_000}`)

  return NextResponse.json({
    ok:          true,
    wallets:     results,
    total_probe_credits: total_credits,
    projection: {
      avg_swaps_24h_per_wallet:     parseFloat(avg_swaps_per_wallet_day.toFixed(1)),
      estimated_monthly_18_wallets: projected_monthly_18,
      quota_available:              62_000,   // 100K - 18K smart money watch - garde 20%
      fits_quota:                   projected_monthly_18 <= 62_000,
    },
    timestamp: new Date().toISOString(),
  })
}
