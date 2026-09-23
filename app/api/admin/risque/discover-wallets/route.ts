// app/api/admin/risque/discover-wallets/route.ts
// Découverte de wallets alpha via rétro-ingénierie de tokens gagnants.
//
// ── Phase 1 — Découverte tokens (DexScreener, 0 crédit Helius) ──────────────────
//   GET /api/admin/risque/discover-wallets
//   GET /api/admin/risque/discover-wallets?tokens=mint1,mint2,...  (mints explicites)
//   → Retourne tokens qualifiés + estimation coût Helius. Ne consomme 0 crédit Helius.
//
// ── Phase 2 — Extraction premiers acheteurs (Helius, crédits consommés) ─────────
//   GET /api/admin/risque/discover-wallets?run=true
//   → Appelle Helius pour extraire les premiers acheteurs de chaque token qualifié.
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
// ── Coût Helius estimé ───────────────────────────────────────────────────────────
//   getSignaturesForAddress : ~10 crédits/token
//   Parse enhanced txs      : 1 crédit × discover_early_tx_count par token
//   → ~40 crédits/token. 30 tokens ≈ 1 200 crédits (négligeable sur 10M/mois)
//
// ── Critère min_wins adaptatif ───────────────────────────────────────────────────
//   tokens_qualifiés ≥ 10  → min_wins (défaut 2)
//   tokens_qualifiés < 10  → 1 + avg_entry_rank ≤ discover_min_entry_rank

export const dynamic    = 'force-dynamic'
export const maxDuration = 120

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { PublicKey }                 from '@solana/web3.js'
import { bondingCurvePda }           from '@/lib/risque/pumpfun'
import { getConnection }             from '@/lib/solana/wallet'

const HELIUS_API  = 'https://api.helius.xyz/v0'
const DEXSCREENER = 'https://api.dexscreener.com'

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

// ── Helius : premiers acheteurs ───────────────────────────────────────────────────
// Fonctionne pour pump.fun (bonding curve PDA) ET tokens graduées (pumpswap/raydium).
// Pour les tokens graduées : fallback sur mint address (plus de signatures, plus large).

interface HeliusEnhancedTx {
  signature:       string
  source?:         string
  tokenTransfers?: Array<{ toUserAccount: string; fromUserAccount: string; mint: string }>
  accountData?:    Array<{
    account:             string
    nativeBalanceChange: number
    tokenBalanceChanges: Array<{ mint: string; rawTokenAmount: { tokenAmount: string } }>
  }>
}

async function getEarlyBuyers(
  mint:          string,
  apiKey:        string,
  earlyTxCount:  number,
): Promise<{ address: string; txIndex: number }[]> {
  const conn = getConnection()
  let sigs: string[] = []

  // Essayer bonding curve PDA (pump.fun non-gradué)
  try {
    const pda    = bondingCurvePda(mint)
    const result = await conn.getSignaturesForAddress(pda, { limit: 1000 }, 'confirmed')
    sigs = result.map(s => s.signature)
  } catch { /* pas pump.fun ou gradué → fallback */ }

  // Fallback : utiliser le mint address (pumpswap, raydium, graduées)
  if (sigs.length === 0) {
    try {
      const result = await conn.getSignaturesForAddress(
        new PublicKey(mint), { limit: 1000 }, 'confirmed'
      )
      sigs = result.map(s => s.signature)
    } catch (e: any) {
      console.warn(`[discover-wallets] getSignaturesForAddress ${mint.slice(0, 8)}…: ${e.message}`)
      return []
    }
  }

  if (sigs.length === 0) return []

  // Dernières signatures = plus anciennes = premiers acheteurs
  const earlySigs = sigs
    .slice(-Math.min(earlyTxCount, sigs.length))
    .reverse()  // ordre chrono (index 0 = 1er acheteur)

  // Parse via Helius enhanced transactions (batch, 1 crédit/tx)
  let parsed: HeliusEnhancedTx[] = []
  try {
    const res = await fetch(`${HELIUS_API}/transactions?api-key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'KYMIA/1.0' },
      body:    JSON.stringify({ transactions: earlySigs }),
      signal:  AbortSignal.timeout(15_000),
    })
    if (res.ok) parsed = await res.json()
    else console.warn(`[discover-wallets] Helius parse ${mint.slice(0, 8)}…: HTTP ${res.status}`)
  } catch (e: any) {
    console.warn(`[discover-wallets] Helius parse ${mint.slice(0, 8)}…: ${e.message}`)
    return []
  }

  // Extraire l'acheteur de chaque tx
  const buyers: { address: string; txIndex: number }[] = []
  const seen = new Set<string>()
  let pdaStr: string | null = null
  try { pdaStr = bondingCurvePda(mint).toBase58() } catch { /* non pump.fun */ }

  for (let i = 0; i < parsed.length; i++) {
    const tx = parsed[i]

    // Méthode 1 : tokenTransfers — destinataire du token cible = acheteur
    const tokenRecipient = tx.tokenTransfers?.find(t => t.mint === mint)?.toUserAccount

    // Méthode 2 : accountData — compte qui perd SOL ET gagne des tokens
    let accountDataBuyer: string | null = null
    if (!tokenRecipient && tx.accountData) {
      for (const ad of tx.accountData) {
        if (pdaStr && ad.account === pdaStr) continue
        const gainsMint = ad.tokenBalanceChanges?.some(
          tc => tc.mint === mint && parseInt(tc.rawTokenAmount.tokenAmount, 10) > 0
        )
        if (gainsMint && ad.nativeBalanceChange < 0) {
          accountDataBuyer = ad.account
          break
        }
      }
    }

    const buyer = tokenRecipient ?? accountDataBuyer
    if (buyer && !seen.has(buyer)) {
      seen.add(buyer)
      buyers.push({ address: buyer, txIndex: i })
    }
  }

  return buyers
}

// ── Handler GET ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey  = process.env.NEXT_PUBLIC_HELIEUS_KEY
  const run     = req.nextUrl.searchParams.get('run') === 'true'
  const tokensQ = req.nextUrl.searchParams.get('tokens')

  if (run && !apiKey) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_HELIEUS_KEY manquant' }, { status: 500 })
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }
  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })
  const cfg      = await loadDiscoverSettings(supabase)

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
  const nowMs       = Date.now()
  const maxAgeMs    = cfg.maxPairAgeDays > 0 ? cfg.maxPairAgeDays * 86_400_000 : Infinity
  const allPairs    = new Map<string, DexPair>()  // mint → best pair

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
    const h24  = p.priceChange?.h24 ?? null
    const h6   = p.priceChange?.h6  ?? null
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

  const estimatedCredits = qualifyingTokens.length * (10 + cfg.earlyTxCount)

  if (!run) {
    return NextResponse.json({
      ok:                true,
      dry_run:           true,
      mints_collected:   allMints.length,
      tokens_found:      qualifyingTokens.length,
      effective_min_wins: effectiveMinWins,
      adaptive_note:     adaptiveNote,
      estimated_credits: estimatedCredits,
      settings:          cfg,
      hint:              `Relancer avec ?run=true pour extraire les premiers acheteurs (~${estimatedCredits} crédits Helius)`,
      tokens:            qualifyingTokens,
    })
  }

  // ── 4. Extraction Helius : premiers acheteurs ─────────────────────────────────
  const { data: existingWallets } = await supabase
    .from('kymia_risque_wallets').select('address')
  const existingSet = new Set((existingWallets ?? []).map((w: any) => w.address as string))

  let heliusCreditsUsed = 0
  const walletWins = new Map<string, {
    wins:         number
    tokens:       string[]
    labels:       string[]
    firstIndexes: number[]
    buyAmounts:   number[]   // pour filtre qualité (non utilisé pour l'instant)
  }>()

  for (const tok of qualifyingTokens) {
    console.log(
      `[discover-wallets] ${tok.symbol} (${tok.mint.slice(0, 8)}…)` +
      ` h24=${tok.h24Change?.toFixed(0) ?? '?'}% h6=${tok.h6Change?.toFixed(0) ?? '?'}%` +
      ` mcap=$${tok.mcap?.toFixed(0) ?? '?'} dex=${tok.dexId}`
    )

    const buyers = await getEarlyBuyers(tok.mint, apiKey!, cfg.earlyTxCount)
    heliusCreditsUsed += 10 + buyers.length

    for (const buyer of buyers) {
      if (existingSet.has(buyer.address)) continue
      const prev = walletWins.get(buyer.address) ??
        { wins: 0, tokens: [], labels: [], firstIndexes: [], buyAmounts: [] }
      walletWins.set(buyer.address, {
        wins:         prev.wins + 1,
        tokens:       [...prev.tokens, tok.mint],
        labels:       [...prev.labels, tok.symbol],
        firstIndexes: [...prev.firstIndexes, buyer.txIndex],
        buyAmounts:   prev.buyAmounts,
      })
    }

    await new Promise(r => setTimeout(r, 400))
  }

  // ── 5. Filtrer les candidats ──────────────────────────────────────────────────
  const candidates = [...walletWins.entries()]
    .filter(([, v]) => {
      if (v.wins < effectiveMinWins) return false
      // Filtre qualité si min_wins adaptatif = 1
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
        wins:           v.wins,
        winning_tokens: v.labels,
        avg_entry_rank: avgEntryRank,
        suggested_label: `alpha_${address.slice(0, 6)}`,
      }
    })
    .sort((a, b) => b.wins - a.wins || (a.avg_entry_rank ?? 99) - (b.avg_entry_rank ?? 99))

  console.log(
    `[discover-wallets] terminé — ${qualifyingTokens.length} tokens évalués,` +
    ` ${walletWins.size} wallets uniques, ${candidates.length} candidats,` +
    ` ${heliusCreditsUsed} crédits Helius utilisés`
  )

  return NextResponse.json({
    ok:                  true,
    dry_run:             false,
    mints_collected:     allMints.length,
    tokens_evaluated:    qualifyingTokens.length,
    candidates_count:    candidates.length,
    effective_min_wins:  effectiveMinWins,
    adaptive_note:       adaptiveNote,
    helius_credits_used: heliusCreditsUsed,
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
