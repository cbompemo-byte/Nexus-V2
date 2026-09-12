// lib/risque/pumpfun.ts
// Lecture du market cap d'un token pump.fun depuis sa bonding curve on-chain.
//
// Chemin primaire : lecture du compte PDA bonding curve via RPC Solana.
//   - PDA seeds : ["bonding-curve", mint_pubkey]
//   - Program   : 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
//   - Layout    : discriminator(8) + virtualTokenReserves(u64) + virtualSolReserves(u64)
//                 + realTokenReserves(u64) + realSolReserves(u64)
//                 + tokenTotalSupply(u64) + complete(bool)
//   - Prix SOL  : Jupiter Price API v2
//
// Fallback DexScreener :
//   - Si curve.complete = true  → token gradué, bonding curve inactive → DexScreener
//   - Si RPC échoue             → DexScreener
//   - Si DexScreener échoue     → null (DATA_UNAVAILABLE)

import { PublicKey }    from '@solana/web3.js'
import { getConnection } from '@/lib/solana/wallet'

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
const WSOL_MINT       = 'So11111111111111111111111111111111111111112'
const DEXSCREENER     = 'https://api.dexscreener.com'

// ── Bonding curve PDA ─────────────────────────────────────────────────────────

export function bondingCurvePda(mint: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM_ID,
  )
  return pda
}

// ── Parse du compte curve ─────────────────────────────────────────────────────
// Layout (little-endian, post discriminator de 8 octets) :
//   offset  8 : virtualTokenReserves  u64
//   offset 16 : virtualSolReserves    u64
//   offset 24 : realTokenReserves     u64
//   offset 32 : realSolReserves       u64
//   offset 40 : tokenTotalSupply      u64
//   offset 48 : complete              bool

interface CurveData {
  virtualTokenReserves: bigint   // base units (6 décimales)
  virtualSolReserves:   bigint   // lamports (9 décimales)
  tokenTotalSupply:     bigint   // base units (6 décimales)
  complete:             boolean  // true = gradué vers Raydium
}

function parseCurve(data: Buffer): CurveData {
  if (data.length < 49) throw new Error(`curve data too short (${data.length} bytes)`)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    virtualTokenReserves: view.getBigUint64(8,  true),
    virtualSolReserves:   view.getBigUint64(16, true),
    tokenTotalSupply:     view.getBigUint64(40, true),
    complete:             data[48] === 1,
  }
}

// ── Prix SOL depuis Jupiter Price API v2 ─────────────────────────────────────

async function fetchSolPriceUsd(): Promise<number> {
  const res = await fetch(
    `https://lite-api.jup.ag/price/v2?ids=${WSOL_MINT}`,
    { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(5_000) },
  )
  if (!res.ok) throw new Error(`Jupiter price HTTP ${res.status}`)
  const data  = await res.json()
  const price = data?.data?.[WSOL_MINT]?.price
  if (typeof price !== 'number' && typeof price !== 'string')
    throw new Error('SOL price absent de la réponse Jupiter')
  return Number(price)
}

// ── Fallback DexScreener ──────────────────────────────────────────────────────

interface DexScreenerData {
  priceUsd:     number
  marketCapUsd: number
}

async function dataFromDexScreener(mint: string): Promise<DexScreenerData | null> {
  try {
    const res = await fetch(`${DEXSCREENER}/latest/dex/tokens/${mint}`, {
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
    return {
      priceUsd:     parseFloat(best.priceUsd || '0'),
      marketCapUsd: best.marketCap ?? 0,
    }
  } catch {
    return null
  }
}

// Alias pour getMarketCap existant
async function mcapFromDexScreener(mint: string): Promise<number | null> {
  const d = await dataFromDexScreener(mint)
  return d?.marketCapUsd ?? null
}

// ── Point d'entrée public ─────────────────────────────────────────────────────

export interface MarketCapResult {
  usd:    number
  source: 'onchain' | 'dexscreener'
}

export async function getMarketCap(mint: string): Promise<MarketCapResult | null> {
  // ── Chemin primaire : bonding curve on-chain ─────────────────────────────
  try {
    const conn = getConnection()
    const pda  = bondingCurvePda(mint)
    const info = await conn.getAccountInfo(pda, 'confirmed')

    if (info?.data) {
      const curve = parseCurve(info.data as Buffer)

      if (curve.complete) {
        // Token gradué → pas de bonding curve active → DexScreener
        const mc = await mcapFromDexScreener(mint)
        return mc !== null ? { usd: mc, source: 'dexscreener' } : null
      }

      if (curve.virtualTokenReserves === BigInt(0)) {
        throw new Error('virtualTokenReserves = 0 — division par zéro')
      }

      const solPriceUsd = await fetchSolPriceUsd()

      // Prix = virtualSolReserves (lamports) / virtualTokenReserves (base units)
      // Ajustement décimales : sol=9, token=6
      const pricePerTokenSol =
        (Number(curve.virtualSolReserves) / 1e9) /
        (Number(curve.virtualTokenReserves) / 1e6)

      const marketCapUsd =
        pricePerTokenSol * (Number(curve.tokenTotalSupply) / 1e6) * solPriceUsd

      return { usd: marketCapUsd, source: 'onchain' }
    }

    // Compte PDA absent (token pas pump.fun ou déjà clôturé)
    console.warn(`[pumpfun] PDA absent pour ${mint.slice(0, 8)}… → fallback DexScreener`)
  } catch (e: any) {
    console.warn(`[pumpfun] RPC error ${mint.slice(0, 8)}…: ${e.message} → fallback DexScreener`)
  }

  // ── Fallback DexScreener ─────────────────────────────────────────────────
  const mc = await mcapFromDexScreener(mint)
  return mc !== null ? { usd: mc, source: 'dexscreener' } : null
}

// ── getTokenMarketData — prix + market cap en un seul appel ───────────────────
// Utilisé par le monitor (prix pour stop checks) et par checkEntry.

export interface TokenMarketData {
  priceUsd:     number
  marketCapUsd: number
  source:       'onchain' | 'dexscreener'
}

export async function getTokenMarketData(mint: string): Promise<TokenMarketData | null> {
  // ── Chemin primaire : bonding curve on-chain ─────────────────────────────
  try {
    const conn = getConnection()
    const pda  = bondingCurvePda(mint)
    const info = await conn.getAccountInfo(pda, 'confirmed')

    if (info?.data) {
      const curve = parseCurve(info.data as Buffer)

      if (curve.complete) {
        const d = await dataFromDexScreener(mint)
        return d ? { priceUsd: d.priceUsd, marketCapUsd: d.marketCapUsd, source: 'dexscreener' } : null
      }

      if (curve.virtualTokenReserves === BigInt(0)) {
        throw new Error('virtualTokenReserves = 0')
      }

      const solPriceUsd      = await fetchSolPriceUsd()
      const pricePerTokenSol =
        (Number(curve.virtualSolReserves) / 1e9) /
        (Number(curve.virtualTokenReserves) / 1e6)
      const priceUsd     = pricePerTokenSol * solPriceUsd
      const marketCapUsd = priceUsd * (Number(curve.tokenTotalSupply) / 1e6)

      return { priceUsd, marketCapUsd, source: 'onchain' }
    }

    console.warn(`[pumpfun] PDA absent pour ${mint.slice(0, 8)}… → fallback DexScreener`)
  } catch (e: any) {
    console.warn(`[pumpfun] RPC error ${mint.slice(0, 8)}…: ${e.message} → fallback DexScreener`)
  }

  // ── Fallback DexScreener ─────────────────────────────────────────────────
  const d = await dataFromDexScreener(mint)
  return d ? { priceUsd: d.priceUsd, marketCapUsd: d.marketCapUsd, source: 'dexscreener' } : null
}
