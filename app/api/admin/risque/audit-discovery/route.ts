// app/api/admin/risque/audit-discovery/route.ts
// Audit des wallets DISCOVERY — analyse RPC publique (0 crédit Helius).
//
// ── Ce que fait cet endpoint ──────────────────────────────────────────────────────
//   GET /api/admin/risque/audit-discovery
//   → Lit tous les wallets source='DISCOVERY' AND active=true depuis kymia_risque_wallets.
//   → Pour chaque wallet : récupère les 30 dernières signatures via getSignaturesForAddress,
//     puis parse chaque tx via batchGetTransactions + analyzeWalletTx.
//   → Calcule des stats par wallet : fréquence, diversité de tokens, mm_buy_pct…
//   → Classifie : BOT | SUSPECT_MM | INACTIVE | NORMAL
//   → Auto-désactive (active=false) les wallets BOT et SUSPECT_MM.
//   → Retourne un rapport complet avec summary et next_step.
//
// ── Aucun crédit Helius consommé ─────────────────────────────────────────────────
//   Toutes les requêtes passent par PUBLIC_RPCS (api.mainnet-beta.solana.com,
//   publicnode.com, ankr.com/solana). Round-robin + backoff exponentiel sur 429.
//
// ── Après usage ──────────────────────────────────────────────────────────────────
//   Relancer POST /api/admin/risque/sync-webhook pour synchroniser le webhook Helius
//   suite aux wallets désactivés.

export const dynamic    = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'

// ── Auth ──────────────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

// ── RPC helpers (public, 0 crédit Helius) ────────────────────────────────────────

const PUBLIC_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana',
]

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function maskRpcUrl(url: string): string {
  try { return new URL(url).hostname } catch { return 'unknown' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpcPost(body: object, attempt = 0): Promise<any> {
  const url = PUBLIC_RPCS[attempt % PUBLIC_RPCS.length]
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'KYMIA/1.0' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 429) {
      if (attempt >= 4) throw new Error(`429 après ${attempt+1} tentatives`)
      await sleep(Math.min(500 * 2**attempt, 4_000))
      return rpcPost(body, attempt + 1)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  } catch (e: any) {
    if (attempt < 4 && !e.message.startsWith('429')) { await sleep(300); return rpcPost(body, attempt+1) }
    throw e
  }
}

async function getSignaturesForAddress(address: string, limit = 1000): Promise<string[]> {
  try {
    const data = await rpcPost({ jsonrpc:'2.0', id:1, method:'getSignaturesForAddress', params:[address,{limit, commitment:'confirmed'}] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data?.result ?? []).map((s: any) => s.signature as string)
  } catch (e: any) {
    console.warn(`[audit-discovery] getSignaturesForAddress ${address.slice(0,8)}…: ${e.message}`)
    return []
  }
}

// Micro-batches of 5, 400ms gap, round-robin RPCs, retry per-response 429
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function batchGetTransactions(sigs: string[]): Promise<any[]> {
  if (sigs.length === 0) return []
  const MICRO_BATCH = 5, BATCH_GAP = 400, MAX_RETRIES = 4
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: (any|null)[] = new Array(sigs.length).fill(null)
  for (let start = 0; start < sigs.length; start += MICRO_BATCH) {
    if (start > 0) await sleep(BATCH_GAP)
    const lotIdx = Math.floor(start / MICRO_BATCH)
    let pending = sigs.slice(start, start+MICRO_BATCH).map((sig,i) => ({ origIdx:start+i, sig }))
    for (let attempt = 0; attempt <= MAX_RETRIES && pending.length > 0; attempt++) {
      if (attempt > 0) { await sleep(Math.min(500*2**(attempt-1), 4_000)) }
      const rpcUrl = PUBLIC_RPCS[(lotIdx + attempt) % PUBLIC_RPCS.length]
      const req = pending.map(({origIdx,sig}) => ({ jsonrpc:'2.0', id:origIdx, method:'getTransaction', params:[sig,{encoding:'jsonParsed',maxSupportedTransactionVersion:0}] }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let responses: any[] = []
      try {
        const res = await fetch(rpcUrl, { method:'POST', headers:{'Content-Type':'application/json','User-Agent':'KYMIA/1.0'}, body:JSON.stringify(req), signal:AbortSignal.timeout(15_000) })
        if (res.status === 429) continue
        if (res.ok) responses = await res.json()
      } catch { continue }
      if (!Array.isArray(responses)) continue
      const resolvedIds = new Set<number>()
      for (const resp of responses) {
        const id = resp.id as number
        const is429 = resp.error?.code === 429 || String(resp.error?.message??'').toLowerCase().includes('too many')
        if (is429) continue
        results[id] = resp; resolvedIds.add(id)
      }
      pending = pending.filter(p => !resolvedIds.has(p.origIdx))
    }
  }
  return results.filter(r => r !== null)
}

// ── analyzeWalletTx ───────────────────────────────────────────────────────────────
// Retourne { isBuy, tokenMint?, solSpent?, blockTime? }.
// Trouve le wallet à n'importe quel index dans accountKeys (pas seulement [0]).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function analyzeWalletTx(txResult: any, walletAddress: string): {
  isBuy: boolean
  tokenMint?: string | null
  solSpent?: number
  blockTime?: number | null
} {
  if (!txResult) return { isBuy: false }
  const meta    = txResult.meta ?? {}
  const msg     = txResult.transaction?.message ?? {}
  const accs    = msg.accountKeys ?? []
  const preBal  = meta.preBalances  ?? []
  const postBal = meta.postBalances ?? []
  const postTok = meta.postTokenBalances ?? []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walletIdx = accs.findIndex((a: any) =>
    (typeof a === 'object' ? (a.pubkey ?? '') : String(a)) === walletAddress
  )
  if (walletIdx === -1 || walletIdx >= preBal.length) return { isBuy: false }

  const solChange = (postBal[walletIdx] - preBal[walletIdx]) / 1e9
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokenAccs = postTok.filter((tb: any) => tb.owner === walletAddress)
  const gotTokens = tokenAccs.length > 0

  if (solChange < -0.01 && gotTokens) {
    return {
      isBuy:      true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tokenMint:  (tokenAccs[0] as any)?.mint ?? null,
      solSpent:   -solChange,
      blockTime:  txResult.blockTime ?? null,
    }
  }
  return { isBuy: false }
}

// ── classifyDiscoveryWallet ───────────────────────────────────────────────────────

type WalletClassification = 'BOT' | 'SUSPECT_MM' | 'INACTIVE' | 'NORMAL'

function classifyDiscoveryWallet(stats: {
  total_buys:        number
  distinct_tokens:   number
  mm_buy_pct:        number
  tx_freq_per_hour:  number | null
}): WalletClassification {
  if (stats.total_buys === 0) return 'INACTIVE'
  // BOT prend priorité sur SUSPECT_MM
  const isBot = (stats.tx_freq_per_hour !== null && stats.tx_freq_per_hour > 30)
    || (stats.distinct_tokens >= 10 && stats.distinct_tokens === stats.total_buys)
  if (isBot) return 'BOT'
  if (stats.mm_buy_pct >= 30) return 'SUSPECT_MM'
  return 'NORMAL'
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

  // 1. Charger les wallets DISCOVERY actifs
  const { data: wallets, error: walletsErr } = await supabase
    .from('kymia_risque_wallets')
    .select('address, label')
    .eq('source', 'DISCOVERY')
    .eq('active', true)

  if (walletsErr) {
    return NextResponse.json({ error: walletsErr.message }, { status: 500 })
  }

  const walletList = (wallets ?? []) as Array<{ address: string; label: string }>
  console.log(`[audit-discovery] ${walletList.length} wallets DISCOVERY actifs à auditer`)

  // 2. Auditer chaque wallet séquentiellement
  const auditResults: Array<{
    address:          string
    label:            string
    total_sigs:       number
    total_buys:       number
    distinct_tokens:  number
    mm_buy_pct:       number
    avg_sol_per_buy:  number | null
    span_hours:       number | null
    tx_freq_per_hour: number | null
    first_seen:       string | null
    last_seen:        string | null
    classification:   WalletClassification
    note:             string
    still_active:     boolean
  }> = []

  for (const wallet of walletList) {
    console.log(`[audit-discovery] audit ${wallet.label} (${wallet.address.slice(0,8)}…)`)

    // 30 sigs les plus récentes (déjà newest-first depuis le RPC)
    const sigs = await getSignaturesForAddress(wallet.address, 30)

    const txResults = await batchGetTransactions(sigs)

    // Parser les achats
    const buys: Array<{ tokenMint: string | null; solSpent: number; blockTime: number }> = []
    for (const txResult of txResults) {
      const parsed = analyzeWalletTx(txResult.result ?? txResult, wallet.address)
      if (parsed.isBuy && parsed.blockTime != null) {
        buys.push({
          tokenMint: parsed.tokenMint ?? null,
          solSpent:  parsed.solSpent  ?? 0,
          blockTime: parsed.blockTime,
        })
      }
    }

    // Stats
    const total_sigs  = sigs.length
    const total_buys  = buys.length

    // Tokens uniques achetés
    const mintSet = new Set(buys.map(b => b.tokenMint).filter(Boolean))
    const distinct_tokens = mintSet.size

    // mm_buy_pct : % achats sur tokens achetés > 5 fois
    const mintBuyCount = new Map<string, number>()
    for (const b of buys) {
      if (b.tokenMint) mintBuyCount.set(b.tokenMint, (mintBuyCount.get(b.tokenMint) ?? 0) + 1)
    }
    const mmMints    = new Set([...mintBuyCount.entries()].filter(([, n]) => n > 5).map(([m]) => m))
    const mmBuys     = buys.filter(b => b.tokenMint && mmMints.has(b.tokenMint)).length
    const mm_buy_pct = total_buys > 0 ? parseFloat(((mmBuys / total_buys) * 100).toFixed(1)) : 0

    // avg_sol_per_buy
    const avg_sol_per_buy = total_buys > 0
      ? parseFloat((buys.reduce((s, b) => s + b.solSpent, 0) / total_buys).toFixed(4))
      : null

    // span_hours (max blockTime - min blockTime)
    let span_hours: number | null = null
    if (buys.length >= 2) {
      const times     = buys.map(b => b.blockTime)
      const minTime   = Math.min(...times)
      const maxTime   = Math.max(...times)
      span_hours      = parseFloat(((maxTime - minTime) / 3600).toFixed(2))
    }

    // tx_freq_per_hour
    const tx_freq_per_hour = total_buys > 0
      ? parseFloat((total_buys / Math.max(span_hours ?? 0, 0.1)).toFixed(2))
      : null

    // first_seen / last_seen
    let first_seen: string | null = null
    let last_seen:  string | null = null
    if (buys.length > 0) {
      const times   = buys.map(b => b.blockTime)
      first_seen    = new Date(Math.min(...times) * 1000).toISOString()
      last_seen     = new Date(Math.max(...times) * 1000).toISOString()
    }

    const statsForClassify = { total_buys, distinct_tokens, mm_buy_pct, tx_freq_per_hour }
    const classification   = classifyDiscoveryWallet(statsForClassify)

    // Note lisible
    let note: string
    if (classification === 'INACTIVE') {
      note = `Aucun achat identifié dans les ${total_sigs} dernières txs`
    } else if (classification === 'BOT') {
      const reasons: string[] = []
      if (tx_freq_per_hour !== null && tx_freq_per_hour > 30)
        reasons.push(`freq ${tx_freq_per_hour.toFixed(1)}/h > 30`)
      if (distinct_tokens >= 10 && distinct_tokens === total_buys)
        reasons.push(`${distinct_tokens} tokens distincts = ${total_buys} achats (1 achat par token)`)
      note = `BOT détecté — ${reasons.join(' | ')}`
    } else if (classification === 'SUSPECT_MM') {
      note = `SUSPECT_MM — ${mm_buy_pct}% des achats sur tokens achetés >5 fois`
    } else {
      note = `${total_buys} achats, ${distinct_tokens} tokens distincts, freq ${tx_freq_per_hour?.toFixed(1) ?? '?'}/h`
    }

    auditResults.push({
      address:          wallet.address,
      label:            wallet.label,
      total_sigs,
      total_buys,
      distinct_tokens,
      mm_buy_pct,
      avg_sol_per_buy,
      span_hours,
      tx_freq_per_hour,
      first_seen,
      last_seen,
      classification,
      note,
      still_active: true,  // mis à jour ci-dessous après désactivation
    })

    // Pause inter-wallet
    await sleep(200)
  }

  // 3. Désactiver les wallets BOT ou SUSPECT_MM
  const toDeactivate = auditResults
    .filter(w => w.classification === 'BOT' || w.classification === 'SUSPECT_MM')
    .map(w => w.address)

  if (toDeactivate.length > 0) {
    const { error: deactivateErr } = await supabase
      .from('kymia_risque_wallets')
      .update({ active: false })
      .in('address', toDeactivate)

    if (deactivateErr) {
      console.error(`[audit-discovery] erreur désactivation: ${deactivateErr.message}`)
    } else {
      console.log(`[audit-discovery] ${toDeactivate.length} wallets désactivés (BOT/SUSPECT_MM)`)
      // Marquer still_active=false dans le rapport
      for (const r of auditResults) {
        if (toDeactivate.includes(r.address)) r.still_active = false
      }
    }
  }

  // 4. Summary
  const summary: Record<WalletClassification, number> = { BOT: 0, SUSPECT_MM: 0, NORMAL: 0, INACTIVE: 0 }
  for (const r of auditResults) summary[r.classification]++

  return NextResponse.json({
    ok:          true,
    total:       walletList.length,
    deactivated: toDeactivate.length,
    summary,
    wallets:     auditResults,
    next_step:   'POST /api/admin/risque/sync-webhook pour synchroniser le webhook Helius',
  })
}
