// app/api/admin/risque/recent-buys/route.ts
// Backfill des achats des 48 dernières heures pour tous les wallets actifs.
//
// ── Ce que fait cet endpoint ──────────────────────────────────────────────────────
//   GET /api/admin/risque/recent-buys?limit=10
//   → Prend les wallets actifs non encore backfillés (last_backfill_at IS NULL),
//     10 par lot. Pour chaque wallet :
//       1. getSignaturesForAddress (100 sigs, RPC public)
//       2. batchGetTransactions (micro-lots de 5, round-robin, backoff)
//       3. Filtre blockTime >= now - 48h
//       4. Détecte les achats (SOL perdu + token reçu)
//       5. Insère dans kymia_risque_buys avec source='BACKFILL'
//          ON CONFLICT (tx_signature) DO NOTHING
//       6. Marque last_backfill_at = now() sur le wallet
//
// ── Idempotence ──────────────────────────────────────────────────────────────────
//   ON CONFLICT sur tx_signature — relancer est sans danger.
//   last_backfill_at évite de retraiter les wallets déjà couverts.
//
// ── 0 crédit Helius ──────────────────────────────────────────────────────────────
//   Tout passe par PUBLIC_RPCS (api.mainnet-beta.solana.com, publicnode, ankr).

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'

// ── Auth ──────────────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

// ── RPC helpers ───────────────────────────────────────────────────────────────────

const PUBLIC_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana',
]

const WINDOW_MS  = 48 * 3600_000   // 48h en millisecondes
const SIG_LIMIT  = 100             // signatures récupérées par wallet

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpcPost(body: object, attempt = 0): Promise<any> {
  const url = PUBLIC_RPCS[attempt % PUBLIC_RPCS.length]
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'KYMIA/1.0' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(15_000),
    })
    if (res.status === 429) {
      if (attempt >= 4) throw new Error(`429 après ${attempt + 1} tentatives`)
      await sleep(Math.min(500 * 2 ** attempt, 4_000))
      return rpcPost(body, attempt + 1)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  } catch (e: any) {
    if (attempt < 4 && !e.message.startsWith('429')) {
      await sleep(300)
      return rpcPost(body, attempt + 1)
    }
    throw e
  }
}

async function getSignaturesForAddress(address: string, limit: number): Promise<string[]> {
  try {
    const data = await rpcPost({
      jsonrpc: '2.0', id: 1,
      method:  'getSignaturesForAddress',
      params:  [address, { limit, commitment: 'confirmed' }],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data?.result ?? []).map((s: any) => s.signature as string)
  } catch (e: any) {
    console.warn(`[recent-buys] getSignaturesForAddress ${address.slice(0, 8)}…: ${e.message}`)
    return []
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function batchGetTransactions(sigs: string[]): Promise<any[]> {
  if (sigs.length === 0) return []
  const MICRO_BATCH = 5, BATCH_GAP = 400, MAX_RETRIES = 4
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: (any | null)[] = new Array(sigs.length).fill(null)

  for (let start = 0; start < sigs.length; start += MICRO_BATCH) {
    if (start > 0) await sleep(BATCH_GAP)
    const lotIdx  = Math.floor(start / MICRO_BATCH)
    let   pending = sigs.slice(start, start + MICRO_BATCH).map((sig, i) => ({ origIdx: start + i, sig }))

    for (let attempt = 0; attempt <= MAX_RETRIES && pending.length > 0; attempt++) {
      if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 4_000))
      const rpcUrl = PUBLIC_RPCS[(lotIdx + attempt) % PUBLIC_RPCS.length]
      const req    = pending.map(({ origIdx, sig }) => ({
        jsonrpc: '2.0', id: origIdx,
        method:  'getTransaction',
        params:  [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let responses: any[] = []
      try {
        const res = await fetch(rpcUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'KYMIA/1.0' },
          body:    JSON.stringify(req),
          signal:  AbortSignal.timeout(15_000),
        })
        if (res.status === 429) continue
        if (res.ok) responses = await res.json()
      } catch { continue }

      if (!Array.isArray(responses)) continue
      const resolvedIds = new Set<number>()
      for (const resp of responses) {
        const id    = resp.id as number
        const is429 = resp.error?.code === 429
          || String(resp.error?.message ?? '').toLowerCase().includes('too many')
        if (is429) continue
        results[id] = resp
        resolvedIds.add(id)
      }
      pending = pending.filter(p => !resolvedIds.has(p.origIdx))
    }
  }
  return results.filter(r => r !== null)
}

// ── parseBuyFromTx ────────────────────────────────────────────────────────────────
// Détecte si la tx est un achat pour walletAddress :
//   - SOL perdu (> 0.01 SOL) ET token reçu  → sol buy
//   - USDC perdu (balance USDC diminue) ET token reçu → usdc buy
// Retourne null si ce n'est pas un achat.

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseBuyFromTx(txResult: any, walletAddress: string): {
  tokenMint:  string
  solAmount:  number | null
  usdcAmount: number | null
  blockTime:  number
} | null {
  if (!txResult) return null
  const blockTime = txResult.blockTime as number | null
  if (!blockTime) return null

  const meta    = txResult.meta    ?? {}
  const msg     = txResult.transaction?.message ?? {}
  const accs    = msg.accountKeys  ?? []
  const preBal  = meta.preBalances  ?? []
  const postBal = meta.postBalances ?? []
  const preTok  = (meta.preTokenBalances  ?? []) as Array<{ accountIndex: number; mint: string; uiTokenAmount: { uiAmount: number | null }; owner?: string }>
  const postTok = (meta.postTokenBalances ?? []) as Array<{ accountIndex: number; mint: string; uiTokenAmount: { uiAmount: number | null }; owner?: string }>

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walletIdx = accs.findIndex((a: any) =>
    (typeof a === 'object' ? (a.pubkey ?? '') : String(a)) === walletAddress
  )
  if (walletIdx === -1 || walletIdx >= preBal.length) return null

  // Tokens reçus par ce wallet (hors USDC) — indique l'achat d'un token
  const receivedTokenAccs = postTok.filter(tb => {
    if (tb.mint === USDC_MINT) return false
    if ((tb.owner ?? '') !== walletAddress) return false
    const pre  = preTok.find(p => p.accountIndex === tb.accountIndex)
    const preAmt  = pre?.uiTokenAmount?.uiAmount  ?? 0
    const postAmt = tb.uiTokenAmount?.uiAmount    ?? 0
    return postAmt > preAmt   // le solde a augmenté → tokens reçus
  })

  if (receivedTokenAccs.length === 0) return null

  const tokenMint = receivedTokenAccs[0].mint

  // ── SOL buy ───────────────────────────────────────────────────────────────────
  const solChange = (postBal[walletIdx] - preBal[walletIdx]) / 1e9
  if (solChange < -0.01) {
    return { tokenMint, solAmount: -solChange, usdcAmount: null, blockTime }
  }

  // ── USDC buy ──────────────────────────────────────────────────────────────────
  const preUsdc  = preTok.find(tb  => tb.mint  === USDC_MINT && (tb.owner  ?? '') === walletAddress)
  const postUsdc = postTok.find(tb => tb.mint  === USDC_MINT && (tb.owner  ?? '') === walletAddress)
  const preUsdcAmt  = preUsdc?.uiTokenAmount?.uiAmount  ?? 0
  const postUsdcAmt = postUsdc?.uiTokenAmount?.uiAmount ?? 0
  const usdcSpent   = preUsdcAmt - postUsdcAmt
  if (usdcSpent > 0.01) {
    return { tokenMint, solAmount: null, usdcAmount: usdcSpent, blockTime }
  }

  return null
}

// ── Handler GET ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }
  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  const sp    = req.nextUrl.searchParams
  const limit = Math.max(1, Math.min(20, parseInt(sp.get('limit') ?? '10', 10)))

  const windowStart = new Date(Date.now() - WINDOW_MS)

  // 1. Wallets actifs non encore backfillés (tous : manuels + DISCOVERY)
  const { data: wallets, error: walletsErr, count: totalRemaining } = await supabase
    .from('kymia_risque_wallets')
    .select('address, label', { count: 'exact' })
    .eq('active', true)
    .is('last_backfill_at', null)
    .limit(limit)

  if (walletsErr) {
    return NextResponse.json({ error: walletsErr.message }, { status: 500 })
  }

  const walletList = (wallets ?? []) as Array<{ address: string; label: string }>
  console.log(
    `[recent-buys] lot limit=${limit}` +
    ` — ${walletList.length} wallets à traiter (${totalRemaining ?? '?'} non-backfillés au total)`
  )

  // 2. Traiter chaque wallet
  const batchResults: Array<{
    address:     string
    label:       string
    sigs_fetched: number
    buys_in_window: number
    inserted:    number
    skipped:     number
  }> = []

  let totalInserted = 0

  for (const wallet of walletList) {
    console.log(`[recent-buys] ${wallet.label} (${wallet.address.slice(0, 8)}…)`)

    const sigs     = await getSignaturesForAddress(wallet.address, SIG_LIMIT)
    const txResults = await batchGetTransactions(sigs)

    const windowStartTs = Math.floor(windowStart.getTime() / 1000)

    let buysInWindow = 0
    let inserted     = 0
    let skipped      = 0

    for (const txResult of txResults) {
      const tx = txResult.result ?? txResult
      if (!tx) continue

      // Hors fenêtre 48h → skip
      if ((tx.blockTime ?? 0) < windowStartTs) continue

      const sig = txResult.id !== undefined
        ? sigs[txResult.id as number]
        : (tx.transaction?.signatures?.[0] ?? null)

      if (!sig) continue

      const buy = parseBuyFromTx(tx, wallet.address)
      if (!buy) continue

      buysInWindow++

      const { error: insertErr } = await supabase
        .from('kymia_risque_buys')
        .insert({
          token_mint:        buy.tokenMint,
          wallet_address:    wallet.address,
          wallet_label:      wallet.label,
          tx_signature:      sig,
          bought_at:         new Date(buy.blockTime * 1000).toISOString(),
          sol_amount:        buy.solAmount,
          usdc_amount:       buy.usdcAmount,
          market_cap_at_buy: null,   // pas disponible depuis le RPC public
          source:            'BACKFILL',
        })

      if (insertErr) {
        if (insertErr.code === '23505') {
          skipped++   // doublon tx_signature → déjà présent
        } else {
          console.warn(`[recent-buys] insert ${sig.slice(0, 8)}…: ${insertErr.message}`)
          skipped++
        }
      } else {
        inserted++
        totalInserted++
      }
    }

    batchResults.push({
      address:         wallet.address,
      label:           wallet.label,
      sigs_fetched:    sigs.length,
      buys_in_window:  buysInWindow,
      inserted,
      skipped,
    })

    // Marquer last_backfill_at immédiatement (ne sera plus repris au prochain lot)
    await supabase
      .from('kymia_risque_wallets')
      .update({ last_backfill_at: new Date().toISOString() })
      .eq('address', wallet.address)

    // Pause inter-wallet pour respecter les RPC publics
    await sleep(300)
  }

  // Compter les wallets restants
  const { count: stillRemaining } = await supabase
    .from('kymia_risque_wallets')
    .select('*', { count: 'exact', head: true })
    .eq('active', true)
    .is('last_backfill_at', null)

  return NextResponse.json({
    ok:              true,
    window_hours:    48,
    batch:           { limit, processed: walletList.length },
    total_inserted:  totalInserted,
    remaining:       stillRemaining ?? 0,
    next_step:       stillRemaining && stillRemaining > 0
      ? `Relancer GET /api/admin/risque/recent-buys?limit=${limit} (${stillRemaining} wallets restants)`
      : 'Backfill terminé — les convergences sont visibles dans kymia_risque_buys (source=BACKFILL)',
    wallets:         batchResults,
  })
}
