// app/api/admin/risque/debug-curve/route.ts
// Diagnostic de la lecture bonding curve pump.fun pour un mint donné.
//
// Usage :
//   GET /api/admin/risque/debug-curve?mint=<mint_address>
//   Header : x-admin-key: <KYMIA_ADMIN_KEY>
//
// Retourne le détail complet du chemin getTokenMarketData :
//   - pda : adresse PDA calculée
//   - account_exists : true/false (getAccountInfo null ou non)
//   - data_length : taille du buffer (null si compte absent)
//   - parse_ok / parse_error : résultat de parseCurve
//   - curve_complete : true = gradué → fallback DexScreener
//   - onchain_result : prix + mcap si lecture réussie
//   - dexscreener_result : prix + mcap si fallback DexScreener
//   - final_source : 'onchain' | 'dexscreener' | 'UNAVAILABLE'
//
// Permet de diagnostiquer pourquoi mcap_source n'est jamais 'onchain'.

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { PublicKey }                  from '@solana/web3.js'
import { getConnection }              from '@/lib/solana/wallet'
import { bondingCurvePda }            from '@/lib/risque/pumpfun'

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
const WSOL_MINT       = 'So11111111111111111111111111111111111111112'

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const mint = req.nextUrl.searchParams.get('mint')
  if (!mint) {
    return NextResponse.json({ error: 'mint manquant' }, { status: 400 })
  }

  const result: Record<string, unknown> = { mint }

  // ── 1. PDA ────────────────────────────────────────────────────────────────
  let pda: PublicKey
  try {
    pda = bondingCurvePda(mint)
    result.pda = pda.toBase58()
  } catch (e: any) {
    result.pda_error = e.message
    return NextResponse.json(result)
  }

  // ── 2. getAccountInfo ─────────────────────────────────────────────────────
  let info: Awaited<ReturnType<ReturnType<typeof getConnection>['getAccountInfo']>>
  try {
    const conn = getConnection()
    info = await conn.getAccountInfo(pda, 'confirmed')
  } catch (e: any) {
    result.rpc_error  = e.message
    result.final_source = 'UNAVAILABLE'
    return NextResponse.json(result)
  }

  if (!info || !info.data) {
    result.account_exists = false
    result.data_length    = null
    result.note           = 'PDA absent — token non pump.fun, gradué (compte fermé), ou program ID incorrect'
    // Essayer quand même DexScreener
    const dex = await fetchDexScreener(mint)
    result.dexscreener_result = dex
    result.final_source       = dex ? 'dexscreener' : 'UNAVAILABLE'
    return NextResponse.json(result)
  }

  result.account_exists = true
  result.data_length    = (info.data as Buffer).length
  result.owner          = info.owner.toBase58()
  result.owner_is_pump  = info.owner.toBase58() === PUMP_PROGRAM_ID.toBase58()

  // ── 3. parseCurve ─────────────────────────────────────────────────────────
  let curve: {
    virtualTokenReserves: string
    virtualSolReserves:   string
    tokenTotalSupply:     string
    complete:             boolean
  } | null = null
  let parseErr: string | null = null

  try {
    const data = info.data as Buffer
    if (data.length < 49) {
      throw new Error(`buffer trop court: ${data.length} bytes (min 49)`)
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    curve = {
      virtualTokenReserves: view.getBigUint64(8,  true).toString(),
      virtualSolReserves:   view.getBigUint64(16, true).toString(),
      tokenTotalSupply:     view.getBigUint64(40, true).toString(),
      complete:             data[48] === 1,
    }
    result.parse_ok    = true
    result.curve       = curve
  } catch (e: any) {
    parseErr = e.message
    result.parse_ok    = false
    result.parse_error = parseErr
    // Octets bruts pour debug
    result.data_hex_first64 = (info.data as Buffer).slice(0, 64).toString('hex')
  }

  if (!curve) {
    // Parse failed → fallback DexScreener
    const dex = await fetchDexScreener(mint)
    result.dexscreener_result = dex
    result.final_source       = dex ? 'dexscreener' : 'UNAVAILABLE'
    return NextResponse.json(result)
  }

  if (curve.complete) {
    result.curve_complete = true
    result.note = 'Token gradué — bonding curve inactive, lecture DexScreener'
    const dex = await fetchDexScreener(mint)
    result.dexscreener_result = dex
    result.final_source       = dex ? 'dexscreener' : 'UNAVAILABLE'
    return NextResponse.json(result)
  }

  // ── 4. Lecture prix on-chain ─────────────────────────────────────────────
  result.curve_complete = false
  try {
    const solPrice = await fetchSolPrice()
    result.sol_price_usd = solPrice

    const vSol   = Number(BigInt(curve.virtualSolReserves))   / 1e9
    const vTok   = Number(BigInt(curve.virtualTokenReserves)) / 1e6
    const supply = Number(BigInt(curve.tokenTotalSupply))     / 1e6

    if (vTok === 0) {
      result.parse_error = 'virtualTokenReserves = 0 (division par zéro)'
      result.final_source = 'UNAVAILABLE'
      return NextResponse.json(result)
    }

    const pricePerTokenSol = vSol / vTok
    const priceUsd         = pricePerTokenSol * solPrice
    const marketCapUsd     = priceUsd * supply

    result.onchain_result = { priceUsd, marketCapUsd, source: 'onchain' }
    result.final_source   = 'onchain'
  } catch (e: any) {
    result.onchain_error = e.message
    const dex = await fetchDexScreener(mint)
    result.dexscreener_result = dex
    result.final_source       = dex ? 'dexscreener' : 'UNAVAILABLE'
  }

  return NextResponse.json(result)
}

// ── Helpers locaux (évite d'importer pumpfun.ts — garde le diagnostic isolé) ──

async function fetchSolPrice(): Promise<number> {
  const res = await fetch(
    `https://lite-api.jup.ag/price/v2?ids=${WSOL_MINT}`,
    { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(5_000) },
  )
  if (!res.ok) throw new Error(`Jupiter HTTP ${res.status}`)
  const data  = await res.json()
  const price = data?.data?.[WSOL_MINT]?.price
  if (typeof price !== 'number' && typeof price !== 'string')
    throw new Error('SOL price absent de Jupiter')
  return Number(price)
}

async function fetchDexScreener(mint: string): Promise<{ priceUsd: number; marketCapUsd: number } | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      headers: { 'User-Agent': 'KYMIA/1.0' },
      signal:  AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const data  = await res.json()
    const pairs = (data.pairs || []) as Array<{
      priceUsd?:  string
      marketCap?: number
      liquidity?: { usd: number }
    }>
    const best = pairs
      .filter(p => (p.marketCap ?? 0) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
    if (!best) return null
    return { priceUsd: parseFloat(best.priceUsd || '0'), marketCapUsd: best.marketCap ?? 0 }
  } catch {
    return null
  }
}
