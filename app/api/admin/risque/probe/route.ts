// app/api/admin/risque/probe/route.ts
// Sonde temporaire — vérifie le profil Helius + structure réelle des txs pump.fun.
// v2 : ajoute raw_tx_debug (1 tx brute complète) + 4 chemins alternatifs de parsing mint.
//
// Auth : header x-admin-key = KYMIA_ADMIN_KEY

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

const HELIUS_API_KEY = process.env.NEXT_PUBLIC_HELIEUS_KEY ?? ''
const HELIUS_BASE    = 'https://api.helius.xyz/v0'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const STABLE    = new Set([USDC_MINT, WSOL_MINT, USDT_MINT])

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

// ── Extraction du mint acheté — chemin C avec vérification de direction ────────
// BUY  = wallet est toUserAccount pour un non-stable ET envoie un stable ou SOL natif.
// VENTE = wallet est fromUserAccount pour un non-stable → ignoré.
// Multi-hop : dernier non-stable reçu = token final.

function extractMintOut(tx: any, walletAddress: string): { mint: string | null; path: string; net_debug?: Record<string, number> } {
  const transfers: any[] = tx.tokenTransfers ?? []
  if (transfers.length === 0) return { mint: null, path: 'no_transfers' }

  // Solde net par mint — même logique que watch.ts parseBuyEvent
  const netByMint = new Map<string, number>()
  for (const t of transfers) {
    if (t.toUserAccount === walletAddress && t.tokenAmount > 0) {
      netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) + t.tokenAmount)
    }
    if (t.fromUserAccount === walletAddress && t.tokenAmount > 0) {
      netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) - t.tokenAmount)
    }
  }

  // Expose net_debug pour diagnostic (tous les mints impliquant le wallet)
  const net_debug: Record<string, number> = {}
  for (const [mint, net] of netByMint) {
    net_debug[mint.slice(0, 12)] = parseFloat(net.toFixed(6))
  }

  const acquired = [...netByMint.entries()]
    .filter(([mint, net]) => !STABLE.has(mint) && net > 0)
    .sort((a, b) => b[1] - a[1])

  if (acquired.length === 0) return { mint: null, path: 'net_zero_or_sell', net_debug }

  return { mint: acquired[0][0], path: 'C:net_positive', net_debug }
}

async function probeWallet(address: string, includeRawTx: boolean) {
  const url = new URL(`${HELIUS_BASE}/addresses/${address}/transactions`)
  url.searchParams.set('api-key', HELIUS_API_KEY)
  url.searchParams.set('type',    'SWAP')
  url.searchParams.set('limit',   '10')   // réduit à 10 pour ce diagnostic

  let txs: any[]
  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'KYMIA-PROBE/1.0' },
      signal:  AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { address, error: `Helius HTTP ${res.status}: ${body.slice(0, 200)}` }
    }
    txs = await res.json()
    if (!Array.isArray(txs)) txs = []
  } catch (e: any) {
    return { address, error: `fetch error: ${e.message}` }
  }

  const credits   = txs.length
  const cutoff24h = Math.floor(Date.now() / 1000) - 86_400
  const swaps_24h = txs.filter(t => t.timestamp > cutoff24h).length

  const gaps: number[] = []
  for (let i = 0; i < txs.length - 1; i++) {
    const gapSec = txs[i].timestamp - txs[i + 1].timestamp
    if (gapSec >= 0) gaps.push(gapSec / 60)
  }
  const med = median(gaps)

  // Résultats du parsing — toutes les txs fetchées (cohérence avec distinct_mints)
  const path_results = txs.map((tx: any) => {
    const { mint, path } = extractMintOut(tx, address)
    // Détail des transfers impliquant ce wallet (pour diagnostic de direction)
    const myTransfers = (tx.tokenTransfers ?? [])
      .filter((t: any) => t.toUserAccount === address || t.fromUserAccount === address)
      .slice(0, 4)
      .map((t: any) => ({
        mint:      t.mint?.slice(0, 12),
        to_me:     t.toUserAccount === address,
        from_me:   t.fromUserAccount === address,
        amount:    t.tokenAmount,
        is_stable: STABLE.has(t.mint),
      }))
    return {
      sig:        tx.signature?.slice(0, 12),
      ts:         new Date(tx.timestamp * 1000).toISOString(),
      source:     tx.source ?? null,
      mint_found: mint,
      path_used:  path,
      has_tokenTransfers: (tx.tokenTransfers ?? []).length > 0,
      my_transfers: myTransfers,
    }
  })

  const mints = new Set(path_results.map(r => r.mint_found).filter(Boolean))

  // Première tx brute — uniquement pour le wallet demandé (le plus actif)
  let raw_tx_debug: any = undefined
  if (includeRawTx && txs.length > 0) {
    const tx = txs[0]
    // Garde uniquement les champs structurellement importants — tronque les tableaux longs
    raw_tx_debug = {
      signature:   tx.signature,
      timestamp:   tx.timestamp,
      type:        tx.type,
      source:      tx.source,
      description: tx.description,
      // Structure events
      events_keys:       Object.keys(tx.events ?? {}),
      events_swap_keys:  Object.keys(tx.events?.swap ?? {}),
      tokenOutputs:      (tx.events?.swap?.tokenOutputs ?? []).slice(0, 3),
      tokenInputs:       (tx.events?.swap?.tokenInputs  ?? []).slice(0, 3),
      nativeInput:       tx.events?.swap?.nativeInput  ?? null,
      nativeOutput:      tx.events?.swap?.nativeOutput ?? null,
      innerSwaps:        (tx.events?.swap?.innerSwaps  ?? []).slice(0, 2),
      // Top-level transfers
      tokenTransfers:    (tx.tokenTransfers ?? []).slice(0, 5),
      nativeTransfers:   (tx.nativeTransfers ?? []).slice(0, 3),
      // accountData (premiers 2 comptes, premiers 3 balances chacun)
      accountData_sample: (tx.accountData ?? []).slice(0, 2).map((acc: any) => ({
        account: acc.account,
        tokenBalanceChanges: (acc.tokenBalanceChanges ?? []).slice(0, 3),
      })),
    }
  }

  return {
    address,
    swaps_fetched:   txs.length,
    swaps_24h,
    median_gap_min:  med !== null ? parseFloat(med.toFixed(1)) : null,
    distinct_mints:  mints.size,
    credits,
    path_results,
    ...(raw_tx_debug ? { raw_tx_debug } : {}),
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!HELIUS_API_KEY) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_HELIEUS_KEY manquant' }, { status: 503 })
  }

  console.log(`[risque/probe v2] probing ${PROBE_WALLETS.length} wallets — diagnostic mode`)

  // Wallet 2 (index 2 = le plus actif, 35 swaps/24h) reçoit la tx brute complète
  const results = await Promise.all(
    PROBE_WALLETS.map((addr, i) => probeWallet(addr, i === 2))
  )

  // Synthèse des chemins qui fonctionnent
  const path_summary: Record<string, number> = {}
  for (const r of results) {
    if ('path_results' in r) {
      for (const p of (r as any).path_results) {
        path_summary[p.path_used] = (path_summary[p.path_used] ?? 0) + 1
      }
    }
  }

  console.log(`[risque/probe v2] done — path_summary=${JSON.stringify(path_summary)}`)

  return NextResponse.json({
    ok:           true,
    wallets:      results,
    path_summary,               // combien de txs résolues par chaque chemin
    diagnosis:    'Regarder path_results[].path_used pour identifier le bon chemin de parsing.',
    timestamp:    new Date().toISOString(),
  })
}
