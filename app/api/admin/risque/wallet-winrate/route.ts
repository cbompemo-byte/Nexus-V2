// app/api/admin/risque/wallet-winrate/route.ts
// Classement des wallets surveillés par win rate sur les tokens achetés.
//
// ── Couverture ─────────────────────────────────────────────────────────────────────
//   Pour chaque paire (wallet, token), l'entry mcap est cherché dans cet ordre :
//     1. market_cap_at_buy du PREMIER achat (exact)
//     2. kymia_risque_tokens.market_cap_usd chargé AVANT la mise à jour DexScreener
//        (proxy : mcap au dernier passage webhook ou winrate — "estimated")
//   Les paires sans entry mcap disponible sont comptées dans no_entry_mcap mais
//   exclues des métriques de performance (impossible de calculer un multiplicateur).
//
// ── MFE ───────────────────────────────────────────────────────────────────────────
//   Les stats MFE (max 24h, stop_before_trail) sont lues depuis kymia_risque_tokens.
//   Elles sont peuplées par le run de GET /api/admin/risque/wallet-mfe (paginé).
//
// ── 0 crédit Helius ──────────────────────────────────────────────────────────────
//   Tout passe par DexScreener (gratuit).

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { fetchSolPriceUsd }          from '@/lib/risque/pumpfun'

const DEXSCREENER = 'https://api.dexscreener.com'
const DEX_BATCH   = 30
const DEX_GAP_MS  = 300

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid    = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// ── fetchCurrentMcaps ─────────────────────────────────────────────────────────────
// Tokens absents de DexScreener → mcap 0 (mort, -100%).

async function fetchCurrentMcaps(mints: string[], solPriceUsd: number): Promise<Map<string, number>> {
  void solPriceUsd
  const result = new Map<string, number>()
  for (const m of mints) result.set(m, 0)

  const chunks: string[][] = []
  for (let i = 0; i < mints.length; i += DEX_BATCH) chunks.push(mints.slice(i, i + DEX_BATCH))

  for (let ci = 0; ci < chunks.length; ci++) {
    if (ci > 0) await sleep(DEX_GAP_MS)
    try {
      const res = await fetch(
        `${DEXSCREENER}/latest/dex/tokens/${chunks[ci].join(',')}`,
        { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(10_000) },
      )
      if (!res.ok) continue
      const data  = await res.json()
      const pairs = (data.pairs ?? []) as Array<{
        baseToken?: { address?: string }
        chainId?:   string
        marketCap?: number
        liquidity?: { usd?: number }
        priceUsd?:  string
        fdv?:       number
      }>
      const bestByMint = new Map<string, { mcap: number; liq: number }>()
      for (const p of pairs) {
        const mint = p.baseToken?.address
        if (!mint || (p.chainId && p.chainId !== 'solana')) continue
        let mcap = p.marketCap ?? 0
        if (!mcap && p.fdv) mcap = p.fdv
        if (!mcap && p.priceUsd) mcap = parseFloat(p.priceUsd) * 1_000_000_000
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
  return result
}

// ── Handler GET ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  const sp        = req.nextUrl.searchParams
  const minTokens = Math.max(1, parseInt(sp.get('min_tokens') ?? '5', 10))

  // ── 1. Tous les achats (ordre chronologique → premier achat en tête) ──────────
  // Paginated to bypass Supabase's 1 000-row default limit.
  type BuyRow = {
    wallet_address:    string
    wallet_label:      string | null
    token_mint:        string
    market_cap_at_buy: number | null
    bought_at:         string
  }
  const allBuys: BuyRow[] = []
  const BUY_PAGE = 1000
  let buyOffset  = 0
  while (true) {
    const { data, error: buysErr } = await supabase
      .from('kymia_risque_buys')
      .select('wallet_address, wallet_label, token_mint, market_cap_at_buy, bought_at')
      .order('bought_at', { ascending: true })
      .range(buyOffset, buyOffset + BUY_PAGE - 1)
    if (buysErr) return NextResponse.json({ error: buysErr.message }, { status: 500 })
    allBuys.push(...((data ?? []) as BuyRow[]))
    if ((data ?? []).length < BUY_PAGE) break
    buyOffset += BUY_PAGE
  }

  // ── 2. Tokens table AVANT DexScreener update — proxy entry mcap + MFE ─────────
  // Chargé ici pour que kymia_risque_tokens.market_cap_usd soit encore "historique"
  // (pas encore écrasé par les valeurs DexScreener de ce run).
  const { data: tokenRows } = await supabase
    .from('kymia_risque_tokens')
    .select('mint, market_cap_usd, mfe_mult_24h, mfe_stop_hit_first, mfe_trail_activated, mfe_computed_at')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TokenRow = { mint: string; market_cap_usd: number | null; mfe_mult_24h: number | null; mfe_stop_hit_first: boolean | null; mfe_trail_activated: boolean | null; mfe_computed_at: string | null }
  const tokenProxyMcap = new Map<string, number>()   // mcap proxy pour les achats sans entry mcap
  const tokenMfe       = new Map<string, { mult: number; stopHitFirst: boolean; trailActivated: boolean }>()

  for (const t of (tokenRows ?? []) as TokenRow[]) {
    if ((t.market_cap_usd ?? 0) > 0) tokenProxyMcap.set(t.mint, t.market_cap_usd!)
    if (t.mfe_computed_at && t.mfe_mult_24h !== null) {
      tokenMfe.set(t.mint, {
        mult:          t.mfe_mult_24h,
        stopHitFirst:  t.mfe_stop_hit_first ?? false,
        trailActivated: t.mfe_trail_activated ?? false,
      })
    }
  }

  // ── 3. Premier achat par (wallet, token) avec entry mcap (exact ou proxy) ─────
  type PairEntry = {
    walletAddress:    string
    walletLabel:      string
    tokenMint:        string
    entryMcap:        number | null
    entryMcapSource:  'exact' | 'estimated' | 'none'
  }

  const firstBuy = new Map<string, PairEntry>()

  for (const b of allBuys) {
    const key = `${b.wallet_address}::${b.token_mint}`
    if (!firstBuy.has(key)) {
      const exactMcap   = b.market_cap_at_buy && b.market_cap_at_buy > 0 ? b.market_cap_at_buy : null
      const proxyMcap   = exactMcap === null ? (tokenProxyMcap.get(b.token_mint) ?? null) : null
      const entryMcap   = exactMcap ?? proxyMcap
      const source      = exactMcap ? 'exact' : proxyMcap ? 'estimated' : 'none'
      firstBuy.set(key, {
        walletAddress:   b.wallet_address,
        walletLabel:     b.wallet_label ?? b.wallet_address.slice(0, 8),
        tokenMint:       b.token_mint,
        entryMcap,
        entryMcapSource: source,
      })
    }
  }

  const allPairs    = [...firstBuy.values()]
  const gradedPairs = allPairs.filter(p => p.entryMcap !== null && p.entryMcap > 0)
  const allMints    = [...new Set(allPairs.map(p => p.tokenMint))]   // tous les mints pour le DexScreener update

  console.log(
    `[wallet-winrate] ${allPairs.length} paires totales → ${gradedPairs.length} classifiables` +
    ` (${gradedPairs.filter(p => p.entryMcapSource === 'exact').length} exactes,` +
    ` ${gradedPairs.filter(p => p.entryMcapSource === 'estimated').length} estimées,` +
    ` ${allPairs.length - gradedPairs.length} sans mcap)`
  )

  // ── 4. Prix SOL ───────────────────────────────────────────────────────────────
  let solPriceUsd = 150
  try { solPriceUsd = await fetchSolPriceUsd() } catch { /* fallback */ }

  // ── 5. Mcap actuel DexScreener (sur TOUS les mints) ──────────────────────────
  const currentMcaps = await fetchCurrentMcaps(allMints, solPriceUsd)
  const liveMints = [...currentMcaps.values()].filter(mc => mc > 0).length
  const deadMints = allMints.length - liveMints

  // ── 6. Upsert kymia_risque_tokens avec mcap actuel (lots de 50) ───────────────
  const now = new Date().toISOString()
  const tokenUpserts = allMints.map(mint => ({
    mint,
    market_cap_usd: currentMcaps.get(mint) || null,
    updated_at:     now,
  }))
  for (let i = 0; i < tokenUpserts.length; i += 50) {
    const { error: upsertErr } = await supabase
      .from('kymia_risque_tokens')
      .upsert(tokenUpserts.slice(i, i + 50), { onConflict: 'mint' })
    if (upsertErr) console.warn(`[wallet-winrate] upsert tokens batch ${i}: ${upsertErr.message}`)
  }

  // ── 7. Stats par wallet ───────────────────────────────────────────────────────
  type TokenEntry = {
    mint:              string
    entry_mcap:        number
    current_mcap:      number
    mult:              number
    entry_mcap_source: 'exact' | 'estimated'
  }
  type MfeStats = {
    tokens_with_data: number
    pct_x15:  string;  pct_x2:  string;  pct_x3: string
    pct_stop_before_trail: string
  }
  type WalletStats = {
    wallet_address:   string
    wallet_label:     string
    nb_tokens:        number
    win_rate:         number
    x2:  number;  x5: number;  x10: number
    down50:           number
    median_mult:      number
    mfe:              MfeStats | null
    top_tokens:       TokenEntry[]
  }

  const walletMap = new Map<string, {
    address: string; label: string
    mults:   number[]; tokens: TokenEntry[]
  }>()

  for (const pair of gradedPairs) {
    const currentMc = currentMcaps.get(pair.tokenMint) ?? 0
    const mult      = currentMc / pair.entryMcap!

    if (!walletMap.has(pair.walletAddress)) {
      walletMap.set(pair.walletAddress, { address: pair.walletAddress, label: pair.walletLabel, mults: [], tokens: [] })
    }
    const w = walletMap.get(pair.walletAddress)!
    w.mults.push(mult)
    w.tokens.push({
      mint:              pair.tokenMint,
      entry_mcap:        Math.round(pair.entryMcap!),
      current_mcap:      Math.round(currentMc),
      mult:              parseFloat(mult.toFixed(3)),
      entry_mcap_source: pair.entryMcapSource as 'exact' | 'estimated',
    })
  }

  const rankings: WalletStats[] = []

  for (const [, w] of walletMap) {
    if (w.mults.length < minTokens) continue

    const nb   = w.mults.length
    const wins = w.mults.filter(m => m > 1).length

    // MFE stats pour ce wallet (tokens avec données GeckoTerminal disponibles)
    const mfeTokens = w.tokens.filter(t => tokenMfe.has(t.mint))
    let mfe: MfeStats | null = null
    if (mfeTokens.length > 0) {
      const n             = mfeTokens.length
      const mfeMults      = mfeTokens.map(t => tokenMfe.get(t.mint)!.mult)
      const stopBefore    = mfeTokens.filter(t => tokenMfe.get(t.mint)!.stopHitFirst).length
      const pct = (k: number) => ((k / n) * 100).toFixed(1)
      mfe = {
        tokens_with_data:     n,
        pct_x15:              pct(mfeMults.filter(m => m >= 1.5).length),
        pct_x2:               pct(mfeMults.filter(m => m >= 2.0).length),
        pct_x3:               pct(mfeMults.filter(m => m >= 3.0).length),
        pct_stop_before_trail: pct(stopBefore),
      }
    }

    rankings.push({
      wallet_address: w.address,
      wallet_label:   w.label,
      nb_tokens:      nb,
      win_rate:       parseFloat(((wins / nb) * 100).toFixed(1)),
      x2:             w.mults.filter(m => m >= 2).length,
      x5:             w.mults.filter(m => m >= 5).length,
      x10:            w.mults.filter(m => m >= 10).length,
      down50:         w.mults.filter(m => m <= 0.5).length,
      median_mult:    parseFloat(median(w.mults).toFixed(3)),
      mfe,
      top_tokens:     [...w.tokens].sort((a, b) => b.mult - a.mult).slice(0, 10),
    })
  }

  rankings.sort((a, b) =>
    b.win_rate !== a.win_rate ? b.win_rate - a.win_rate : b.median_mult - a.median_mult
  )

  const excluded = [...walletMap.entries()]
    .filter(([, w]) => w.mults.length < minTokens)
    .map(([address, w]) => ({ address, label: w.label, nb_tokens: w.mults.length }))

  return NextResponse.json({
    ok:          true,
    snapshot_at: now,
    sol_price:   solPriceUsd,
    coverage: {
      total_buys:         allBuys.length,
      total_pairs:        allPairs.length,
      graded_pairs:       gradedPairs.length,
      entry_exact:        gradedPairs.filter(p => p.entryMcapSource === 'exact').length,
      entry_estimated:    gradedPairs.filter(p => p.entryMcapSource === 'estimated').length,
      no_entry_mcap:      allPairs.length - gradedPairs.length,
      total_mints:        allMints.length,
      live_mints:         liveMints,
      dead_mints:         deadMints,
      mfe_computed_mints: tokenMfe.size,
    },
    min_tokens:       minTokens,
    ranked:           rankings.length,
    rankings,
    excluded_wallets: excluded,
  })
}
