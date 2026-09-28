// app/api/admin/risque/wallet-winrate/route.ts
// Classement des wallets surveillés par win rate sur les tokens achetés.
//
// ── Algorithme ────────────────────────────────────────────────────────────────────
//   1. kymia_risque_buys → pour chaque (wallet, token) : market cap au PREMIER achat.
//   2. Tous les mints uniques → DexScreener lots de 30 → market cap actuel.
//      Token absent de DexScreener = mort = mcap 0 → -100% (pas ignoré).
//   3. Upsert kymia_risque_tokens.market_cap_usd + updated_at.
//   4. Par wallet :
//        - nb_tokens           : paires (wallet, token) avec entry mcap connu
//        - win_rate            : % tokens où mcap_actuel > mcap_entrée
//        - x2 / x5 / x10      : nb de tokens avec multiplicateur ≥ 2x / 5x / 10x
//        - down50              : nb de tokens avec mcap_actuel ≤ 50% de l'entrée
//        - median_mult         : médiane des multiplicateurs (mcap_actuel / mcap_entrée)
//   5. Tri par win_rate desc, filtre min_tokens (défaut 5, configurable ?min_tokens=N).
//
// ── 0 crédit Helius ──────────────────────────────────────────────────────────────
//   Tout passe par DexScreener (gratuit, pas de clé requise).

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { fetchSolPriceUsd }          from '@/lib/risque/pumpfun'

const DEXSCREENER   = 'https://api.dexscreener.com'
const DEX_BATCH     = 30   // max mints par appel DexScreener
const DEX_GAP_MS    = 300  // pause entre batches pour éviter le rate-limit

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid    = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

// ── fetchCurrentMcaps ────────────────────────────────────────────────────────────
// Retourne Map<mint, currentMcapUsd>.
// Mints absents de DexScreener → mcap 0 (token mort → perte totale).

async function fetchCurrentMcaps(
  mints:       string[],
  solPriceUsd: number,
): Promise<Map<string, number>> {
  const result = new Map<string, number>()

  // Initialiser à 0 (mort par défaut) — sera mis à jour si DexScreener répond
  for (const m of mints) result.set(m, 0)

  const chunks: string[][] = []
  for (let i = 0; i < mints.length; i += DEX_BATCH) {
    chunks.push(mints.slice(i, i + DEX_BATCH))
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    if (ci > 0) await sleep(DEX_GAP_MS)
    const chunk = chunks[ci]
    try {
      const res = await fetch(
        `${DEXSCREENER}/latest/dex/tokens/${chunk.join(',')}`,
        { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(10_000) },
      )
      if (!res.ok) {
        console.warn(`[wallet-winrate] DexScreener batch ${ci}: HTTP ${res.status}`)
        continue
      }
      const data  = await res.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pairs = (data.pairs ?? []) as Array<{
        baseToken?: { address?: string }
        chainId?:   string
        marketCap?: number
        liquidity?: { usd?: number }
        priceUsd?:  string
        fdv?:       number
      }>

      // Garder la paire la plus liquide par mint
      const bestByMint = new Map<string, { mcap: number; liq: number }>()
      for (const p of pairs) {
        const mint = p.baseToken?.address
        if (!mint) continue
        // Solana uniquement (évite les homophones sur d'autres chains)
        if (p.chainId && p.chainId !== 'solana') continue

        let mcap = p.marketCap ?? 0
        // Si marketCap absent, reconstruire depuis priceUsd × supply implicite
        // ou FDV si disponible (proxy raisonnable pour les petits tokens)
        if (!mcap && p.fdv) mcap = p.fdv
        if (!mcap && p.priceUsd) {
          // pump.fun supply = 1B tokens → price × 1e9 ≈ mcap
          const price = parseFloat(p.priceUsd)
          if (price > 0) mcap = price * 1_000_000_000
        }

        const liq = p.liquidity?.usd ?? 0
        const cur = bestByMint.get(mint)
        if (!cur || liq > cur.liq) bestByMint.set(mint, { mcap, liq })
      }

      for (const [mint, { mcap }] of bestByMint) {
        if (mcap > 0) result.set(mint, mcap)
      }
    } catch (e: any) {
      console.warn(`[wallet-winrate] DexScreener batch ${ci}: ${e.message}`)
    }
  }

  // Fallback SOL price pour les tokens non couverts par DexScreener :
  // si priceUsd était nul mais on a le prix SOL, on n'a pas d'autre source →
  // ils restent à 0 (mort). Le prix SOL est utilisé plus haut si besoin.
  void solPriceUsd   // référence pour eslint

  return result
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

  const sp          = req.nextUrl.searchParams
  const minTokens   = Math.max(1, parseInt(sp.get('min_tokens') ?? '5', 10))

  // ── 1. Tous les achats avec entry mcap ────────────────────────────────────────
  const { data: buys, error: buysErr } = await supabase
    .from('kymia_risque_buys')
    .select('wallet_address, wallet_label, token_mint, market_cap_at_buy, bought_at')
    .order('bought_at', { ascending: true })   // plus ancien en premier → premier achat en tête

  if (buysErr) return NextResponse.json({ error: buysErr.message }, { status: 500 })

  const allBuys = (buys ?? []) as Array<{
    wallet_address:    string
    wallet_label:      string | null
    token_mint:        string
    market_cap_at_buy: number | null
    bought_at:         string
  }>

  // ── 2. Premier achat par (wallet, token) ──────────────────────────────────────
  // Clé : "walletAddress::tokenMint"
  const firstBuy = new Map<string, {
    walletAddress: string
    walletLabel:   string
    tokenMint:     string
    entryMcap:     number | null
  }>()

  for (const b of allBuys) {
    const key = `${b.wallet_address}::${b.token_mint}`
    if (!firstBuy.has(key)) {
      firstBuy.set(key, {
        walletAddress: b.wallet_address,
        walletLabel:   b.wallet_label ?? b.wallet_address.slice(0, 8),
        tokenMint:     b.token_mint,
        entryMcap:     b.market_cap_at_buy,
      })
    }
  }

  // Paires avec entry mcap connu (sans entry mcap → non classifiables → exclus du win rate)
  const gradedPairs = [...firstBuy.values()].filter(p => p.entryMcap !== null && p.entryMcap > 0)

  const allMints = [...new Set(gradedPairs.map(p => p.tokenMint))]
  console.log(
    `[wallet-winrate] ${gradedPairs.length} paires (wallet,token) avec entry mcap sur ${allMints.length} mints uniques`
  )

  // ── 3. Prix SOL (pour éventuels calculs futurs — DexScreener donne mcap direct) ─
  let solPriceUsd = 150
  try { solPriceUsd = await fetchSolPriceUsd() } catch { /* fallback */ }

  // ── 4. Market cap actuel via DexScreener ──────────────────────────────────────
  const currentMcaps = await fetchCurrentMcaps(allMints, solPriceUsd)

  const liveMints  = [...currentMcaps.entries()].filter(([, mc]) => mc > 0).length
  const deadMints  = allMints.length - liveMints
  console.log(`[wallet-winrate] DexScreener: ${liveMints} tokens vivants, ${deadMints} morts (mcap=0)`)

  // ── 5. Upsert kymia_risque_tokens ─────────────────────────────────────────────
  const now = new Date().toISOString()
  const tokenUpserts = allMints.map(mint => ({
    mint,
    market_cap_usd: currentMcaps.get(mint) || null,  // 0 → null (cohérent avec le reste de la base)
    updated_at:     now,
  }))

  // Upsert en lots de 50 pour ne pas dépasser les limites Supabase
  for (let i = 0; i < tokenUpserts.length; i += 50) {
    const batch = tokenUpserts.slice(i, i + 50)
    const { error: upsertErr } = await supabase
      .from('kymia_risque_tokens')
      .upsert(batch, { onConflict: 'mint' })
    if (upsertErr) {
      console.warn(`[wallet-winrate] upsert tokens batch ${i}: ${upsertErr.message}`)
    }
  }

  // ── 6. Stats par wallet ───────────────────────────────────────────────────────
  type WalletStats = {
    wallet_address: string
    wallet_label:   string
    nb_tokens:      number
    win_rate:       number
    x2:             number
    x5:             number
    x10:            number
    down50:         number
    median_mult:    number   // ex: 1.8 = +80%
    top_tokens:     Array<{ mint: string; entry_mcap: number; current_mcap: number; mult: number }>
  }

  const walletMap = new Map<string, {
    address: string; label: string
    mults:   number[]
    tokens:  WalletStats['top_tokens']
  }>()

  for (const pair of gradedPairs) {
    const currentMc = currentMcaps.get(pair.tokenMint) ?? 0
    const mult      = currentMc / pair.entryMcap!   // entryMcap > 0 garanti ci-dessus

    if (!walletMap.has(pair.walletAddress)) {
      walletMap.set(pair.walletAddress, {
        address: pair.walletAddress,
        label:   pair.walletLabel,
        mults:   [],
        tokens:  [],
      })
    }
    const w = walletMap.get(pair.walletAddress)!
    w.mults.push(mult)
    w.tokens.push({
      mint:          pair.tokenMint,
      entry_mcap:    Math.round(pair.entryMcap!),
      current_mcap:  Math.round(currentMc),
      mult:          parseFloat(mult.toFixed(3)),
    })
  }

  const rankings: WalletStats[] = []

  for (const [, w] of walletMap) {
    if (w.mults.length < minTokens) continue

    const nb    = w.mults.length
    const wins  = w.mults.filter(m => m > 1).length
    const stats: WalletStats = {
      wallet_address: w.address,
      wallet_label:   w.label,
      nb_tokens:      nb,
      win_rate:       parseFloat(((wins / nb) * 100).toFixed(1)),
      x2:             w.mults.filter(m => m >= 2).length,
      x5:             w.mults.filter(m => m >= 5).length,
      x10:            w.mults.filter(m => m >= 10).length,
      down50:         w.mults.filter(m => m <= 0.5).length,
      median_mult:    parseFloat(median(w.mults).toFixed(3)),
      top_tokens:     [...w.tokens].sort((a, b) => b.mult - a.mult).slice(0, 10),
    }
    rankings.push(stats)
  }

  // Tri : win_rate desc, puis median_mult desc en cas d'égalité
  rankings.sort((a, b) =>
    b.win_rate !== a.win_rate
      ? b.win_rate - a.win_rate
      : b.median_mult - a.median_mult
  )

  // ── Wallets exclus (< min_tokens paires avec entry mcap) ─────────────────────
  const excluded = [...walletMap.entries()]
    .filter(([, w]) => w.mults.length < minTokens)
    .map(([address, w]) => ({ address, label: w.label, nb_tokens: w.mults.length }))

  return NextResponse.json({
    ok:           true,
    snapshot_at:  now,
    sol_price:    solPriceUsd,
    coverage:     {
      total_pairs:     gradedPairs.length,
      no_entry_mcap:   firstBuy.size - gradedPairs.length,
      total_mints:     allMints.length,
      live_mints:      liveMints,
      dead_mints:      deadMints,
    },
    min_tokens,
    ranked:       rankings.length,
    rankings,
    excluded_wallets: excluded,
  })
}
