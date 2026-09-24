// app/api/admin/risque/discover-wallets/route.ts
// Découverte de wallets alpha via rétro-ingénierie de tokens gagnants.
//
// ── Phase 1 — Découverte tokens (DexScreener, 0 crédit Helius) ──────────────────
//   GET /api/admin/risque/discover-wallets
//   GET /api/admin/risque/discover-wallets?tokens=mint1,mint2,...  (mints explicites)
//   → Retourne tokens qualifiés + estimation coût. Ne consomme 0 crédit Helius.
//
// ── Phase 2 — Extraction premiers acheteurs (RPC Solana, 0 crédit Helius) ────────
//   GET /api/admin/risque/discover-wallets?run=true
//   → Utilise le RPC Solana standard pour extraire les premiers acheteurs.
//   → 2 appels RPC par token : getSignaturesForAddress + batch getTransaction.
//   → Retourne candidats à valider (ne touche pas kymia_risque_wallets).
//
// ── Phase 3 — Insertion après validation manuelle ────────────────────────────────
//   POST /api/admin/risque/discover-wallets
//   Body : { wallets: [{ address: "...", label: "..." }] }
//   → Insère les wallets approuvés. Appeler ensuite POST sync-webhook.
//
// ── Paramètres (kymia_risque_settings, modifiables sans redéploiement) ───────────
//   discover_min_gain_pct     (défaut 200) — hausse h24 minimale
//   discover_min_gain_h6_pct  (défaut 80)  — OU hausse h6 minimale (proxy 7j)
//   discover_min_mcap_usd     (défaut 50000)
//   discover_max_mcap_usd     (défaut 5000000)
//   discover_allowed_dexids   (défaut ["pumpfun","pumpswap","raydium"])
//   discover_max_pair_age_days (défaut 30) — pairCreatedAt max en jours (0 = désactivé)
//   discover_min_wins         (défaut 2)  — min gagnants pour être candidat
//   discover_early_tx_count   (défaut 30) — premières txs à analyser par token
//   discover_min_entry_rank   (défaut 15) — filtre qualité si min_wins=1 : rang moyen ≤ N
//
// ── Sources DexScreener (gratuites, 0 crédit Helius) ────────────────────────────
//   /token-boosts/top/v1      — top boosts (tokens avec budget promo)
//   /token-boosts/latest/v1   — boosts récents
//   /token-profiles/latest/v1 — profils récents toutes plateformes
//   /latest/dex/search?q=...  — 10 keywords × 30 paires (cat, dog, pepe…)
//   → ~400 mints Solana uniques avant filtrage
//
// ── Extraction acheteurs (RPC Solana public) ─────────────────────────────────────
//   getSignaturesForAddress(bondingCurvePDA) → 1 appel RPC
//   batch getTransaction(30 sigs)            → 1 appel RPC batch
//   → 2 appels RPC par token, ~700ms/token, 0 crédit Helius
//   → Acheteur = signer[0] qui perd > 0.01 SOL ET reçoit des tokens
//
// ── Critère min_wins adaptatif ───────────────────────────────────────────────────
//   tokens_qualifiés ≥ 10  → min_wins (défaut 2)
//   tokens_qualifiés < 10  → 1 + avg_entry_rank ≤ discover_min_entry_rank

export const dynamic    = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { bondingCurvePda }           from '@/lib/risque/pumpfun'

const DEXSCREENER = 'https://api.dexscreener.com'

// RPCs publics gratuits — utilisés exclusivement dans discover-wallets
// (évite SOLANA_RPC_URL qui pointe vers Helius et déclenche des 429)
// Round-robin lot par lot pour répartir la charge.
const PUBLIC_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana',
]

// Keywords pour DexScreener search — termes populaires des meme coins Solana
const SEARCH_KEYWORDS = [
  'cat', 'dog', 'pepe', 'ai', 'trump',
  'chad', 'giga', 'ape', 'frog', 'meme',
]

// Taille des batches pour l'appel DexScreener /tokens/{...} (max 30 par appel)
const DEX_BATCH_SIZE = 20

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

// ── Settings discover (séparés de RisqueSettings, lu depuis Supabase) ────────────

interface DiscoverSettings {
  minGainPct:      number   // hausse h24 minimale
  minGainH6Pct:    number   // OU hausse h6 minimale
  minMcapUsd:      number
  maxMcapUsd:      number
  allowedDexIds:   string[]
  maxPairAgeDays:  number   // 0 = pas de filtre âge
  minWins:         number
  earlyTxCount:    number
  minEntryRank:    number   // filtre qualité si min_wins adaptatif = 1
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadDiscoverSettings(supabase: any): Promise<DiscoverSettings> {
  const { data } = await supabase.from('kymia_risque_settings').select('key, value')
  const map = new Map<string, unknown>((data ?? []).map((r: any) => [r.key as string, r.value]))

  const num = (key: string, fallback: number) => {
    const v = map.get(key); return v !== undefined ? Number(v) : fallback
  }

  let allowedDexIds: string[] = ['pumpfun', 'pumpswap', 'raydium']
  const rawDex = map.get('discover_allowed_dexids')
  if (Array.isArray(rawDex)) allowedDexIds = rawDex.map(String)
  else if (typeof rawDex === 'string') allowedDexIds = rawDex.split(',').map(s => s.trim())

  return {
    minGainPct:    num('discover_min_gain_pct',      200),
    minGainH6Pct:  num('discover_min_gain_h6_pct',   80),
    minMcapUsd:    num('discover_min_mcap_usd',      50_000),
    maxMcapUsd:    num('discover_max_mcap_usd',   5_000_000),
    allowedDexIds,
    maxPairAgeDays: num('discover_max_pair_age_days', 30),
    minWins:        num('discover_min_wins',            2),
    earlyTxCount:   num('discover_early_tx_count',     30),
    minEntryRank:   num('discover_min_entry_rank',     15),
  }
}

// ── DexScreener : collecte multi-sources ─────────────────────────────────────────

interface DexPair {
  chainId:       string
  dexId:         string
  baseToken:     { address: string; symbol: string; name: string }
  priceChange?:  { h24?: number; h6?: number; h1?: number }
  liquidity?:    { usd: number }
  pairCreatedAt?: number
  marketCap?:    number
  fdv?:          number
}

async function dexGet(path: string): Promise<any> {
  try {
    const res = await fetch(`${DEXSCREENER}${path}`, {
      headers: { 'User-Agent': 'KYMIA/1.0' },
      signal:  AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

// Collecte ~400 mints Solana uniques depuis 4 sources DexScreener
async function collectSolanaMints(): Promise<string[]> {
  const mints = new Set<string>()

  // Source 1 : top boosts
  const topBoosts = await dexGet('/token-boosts/top/v1')
  for (const t of (Array.isArray(topBoosts) ? topBoosts : [])) {
    if (t.chainId === 'solana' && t.tokenAddress) mints.add(t.tokenAddress)
  }

  // Source 2 : boosts récents
  await new Promise(r => setTimeout(r, 150))
  const latestBoosts = await dexGet('/token-boosts/latest/v1')
  for (const t of (Array.isArray(latestBoosts) ? latestBoosts : [])) {
    if (t.chainId === 'solana' && t.tokenAddress) mints.add(t.tokenAddress)
  }

  // Source 3 : profils récents (couvre pumpswap/raydium en plus de pumpfun)
  await new Promise(r => setTimeout(r, 150))
  const profiles = await dexGet('/token-profiles/latest/v1')
  for (const t of (Array.isArray(profiles) ? profiles : [])) {
    if (t.chainId === 'solana' && t.tokenAddress) mints.add(t.tokenAddress)
  }

  // Source 4 : recherche par keyword (10 × 30 paires max = ~200 tokens)
  for (const kw of SEARCH_KEYWORDS) {
    await new Promise(r => setTimeout(r, 150))
    const data = await dexGet(`/latest/dex/search?q=${kw}`)
    for (const p of (data?.pairs ?? []) as DexPair[]) {
      if (p.chainId === 'solana' && p.baseToken?.address) mints.add(p.baseToken.address)
    }
  }

  return [...mints]
}

// Récupère les données de paires pour un batch de mints (max DEX_BATCH_SIZE par appel)
async function fetchPairsBatch(mints: string[]): Promise<DexPair[]> {
  const data = await dexGet(`/latest/dex/tokens/${mints.join(',')}`)
  return (data?.pairs ?? []) as DexPair[]
}

// ── RPC Solana : couche bas-niveau (public, sans Helius) ─────────────────────────
//
// Toutes les fonctions ci-dessous appellent PUBLIC_RPCS directement via fetch().
// On n'utilise PAS getConnection() — qui pointerait vers SOLANA_RPC_URL (Helius).
//
// Stratégie par token :
//   1. getSignaturesForAddress(bondingCurvePDA)   — 1 appel RPC
//      → fallback sur mint address pour tokens graduées (pumpswap/raydium)
//   2. batch getTransaction(N sigs)               — 1 appel RPC batch
//   3. Acheteur = signer[0] perdant > 0.01 SOL + recevant des tokens
//
// Rate limiting : retry avec backoff exponentiel sur 429, rotation sur fallback RPC.

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// Masque les query params d'une URL (ex: api-key=xxx) pour les logs/debug
function maskRpcUrl(url: string): string {
  try { return new URL(url).hostname } catch { return 'unknown' }
}

// Appel RPC unique avec retry + backoff sur 429, rotation entre PUBLIC_RPCS
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
      if (attempt >= 4) throw new Error(`429 après ${attempt + 1} tentatives (${maskRpcUrl(url)})`)
      const wait = Math.min(500 * 2 ** attempt, 4_000)
      console.warn(`[discover-wallets] 429 sur ${maskRpcUrl(url)} — retry dans ${wait}ms (tentative ${attempt + 1})`)
      await sleep(wait)
      return rpcPost(body, attempt + 1)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} (${maskRpcUrl(url)})`)
    return res.json()
  } catch (e: any) {
    if (attempt < 4 && !e.message.startsWith('429')) {
      await sleep(300)
      return rpcPost(body, attempt + 1)
    }
    throw e
  }
}

async function getSignaturesForAddress(address: string, limit = 1000): Promise<string[]> {
  try {
    const data = await rpcPost({
      jsonrpc: '2.0', id: 1,
      method:  'getSignaturesForAddress',
      params:  [address, { limit, commitment: 'confirmed' }],
    })
    return (data?.result ?? []).map((s: any) => s.signature as string)
  } catch (e: any) {
    console.warn(`[discover-wallets] getSignaturesForAddress ${address.slice(0, 8)}…: ${e.message}`)
    return []
  }
}

// Récupère N transactions en micro-lots de MICRO_BATCH sigs.
// — Round-robin entre PUBLIC_RPCS d'un lot à l'autre
// — Retry individuel par réponse sur 429 (pas seulement sur l'appel global)
// — Backoff exponentiel : 500ms → 1s → 2s → 4s (max MAX_RETRIES tentatives)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function batchGetTransactions(sigs: string[]): Promise<any[]> {
  if (sigs.length === 0) return []

  const MICRO_BATCH = 5
  const BATCH_GAP   = 400   // ms entre micro-lots
  const MAX_RETRIES = 4

  // Résultats indexés par position originale dans sigs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: (any | null)[] = new Array(sigs.length).fill(null)

  for (let start = 0; start < sigs.length; start += MICRO_BATCH) {
    if (start > 0) await sleep(BATCH_GAP)

    const lotIdx = Math.floor(start / MICRO_BATCH)

    // pending = items encore à récupérer dans ce micro-lot
    let pending = sigs
      .slice(start, start + MICRO_BATCH)
      .map((sig, i) => ({ origIdx: start + i, sig }))

    for (let attempt = 0; attempt <= MAX_RETRIES && pending.length > 0; attempt++) {
      if (attempt > 0) {
        const wait = Math.min(500 * 2 ** (attempt - 1), 4_000)
        console.warn(
          `[discover-wallets] retry ${attempt}/${MAX_RETRIES}` +
          ` lot ${lotIdx} — ${pending.length} txs (${wait}ms)`
        )
        await sleep(wait)
      }

      // Round-robin : lot 0 → rpc[0], lot 1 → rpc[1], retry → rpc suivant
      const rpcUrl = PUBLIC_RPCS[(lotIdx + attempt) % PUBLIC_RPCS.length]

      const req = pending.map(({ origIdx, sig }) => ({
        jsonrpc: '2.0', id: origIdx,
        method:  'getTransaction',
        params:  [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      }))

      let responses: any[] = []
      try {
        const res = await fetch(rpcUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'KYMIA/1.0' },
          body:    JSON.stringify(req),
          signal:  AbortSignal.timeout(15_000),
        })
        if (res.status === 429) continue  // HTTP-level 429 → retry tout le micro-lot
        if (res.ok) responses = await res.json()
      } catch {
        continue  // erreur réseau → retry
      }

      if (!Array.isArray(responses)) continue

      // Réponses résolues = tout sauf 429 individuel
      const resolvedIds = new Set<number>()
      for (const resp of responses) {
        const id    = resp.id as number
        const is429 = resp.error?.code === 429 ||
          String(resp.error?.message ?? '').toLowerCase().includes('too many')
        if (is429) continue  // garder dans pending pour retry
        results[id] = resp
        resolvedIds.add(id)
      }

      pending = pending.filter(p => !resolvedIds.has(p.origIdx))
    }
  }

  return results.filter(r => r !== null)
}

// Extrait l'acheteur depuis une tx jsonParsed.
// Retourne null si la tx n'est pas un achat (création, frais, admin…).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBuyer(txResult: any): string | null {
  if (!txResult) return null
  const meta  = txResult.meta ?? {}
  const msg   = txResult.transaction?.message ?? {}
  const accs  = msg.accountKeys ?? []
  const preBal  = meta.preBalances  ?? []
  const postBal = meta.postBalances ?? []
  const postTok = meta.postTokenBalances ?? []

  if (!accs.length || !preBal.length || !postBal.length) return null

  const signer   = accs[0]
  const signerPk = typeof signer === 'object' ? (signer as any).pubkey : String(signer)
  const solChange = (postBal[0] - preBal[0]) / 1e9

  // Vérifie que le signer reçoit des tokens (est propriétaire d'un token account post-tx)
  const gotTokens = postTok.some((tb: any) => tb.owner === signerPk)

  if (solChange < -0.01 && gotTokens) return signerPk
  return null
}

async function getEarlyBuyers(
  mint:         string,
  earlyTxCount: number,
): Promise<{ address: string; txIndex: number }[]> {
  // Bonding curve PDA (pump.fun non-gradué)
  let sigs: string[] = []
  try {
    const pdaStr = bondingCurvePda(mint).toBase58()
    sigs = await getSignaturesForAddress(pdaStr)
  } catch { /* pas pump.fun ou PDA introuvable → fallback */ }

  // Fallback : mint address (pumpswap, raydium, tokens graduées)
  if (sigs.length === 0) {
    sigs = await getSignaturesForAddress(mint)
  }

  if (sigs.length === 0) return []

  // Dernières signatures = plus anciennes = premiers acheteurs (ordre chrono)
  const earlySigs = sigs.slice(-Math.min(earlyTxCount, sigs.length)).reverse()

  // Batch getTransaction — 1 seul appel HTTP pour toutes les sigs
  const txResults = await batchGetTransactions(earlySigs)

  const buyers: { address: string; txIndex: number }[] = []
  const seen = new Set<string>()

  for (const resp of txResults) {
    const chronoIdx = resp.id as number
    const buyer = extractBuyer(resp.result)
    if (buyer && !seen.has(buyer)) {
      seen.add(buyer)
      buyers.push({ address: buyer, txIndex: chronoIdx })
    }
  }

  return buyers
}

// ── Debug : trace complète pour un seul token ────────────────────────────────────
// Appelé via GET ?debug=true&token=<mint>

async function debugSingleToken(mint: string, earlyTxCount: number) {
  // rpc_url affiché = hôte seulement (pas de query params → pas de clé API exposée)
  const result: Record<string, unknown> = { mint, rpc_url: PUBLIC_RPCS.map(maskRpcUrl) }

  // 1. Bonding curve PDA
  let pdaStr: string | null = null
  let pdaSigs: string[] = []
  try {
    pdaStr = bondingCurvePda(mint).toBase58()
    result.pda_address = pdaStr
    pdaSigs = await getSignaturesForAddress(pdaStr)
    result.pda_sigs_count   = pdaSigs.length
    result.pda_sigs_newest3 = pdaSigs.slice(0, 3)
    result.pda_sigs_oldest3 = pdaSigs.slice(-3)
  } catch (e: any) {
    result.pda_error = e.message
  }

  // 2. Fallback mint address si PDA vide
  let mintSigs: string[] = []
  if (pdaSigs.length === 0) {
    mintSigs = await getSignaturesForAddress(mint)
    result.mint_sigs_count   = mintSigs.length
    result.mint_sigs_newest3 = mintSigs.slice(0, 3)
    result.mint_sigs_oldest3 = mintSigs.slice(-3)
  }

  const sigs = pdaSigs.length > 0 ? pdaSigs : mintSigs
  result.sig_source = pdaSigs.length > 0 ? 'bonding_curve_pda' : 'mint_address'
  result.total_sigs = sigs.length

  if (sigs.length === 0) {
    result.diagnosis = 'FAIL: 0 signatures — token introuvable on-chain ou PDA et mint inactifs'
    return result
  }

  // 3. Sélection des N plus anciennes signatures
  const earlySigs = sigs.slice(-Math.min(earlyTxCount, sigs.length)).reverse()
  result.early_sigs_count   = earlySigs.length
  result.early_sigs_sample3 = earlySigs.slice(0, 3)

  // 4. Batch getTransaction via RPC
  const txResults = await batchGetTransactions(earlySigs)
  result.rpc_batch_responses = txResults.length
  result.rpc_errors = txResults.filter((r: any) => r.error).length

  if (txResults.length === 0) {
    result.diagnosis = 'FAIL: batchGetTransactions a retourné 0 résultats'
    return result
  }

  // 5. Aperçu des 3 premières txs (structure clé pour le diagnostic)
  result.tx_sample = txResults.slice(0, 3).map((resp: any) => {
    const r = resp.result
    if (!r) return { id: resp.id, error: resp.error ?? 'null result' }
    const meta = r.meta ?? {}
    const msg  = r.transaction?.message ?? {}
    const accs = (msg.accountKeys ?? []).slice(0, 4).map((a: any) =>
      typeof a === 'object' ? { pk: (a.pubkey ?? '').slice(0, 12) + '…', signer: a.signer, writable: a.writable } : String(a).slice(0, 12) + '…'
    )
    return {
      id:          resp.id,
      slot:        r.slot,
      blockTime:   r.blockTime,
      accounts:    accs,
      sol_changes: (meta.preBalances ?? []).slice(0, 4).map(
        (pre: number, i: number) => ((meta.postBalances?.[i] ?? pre) - pre) / 1e9
      ),
      post_tok_count: (meta.postTokenBalances ?? []).length,
      post_tok_owners: (meta.postTokenBalances ?? []).slice(0, 3).map((tb: any) => (tb.owner ?? '?').slice(0, 12) + '…'),
    }
  })

  // 6. Extraction acheteurs (même logique que getEarlyBuyers)
  const buyersAll: { address: string; txIndex: number }[] = []
  const seen = new Set<string>()
  let txsWithNoBuyer = 0

  for (const resp of txResults) {
    const buyer = extractBuyer(resp.result)
    if (buyer) {
      if (!seen.has(buyer)) {
        seen.add(buyer)
        buyersAll.push({ address: buyer, txIndex: resp.id as number })
      }
    } else {
      txsWithNoBuyer++
    }
  }

  result.buyers_before_filter = buyersAll.length
  result.txs_with_no_buyer    = txsWithNoBuyer
  result.buyers_sample5       = buyersAll.slice(0, 5)

  if (buyersAll.length === 0) {
    result.diagnosis =
      'FAIL: 0 acheteurs — ' +
      (txsWithNoBuyer === txResults.length
        ? `toutes les txs (${txResults.length}) filtrées (pas de perte SOL > 0.01 + gain tokens). Inspecter tx_sample.`
        : `${txsWithNoBuyer}/${txResults.length} txs sans acheteur identifié.`)
  } else {
    result.diagnosis = `OK: ${buyersAll.length} acheteurs extraits sur ${txResults.length} txs`
  }

  return result
}

// ── Handler GET ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const run       = req.nextUrl.searchParams.get('run') === 'true'
  const tokensQ   = req.nextUrl.searchParams.get('tokens')
  const debugMode = req.nextUrl.searchParams.get('debug') === 'true'
  const debugMint = req.nextUrl.searchParams.get('token')

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }
  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })
  const cfg      = await loadDiscoverSettings(supabase)

  // ── Mode debug : trace complète pour un token précis ─────────────────────────
  // GET ?debug=true&token=<mint>
  if (debugMode) {
    const mint = debugMint?.trim()
    if (!mint) {
      return NextResponse.json({ error: 'Paramètre ?token=<mint> requis avec debug=true' }, { status: 400 })
    }
    console.log(`[discover-wallets] debug mode pour ${mint.slice(0, 8)}…`)
    const trace = await debugSingleToken(mint, cfg.earlyTxCount)
    return NextResponse.json({ ok: true, debug: true, trace })
  }

  // ── 1. Collecter les mints candidats ─────────────────────────────────────────
  const explicitMints = tokensQ
    ? tokensQ.split(',').map(s => s.trim()).filter(Boolean)
    : []

  let discoveredMints: string[] = []
  if (!tokensQ) {
    discoveredMints = await collectSolanaMints()
  }

  const allMints = [...new Set([...explicitMints, ...discoveredMints])]
  console.log(
    `[discover-wallets] ${allMints.length} mints uniques collectés` +
    ` (${explicitMints.length} explicites + ${discoveredMints.length} découverts)`
  )

  // ── 2. Récupérer les données de paires en batch ───────────────────────────────
  const nowMs    = Date.now()
  const maxAgeMs = cfg.maxPairAgeDays > 0 ? cfg.maxPairAgeDays * 86_400_000 : Infinity
  const allPairs = new Map<string, DexPair>()  // mint → best pair

  const batches = []
  for (let i = 0; i < allMints.length; i += DEX_BATCH_SIZE) {
    batches.push(allMints.slice(i, i + DEX_BATCH_SIZE))
  }

  for (const batch of batches) {
    const pairs = await fetchPairsBatch(batch)
    for (const p of pairs) {
      if (p.chainId !== 'solana') continue
      const mint = p.baseToken?.address
      if (!mint) continue
      // Garder la paire avec le plus de liquidité par mint
      const existing = allPairs.get(mint)
      if (!existing || (p.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
        allPairs.set(mint, p)
      }
    }
    await new Promise(r => setTimeout(r, 150))
  }

  // ── 3. Filtrer selon les settings ────────────────────────────────────────────
  const qualifyingTokens: Array<{
    mint:         string
    symbol:       string
    name:         string
    h24Change:    number | null
    h6Change:     number | null
    mcap:         number | null
    pairAgeHours: number | null
    dexId:        string
    liquidity:    number | null
  }> = []

  for (const [mint, p] of allPairs) {
    // Filtre DEX
    if (!cfg.allowedDexIds.includes(p.dexId)) continue

    // Filtre gain : h24 OU h6
    const h24    = p.priceChange?.h24 ?? null
    const h6     = p.priceChange?.h6  ?? null
    const gainOk = (h24 !== null && h24 >= cfg.minGainPct)
                || (h6  !== null && h6  >= cfg.minGainH6Pct)
    if (!gainOk) continue

    // Filtre mcap
    const mcap = p.marketCap ?? p.fdv ?? null
    if (mcap !== null) {
      if (mcap < cfg.minMcapUsd || mcap > cfg.maxMcapUsd) continue
    }

    // Filtre âge de la paire
    let pairAgeHours: number | null = null
    if (p.pairCreatedAt) {
      pairAgeHours = (nowMs - p.pairCreatedAt) / 3_600_000
      if (pairAgeHours > cfg.maxPairAgeDays * 24) continue
    }

    qualifyingTokens.push({
      mint,
      symbol:       p.baseToken.symbol ?? '?',
      name:         p.baseToken.name   ?? '?',
      h24Change:    h24,
      h6Change:     h6,
      mcap,
      pairAgeHours: pairAgeHours !== null ? parseFloat(pairAgeHours.toFixed(1)) : null,
      dexId:        p.dexId,
      liquidity:    p.liquidity?.usd ?? null,
    })
  }

  // Trier par h24 décroissant
  qualifyingTokens.sort((a, b) => (b.h24Change ?? 0) - (a.h24Change ?? 0))

  console.log(
    `[discover-wallets] ${qualifyingTokens.length} tokens qualifiés` +
    ` (h24≥${cfg.minGainPct}% OU h6≥${cfg.minGainH6Pct}%,` +
    ` mcap ${cfg.minMcapUsd/1000}K–${cfg.maxMcapUsd/1000}K,` +
    ` dex: ${cfg.allowedDexIds.join('+')})`
  )

  // Déterminer le min_wins effectif (adaptatif si peu de tokens)
  const effectiveMinWins = qualifyingTokens.length < 10 ? 1 : cfg.minWins
  const adaptiveNote     = effectiveMinWins < cfg.minWins
    ? `Adaptatif : min_wins abaissé à 1 (seulement ${qualifyingTokens.length} tokens qualifiés < 10) + filtre avg_entry_rank ≤ ${cfg.minEntryRank}`
    : null

  // Coût estimé : 2 appels RPC par token (getSignaturesForAddress + batch getTransaction)
  const estimatedRpcCalls = qualifyingTokens.length * 2

  if (!run) {
    return NextResponse.json({
      ok:                true,
      dry_run:           true,
      mints_collected:   allMints.length,
      tokens_found:      qualifyingTokens.length,
      effective_min_wins: effectiveMinWins,
      adaptive_note:     adaptiveNote,
      estimated_rpc_calls: estimatedRpcCalls,
      helius_credits_used: 0,
      settings:          cfg,
      hint:              `Relancer avec ?run=true pour extraire les premiers acheteurs (~${estimatedRpcCalls} appels RPC, 0 crédit Helius)`,
      tokens:            qualifyingTokens,
    })
  }

  // ── 4. Extraction RPC : premiers acheteurs ────────────────────────────────────
  const { data: existingWallets } = await supabase
    .from('kymia_risque_wallets').select('address')
  const existingSet = new Set((existingWallets ?? []).map((w: any) => w.address as string))

  let rpcCallsUsed = 0
  const walletWins = new Map<string, {
    wins:         number
    tokens:       string[]
    labels:       string[]
    firstIndexes: number[]
  }>()

  for (const tok of qualifyingTokens) {
    console.log(
      `[discover-wallets] ${tok.symbol} (${tok.mint.slice(0, 8)}…)` +
      ` h24=${tok.h24Change?.toFixed(0) ?? '?'}% h6=${tok.h6Change?.toFixed(0) ?? '?'}%` +
      ` mcap=$${tok.mcap?.toFixed(0) ?? '?'} dex=${tok.dexId}`
    )

    const buyers = await getEarlyBuyers(tok.mint, cfg.earlyTxCount)
    rpcCallsUsed += 2  // 1 getSignaturesForAddress + 1 batch getTransaction
    console.log(`[discover-wallets] ${tok.symbol}: ${buyers.length} acheteurs extraits`)

    for (const buyer of buyers) {
      if (existingSet.has(buyer.address)) continue
      const prev = walletWins.get(buyer.address) ??
        { wins: 0, tokens: [], labels: [], firstIndexes: [] }
      walletWins.set(buyer.address, {
        wins:         prev.wins + 1,
        tokens:       [...prev.tokens, tok.mint],
        labels:       [...prev.labels, tok.symbol],
        firstIndexes: [...prev.firstIndexes, buyer.txIndex],
      })
    }

    // Pause 200ms entre chaque token pour respecter le rate limit du RPC public
    await new Promise(r => setTimeout(r, 200))
  }

  // ── 5. Filtrer les candidats ──────────────────────────────────────────────────
  const totalWallets   = walletWins.size
  const withMinWins    = [...walletWins.values()].filter(v => v.wins >= effectiveMinWins).length
  const withRankFilter = effectiveMinWins === 1
    ? [...walletWins.values()].filter(v => {
        if (v.wins < 1) return false
        const avgRank = v.firstIndexes.reduce((s, i) => s + i, 0) / v.firstIndexes.length
        return avgRank <= cfg.minEntryRank
      }).length
    : withMinWins

  console.log(
    `[discover-wallets] candidats pré-filtre: ${totalWallets} wallets uniques` +
    ` → ${withMinWins} avec wins≥${effectiveMinWins}` +
    (effectiveMinWins === 1 ? ` → ${withRankFilter} avec avg_entry_rank≤${cfg.minEntryRank}` : '')
  )

  const candidates = [...walletWins.entries()]
    .filter(([, v]) => {
      if (v.wins < effectiveMinWins) return false
      if (effectiveMinWins === 1) {
        const avgRank = v.firstIndexes.reduce((s, i) => s + i, 0) / v.firstIndexes.length
        if (avgRank > cfg.minEntryRank) return false
      }
      return true
    })
    .map(([address, v]) => {
      const avgEntryRank = v.firstIndexes.length > 0
        ? parseFloat((v.firstIndexes.reduce((s, i) => s + i, 0) / v.firstIndexes.length).toFixed(1))
        : null
      return {
        address,
        wins:            v.wins,
        winning_tokens:  v.labels,
        avg_entry_rank:  avgEntryRank,
        suggested_label: `alpha_${address.slice(0, 6)}`,
      }
    })
    .sort((a, b) => b.wins - a.wins || (a.avg_entry_rank ?? 99) - (b.avg_entry_rank ?? 99))

  console.log(
    `[discover-wallets] terminé — ${qualifyingTokens.length} tokens évalués,` +
    ` ${walletWins.size} wallets uniques, ${candidates.length} candidats,` +
    ` ${rpcCallsUsed} appels RPC, 0 crédit Helius`
  )

  return NextResponse.json({
    ok:                  true,
    dry_run:             false,
    mints_collected:     allMints.length,
    tokens_evaluated:    qualifyingTokens.length,
    candidates_count:    candidates.length,
    effective_min_wins:  effectiveMinWins,
    adaptive_note:       adaptiveNote,
    rpc_calls_used:      rpcCallsUsed,
    helius_credits_used: 0,
    settings:            cfg,
    hint: candidates.length > 0
      ? 'Valider puis POST /api/admin/risque/discover-wallets avec {wallets:[{address,label}]}'
      : 'Aucun candidat — essayer ?tokens=mint1,... ou baisser discover_min_wins en base',
    tokens:     qualifyingTokens,
    candidates,
  })
}

// ── Handler POST : insertion des wallets approuvés ────────────────────────────────

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }

  let body: { wallets?: Array<{ address: string; label: string }> } = {}
  try { body = await req.json() } catch { /* ok */ }

  if (!body.wallets?.length) {
    return NextResponse.json({ error: 'body.wallets requis — [{address, label}]' }, { status: 400 })
  }

  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  const { data: inserted, error: insertErr } = await supabase
    .from('kymia_risque_wallets')
    .upsert(
      body.wallets.map(w => ({ address: w.address, label: w.label, active: true })),
      { onConflict: 'address', ignoreDuplicates: false }
    )
    .select('address, label')

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  console.log(`[discover-wallets] ${inserted?.length ?? 0} wallet(s) insérés/mis à jour`)

  return NextResponse.json({
    ok:        true,
    inserted:  inserted?.length ?? 0,
    wallets:   inserted,
    next_step: 'POST /api/admin/risque/sync-webhook pour synchroniser le webhook Helius',
  })
}
