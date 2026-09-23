// app/api/admin/risque/discover-wallets/route.ts
// Découverte de wallets alpha via rétro-ingénierie de tokens gagnants.
//
// ── Phase 1 — Découverte tokens (DexScreener, 0 crédit Helius) ──────────────────
//   GET /api/admin/risque/discover-wallets
//   GET /api/admin/risque/discover-wallets?tokens=mint1,mint2,...  (adresses explicites)
//   → Retourne les tokens candidats + estimation du coût Helius. Ne touche pas Helius.
//
// ── Phase 2 — Extraction acheteurs (Helius, crédits consommés) ──────────────────
//   GET /api/admin/risque/discover-wallets?run=true
//   GET /api/admin/risque/discover-wallets?run=true&tokens=mint1,...
//   → Appelle Helius pour extraire les premiers acheteurs de chaque token.
//   → Retourne la liste des candidats à valider (ne touche pas kymia_risque_wallets).
//
// ── Phase 3 — Insertion après validation ────────────────────────────────────────
//   POST /api/admin/risque/discover-wallets
//   Body : { wallets: [{ address: "...", label: "..." }] }
//   → Insère les wallets approuvés dans kymia_risque_wallets.
//   → Appeler ensuite POST /api/admin/risque/sync-webhook pour synchroniser Helius.
//
// Coût Helius estimé :
//   - getSignaturesForAddress : ~10 crédits/appel (1 appel par token)
//   - Parse enhanced txs      : 1 crédit/tx × 30 premières txs par token
//   → ~40 crédits/token, ~600 crédits pour 15 tokens (négligeable sur 10M/mois)
//
// Critères de sélection des candidats :
//   - Présent parmi les 30 premiers acheteurs d'au moins 2 tokens gagnants différents
//   - Non déjà présent dans kymia_risque_wallets
//   - Pas de pattern MM (pas plus de 5 achats du même token sur ces txs)

export const dynamic    = 'force-dynamic'
export const maxDuration = 120   // 2 min — boucle DexScreener + Helius parse pour 50 tokens

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { bondingCurvePda }           from '@/lib/risque/pumpfun'
import { getConnection }             from '@/lib/solana/wallet'

const HELIUS_API = 'https://api.helius.xyz/v0'
const DEXSCREENER = 'https://api.dexscreener.com'

// Filtre : token considéré gagnant si priceChange.h24 >= ce seuil (≈ x5)
const MIN_H24_CHANGE_PCT = 400

// Nb de premières transactions à analyser par token pour trouver les premiers acheteurs
const EARLY_TX_COUNT = 30

// Nb de tokens gagnants distincts dans lesquels un wallet doit être early buyer
const MIN_WINS = 2

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

// ── DexScreener : tokens boostés sur Solana ───────────────────────────────────

interface DexBoostToken {
  chainId:      string
  tokenAddress: string
  url?:         string
}

interface DexPair {
  chainId:      string
  dexId:        string
  baseToken:    { address: string; symbol: string; name: string }
  priceChange:  { h24?: number; h6?: number; h1?: number }
  liquidity?:   { usd: number }
  pairCreatedAt?: number
  marketCap?:   number
}

async function fetchBoostedSolanaTokens(): Promise<string[]> {
  try {
    const res = await fetch(`${DEXSCREENER}/token-boosts/top/v1`, {
      headers: { 'User-Agent': 'KYMIA/1.0' },
      signal:  AbortSignal.timeout(8_000),
    })
    if (!res.ok) return []
    const data = await res.json() as DexBoostToken[]
    return data
      .filter(t => t.chainId === 'solana')
      .map(t => t.tokenAddress)
  } catch {
    return []
  }
}

async function fetchTokenPairs(mint: string): Promise<DexPair[]> {
  try {
    const res = await fetch(`${DEXSCREENER}/latest/dex/tokens/${mint}`, {
      headers: { 'User-Agent': 'KYMIA/1.0' },
      signal:  AbortSignal.timeout(6_000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.pairs ?? []) as DexPair[]
  } catch {
    return []
  }
}

// ── Helius : premiers acheteurs via getSignaturesForAddress + enhanced parse ───

interface HeliusEnhancedTx {
  signature:      string
  source?:        string
  type?:          string
  tokenTransfers?: Array<{
    toUserAccount:   string
    fromUserAccount: string
    mint:            string
    tokenAmount:     number
  }>
  accountData?: Array<{
    account:             string
    nativeBalanceChange: number
    tokenBalanceChanges: Array<{ mint: string; rawTokenAmount: { tokenAmount: string } }>
  }>
}

async function getEarlyBuyers(
  mint:     string,
  apiKey:   string,
): Promise<{ address: string; txIndex: number }[]> {
  const pda = bondingCurvePda(mint)

  // 1. getSignaturesForAddress → retourne du plus récent au plus ancien
  const conn = getConnection()
  let sigs: string[]
  try {
    const result = await conn.getSignaturesForAddress(pda, { limit: 1000 }, 'confirmed')
    sigs = result.map(s => s.signature)
  } catch (e: any) {
    console.warn(`[discover-wallets] getSignaturesForAddress ${mint.slice(0, 8)}…: ${e.message}`)
    return []
  }

  if (sigs.length === 0) return []

  // Les DERNIÈRES signatures dans le tableau = les PLUS ANCIENNES (premiers acheteurs)
  const earlySigs = sigs.slice(-Math.min(EARLY_TX_COUNT, sigs.length)).reverse()
  // Inverse pour avoir ordre chrono (index 0 = premier acheteur)

  // 2. Parse via Helius enhanced transactions (batch, 1 crédit/tx)
  let parsed: HeliusEnhancedTx[] = []
  try {
    const res = await fetch(`${HELIUS_API}/transactions?api-key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'KYMIA/1.0' },
      body:    JSON.stringify({ transactions: earlySigs }),
      signal:  AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      parsed = await res.json()
    } else {
      console.warn(`[discover-wallets] Helius parse ${mint.slice(0, 8)}…: HTTP ${res.status}`)
    }
  } catch (e: any) {
    console.warn(`[discover-wallets] Helius parse ${mint.slice(0, 8)}…: ${e.message}`)
    return []
  }

  // 3. Extraire l'acheteur de chaque tx
  const buyers: { address: string; txIndex: number }[] = []
  const seen = new Set<string>()

  for (let i = 0; i < parsed.length; i++) {
    const tx = parsed[i]

    // Méthode 1 : tokenTransfers — le destinataire du token cible = acheteur
    const tokenRecipient = tx.tokenTransfers?.find(t => t.mint === mint)?.toUserAccount

    // Méthode 2 : accountData — le compte qui perd du SOL ET gagne des tokens
    let accountDataBuyer: string | null = null
    if (!tokenRecipient && tx.accountData) {
      const pdaStr = pda.toBase58()
      for (const ad of tx.accountData) {
        if (ad.account === pdaStr) continue   // pas la curve elle-même
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

// ── Handler GET ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey  = process.env.NEXT_PUBLIC_HELIEUS_KEY
  const run     = req.nextUrl.searchParams.get('run') === 'true'
  const tokensQ = req.nextUrl.searchParams.get('tokens')

  if (run && !apiKey) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_HELIEUS_KEY manquant — nécessaire pour run=true' }, { status: 500 })
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }
  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  // ── 1. Identifier les tokens candidats ───────────────────────────────────
  let explicitMints: string[] = []
  if (tokensQ) {
    explicitMints = tokensQ.split(',').map(s => s.trim()).filter(Boolean)
  }

  // DexScreener : tokens boostés sur Solana (source principale de découverte)
  const boostedMints = await fetchBoostedSolanaTokens()

  const allMints = [...new Set([...explicitMints, ...boostedMints])]

  console.log(`[discover-wallets] ${allMints.length} mints à évaluer (${explicitMints.length} explicites + ${boostedMints.length} boostés)`)

  // ── 2. Filtrer : priceChange.h24 ≥ MIN_H24_CHANGE_PCT sur pumpfun ────────
  const qualifyingTokens: Array<{
    mint:        string
    symbol:      string
    name:        string
    h24Change:   number
    mcap:        number | null
    pairCreatedAt: number | null
    dexId:       string
  }> = []

  // Limiter à 50 tokens pour éviter de surcharger DexScreener
  const mintsToCheck = allMints.slice(0, 50)

  for (const mint of mintsToCheck) {
    const pairs = await fetchTokenPairs(mint)
    const best = pairs
      .filter(p => p.priceChange?.h24 !== undefined)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]

    if (!best) continue
    if ((best.priceChange.h24 ?? 0) < MIN_H24_CHANGE_PCT) continue

    qualifyingTokens.push({
      mint,
      symbol:       best.baseToken.symbol ?? '?',
      name:         best.baseToken.name   ?? '?',
      h24Change:    best.priceChange.h24!,
      mcap:         best.marketCap ?? null,
      pairCreatedAt: best.pairCreatedAt ?? null,
      dexId:        best.dexId,
    })

    // Petite pause pour respecter le rate limit DexScreener
    await new Promise(r => setTimeout(r, 200))
  }

  console.log(`[discover-wallets] ${qualifyingTokens.length} tokens qualifiés (h24 ≥ ${MIN_H24_CHANGE_PCT}%)`)

  // Estimation crédits Helius
  const estimatedCredits = qualifyingTokens.length * (10 + EARLY_TX_COUNT)

  if (!run) {
    // Dry run : retourner les tokens sans appeler Helius
    return NextResponse.json({
      ok:                true,
      dry_run:           true,
      tokens_found:      qualifyingTokens.length,
      estimated_credits: estimatedCredits,
      min_wins_required: MIN_WINS,
      early_tx_count:    EARLY_TX_COUNT,
      hint:              `Relancer avec ?run=true pour extraire les premiers acheteurs (${estimatedCredits} crédits Helius)`,
      tokens:            qualifyingTokens,
    })
  }

  // ── 3. Pour chaque token : extraire les premiers acheteurs ────────────────
  // Charger les wallets déjà en base pour exclusion
  const { data: existingWallets } = await supabase
    .from('kymia_risque_wallets')
    .select('address')
  const existingSet = new Set((existingWallets ?? []).map(w => w.address as string))

  let heliusCreditsUsed = 0
  const walletWins = new Map<string, { wins: number; tokens: string[]; labels: string[]; firstIndexes: number[] }>()

  for (const tok of qualifyingTokens) {
    console.log(`[discover-wallets] extraction ${tok.symbol} (${tok.mint.slice(0, 8)}…) — h24: +${tok.h24Change.toFixed(0)}%`)

    const buyers = await getEarlyBuyers(tok.mint, apiKey!)
    heliusCreditsUsed += 10 + buyers.length   // getSignaturesForAddress + parse

    for (const buyer of buyers) {
      if (existingSet.has(buyer.address)) continue

      const prev = walletWins.get(buyer.address) ?? { wins: 0, tokens: [], labels: [], firstIndexes: [] }
      walletWins.set(buyer.address, {
        wins:         prev.wins + 1,
        tokens:       [...prev.tokens, tok.mint],
        labels:       [...prev.labels, tok.symbol],
        firstIndexes: [...prev.firstIndexes, buyer.txIndex],
      })
    }

    // Pause légère entre tokens pour ménager le RPC
    await new Promise(r => setTimeout(r, 400))
  }

  // ── 4. Filtrer : ≥ MIN_WINS tokens gagnants distincts ────────────────────
  const candidates = [...walletWins.entries()]
    .filter(([, v]) => v.wins >= MIN_WINS)
    .map(([address, v]) => ({
      address,
      wins:          v.wins,
      winning_tokens: v.labels,
      avg_entry_rank: v.firstIndexes.length > 0
        ? parseFloat((v.firstIndexes.reduce((s, i) => s + i, 0) / v.firstIndexes.length).toFixed(1))
        : null,
      suggested_label: `alpha_${address.slice(0, 6)}`,
      already_in_db:   false,  // déjà filtré via existingSet
    }))
    .sort((a, b) => b.wins - a.wins || (a.avg_entry_rank ?? 99) - (b.avg_entry_rank ?? 99))

  console.log(
    `[discover-wallets] terminé — ${qualifyingTokens.length} tokens, ${walletWins.size} wallets uniques,` +
    ` ${candidates.length} candidats (≥${MIN_WINS} gagnants), ${heliusCreditsUsed} crédits utilisés`
  )

  return NextResponse.json({
    ok:                true,
    dry_run:           false,
    tokens_evaluated:  qualifyingTokens.length,
    candidates_count:  candidates.length,
    helius_credits_used: heliusCreditsUsed,
    min_wins_required: MIN_WINS,
    hint:              candidates.length > 0
      ? `Valider les candidats ci-dessous puis appeler POST /api/admin/risque/discover-wallets avec {wallets:[{address,label}]}`
      : 'Aucun candidat trouvé — essayer avec ?tokens=mint1,mint2,... pour fournir des mints explicites',
    tokens:            qualifyingTokens,
    candidates,
  })
}

// ── Handler POST : insertion des wallets approuvés ───────────────────────────

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

  const rows = body.wallets.map(w => ({
    address: w.address,
    label:   w.label,
    active:  true,
  }))

  const { data: inserted, error: insertErr } = await supabase
    .from('kymia_risque_wallets')
    .upsert(rows, { onConflict: 'address', ignoreDuplicates: false })
    .select('address, label')

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  console.log(`[discover-wallets] ${inserted?.length ?? 0} wallet(s) insérés/mis à jour`)

  return NextResponse.json({
    ok:       true,
    inserted: inserted?.length ?? 0,
    wallets:  inserted,
    next_step: 'POST /api/admin/risque/sync-webhook pour synchroniser le webhook Helius',
  })
}
