// lib/memecoin/screen.ts
// KYMIA Phase 1 — Pipeline de screening R8 (7 checks) — observation uniquement.
// Aucun swap, aucun capital réel.

import { SupabaseClient } from '@supabase/supabase-js'
import { PublicKey } from '@solana/web3.js'
import { getConnection } from '@/lib/solana/wallet'
import { getQuote, toRawAmount } from '@/lib/solana/jupiter'

const DEXSCREENER = 'https://api.dexscreener.com'
const RUGCHECK    = 'https://api.rugcheck.xyz/v1'
const USDC_MINT   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckResult = 'passed' | 'failed' | 'skipped'

export interface CheckEntry {
  result: CheckResult
  detail: Record<string, any>
}

export interface ScreenResult {
  mint:               string
  symbol:             string
  name:               string
  age_hours:          number
  volume_24h:         number
  liquidity_usd:      number
  price_usd:          number
  check1:             CheckEntry
  check2:             CheckEntry
  check3:             CheckEntry
  check4:             CheckEntry
  check5:             CheckEntry
  check6:             CheckEntry
  check7:             CheckEntry
  checks_skipped:     number
  eligible:           boolean
  eligible_grade:     'FULL' | 'PARTIAL' | 'WEAK' | null
  first_failed_check: string | null
  fail_reason:        string | null
}

export interface DexPair {
  pairAddress:   string
  dexId:         string
  baseToken:     { address: string; symbol: string; name: string }
  quoteToken:    { address: string; symbol: string }
  priceUsd:      string
  priceChange?:  { h1?: number; h6?: number; h24?: number }
  liquidity?:    { usd: number }
  volume?:       { h24: number; h1?: number }
  pairCreatedAt: number   // ms epoch
  info?:         { holders?: number }
}

// ── DexScreener — découverte + déduplication ──────────────────────────────────

export async function discoverCandidates(
  supabase: SupabaseClient
): Promise<Array<{ mint: string; pair: DexPair }>> {
  // 1a. Fetch token-profiles/latest/v1 (tokens récents avec profil)
  let profileMints: string[] = []
  try {
    const res = await fetch(`${DEXSCREENER}/token-profiles/latest/v1`, {
      headers: { 'User-Agent': 'KYMIA/1.0' },
      signal:  AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const profiles: Array<{ chainId: string; tokenAddress: string }> = await res.json()
      profileMints = profiles.filter(p => p.chainId === 'solana').map(p => p.tokenAddress)
    } else {
      console.log(`[memecoin] DexScreener profiles HTTP ${res.status}`)
    }
  } catch (e: any) {
    console.log(`[memecoin] DexScreener profiles fetch error: ${e.message}`)
  }

  // 1b. Fetch token-boosts/top/v1 (tokens boostés = traction, souvent > 24h)
  let boostMints: string[] = []
  try {
    const res = await fetch(`${DEXSCREENER}/token-boosts/top/v1`, {
      headers: { 'User-Agent': 'KYMIA/1.0' },
      signal:  AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const boosts: Array<{ chainId: string; tokenAddress: string }> = await res.json()
      boostMints = boosts.filter(b => b.chainId === 'solana').map(b => b.tokenAddress)
    } else {
      console.log(`[memecoin] DexScreener boosts HTTP ${res.status}`)
    }
  } catch (e: any) {
    console.log(`[memecoin] DexScreener boosts fetch error: ${e.message}`)
  }

  // 2. Merge & deduplicate (Set préserve l'ordre d'insertion)
  const merged = [...new Set([...profileMints, ...boostMints])]
  console.log(
    `[memecoin] discovery: ${profileMints.length} profils + ${boostMints.length} boosts` +
    ` → ${merged.length} uniques solana`
  )

  if (!merged.length) return []

  // 3. DB dedup: skip mints déjà vus dans les 6h (passed, failed, ou PREFILTER)
  const since = new Date(Date.now() - 6 * 3600_000).toISOString()
  const { data: recent } = await supabase
    .from('kymia_memecoin_screens')
    .select('mint')
    .gt('screened_at', since)
  const seen  = new Set(((recent as any[]) || []).map(r => r.mint as string))
  const fresh = merged.filter(m => !seen.has(m)).slice(0, 40)  // max 40 fetches pair-data

  console.log(
    `[memecoin] discovery: ${merged.length} uniques, ${merged.length - fresh.length} déjà vus (6h),` +
    ` ${fresh.length} à évaluer`
  )

  if (!fresh.length) return []

  // 4. Per-token pair data + pré-filtre (age > 24h AND vol > 500k)
  //    Budget temps : max 25 candidats retenus pour les 7 checks.
  //    Les rejetés sont insérés en base (PREFILTER) pour la dédup 6h.
  const candidates: Array<{ mint: string; pair: DexPair }> = []
  const now = new Date().toISOString()

  for (const mint of fresh) {
    if (candidates.length >= 25) break  // plafond : 25 tokens à screener

    const tokenUrl = `${DEXSCREENER}/latest/dex/tokens/${mint}`
    try {
      const res = await fetch(tokenUrl, {
        headers: { 'User-Agent': 'KYMIA/1.0' },
        signal:  AbortSignal.timeout(6000),
      })
      if (!res.ok) {
        console.log(`[memecoin] DexScreener tokens HTTP ${res.status} — ${tokenUrl}`)
        continue
      }

      const data  = await res.json()
      const pairs = (data.pairs || []) as DexPair[]
      const pair  = pairs
        .filter(p => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'SOL')
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
      if (!pair?.pairCreatedAt) continue

      const ageHours = (Date.now() - pair.pairCreatedAt) / 3_600_000
      const vol24h   = pair.volume?.h24 ?? 0
      const liqUsd   = pair.liquidity?.usd ?? 0
      const priceUsd = parseFloat(pair.priceUsd || '0')

      if (ageHours < 24 || vol24h < 500_000) {
        const failReason = ageHours < 24
          ? `age ${ageHours.toFixed(1)}h < 24h`
          : `vol $${Math.round(vol24h / 1000)}k < $500k`

        // Insère le rejet PREFILTER en base — bloque le re-log pendant 6h via dédup
        await supabase.from('kymia_memecoin_screens').insert({
          mint,
          symbol:             pair.baseToken.symbol,
          name:               pair.baseToken.name,
          age_hours:          parseFloat(ageHours.toFixed(1)),
          volume_24h:         vol24h,
          liquidity_usd:      liqUsd,
          price_usd:          priceUsd,
          eligible:           false,
          first_failed_check: 'PREFILTER',
          fail_reason:        failReason,
          screened_at:        now,
        })

        console.log(
          `[memecoin] PREFILTER: ${pair.baseToken.symbol} (${mint.slice(0, 8)}…) — ${failReason}`
        )
        continue
      }

      candidates.push({ mint, pair })
    } catch (e: any) {
      console.log(`[memecoin] DexScreener tokens fetch error: ${e.message} — ${tokenUrl}`)
    }
  }

  console.log(
    `[memecoin] pré-filtre: ${candidates.length} candidats retenus sur ${fresh.length}` +
    ` (${fresh.length - candidates.length} rejetés / sans pair-data)`
  )

  return candidates
}

// ── RugCheck — fetch unique (partagé par checks 2, 3, 6, 7) ──────────────────

async function fetchRugCheck(mint: string): Promise<any | null> {
  try {
    const res = await fetch(`${RUGCHECK}/tokens/${mint}/report/summary`, {
      headers: { 'User-Agent': 'KYMIA/1.0' },
      signal:  AbortSignal.timeout(8000),
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

// ── CHECK 1 — Mint / Freeze authority (RPC) ───────────────────────────────────

async function runCheck1(mint: string): Promise<CheckEntry> {
  try {
    const conn = getConnection()
    const info = await conn.getParsedAccountInfo(new PublicKey(mint))
    const parsed = (info.value?.data as any)?.parsed?.info

    if (!parsed) {
      return { result: 'skipped', detail: { reason: 'cannot parse mint account' } }
    }

    const mintAuth   = parsed.mintAuthority   ?? null
    const freezeAuth = parsed.freezeAuthority ?? null

    if (mintAuth !== null || freezeAuth !== null) {
      return { result: 'failed', detail: { mint_authority: mintAuth, freeze_authority: freezeAuth } }
    }
    return { result: 'passed', detail: { mint_authority: null, freeze_authority: null } }
  } catch (e: any) {
    return { result: 'skipped', detail: { reason: e.message } }
  }
}

// ── CHECK 2 — Liquidity + LP locked ──────────────────────────────────────────

function runCheck2(pair: DexPair, rug: any | null): CheckEntry {
  const liqUsd = pair.liquidity?.usd ?? 0

  if (liqUsd < 50_000) {
    return { result: 'failed', detail: { liquidity_usd: liqUsd, reason: 'liquidity < $50k' } }
  }

  if (!rug) {
    return {
      result: 'skipped',
      detail: { liquidity_usd: liqUsd, lp_locked_pct: null, reason: 'rugcheck unavailable' },
    }
  }

  // Primary: RugCheck top-level aggregate (present on all tokens incl. Token-2022)
  const topLevel   = typeof rug.lpLockedPct === 'number' ? rug.lpLockedPct : 0
  // Fallback: markets[] scan (detailed response, classic SPL tokens)
  const markets    = (rug.markets as any[]) || []
  const fromMkts   = markets.reduce((max, m) => {
    const pct = Number(m.lp?.lockedPct ?? m.lp?.locked_pct ?? 0)
    return Math.max(max, pct)
  }, 0)
  const lpLockedPct = Math.max(topLevel, fromMkts)

  // Minimal response detection: RugCheck returned no useful LP data
  // (no markets, lpLockedPct=0, no risks) → status unverifiable, not a failure.
  // Token continues to checks 3-7; if eligible, grade will be PARTIAL/WEAK.
  const risks        = (rug.risks as any[]) || []
  const isMinimal    = !markets.length && lpLockedPct === 0 && risks.length === 0
  if (isMinimal) {
    return {
      result: 'skipped',
      detail: { liquidity_usd: liqUsd, lp_locked_pct: null, reason: 'rugcheck minimal response — LP status unverifiable' },
    }
  }

  if (lpLockedPct < 80) {
    return { result: 'failed', detail: { liquidity_usd: liqUsd, lp_locked_pct: lpLockedPct, reason: 'LP locked < 80%' } }
  }
  return { result: 'passed', detail: { liquidity_usd: liqUsd, lp_locked_pct: lpLockedPct } }
}

// ── CHECK 3 — Holder distribution ────────────────────────────────────────────

function runCheck3(rug: any | null): CheckEntry {
  if (!rug) {
    return { result: 'skipped', detail: { reason: 'rugcheck unavailable' } }
  }

  const holders  = (rug.topHolders as any[]) || []
  const nonPool  = holders.filter(h => !h.insider && h.pct !== undefined)
  const top10Pct = nonPool.slice(0, 10).reduce((s, h) => s + Number(h.pct), 0)
  const maxSingle = Math.max(...nonPool.map(h => Number(h.pct)), 0)

  if (top10Pct > 30) {
    return { result: 'failed', detail: { top10_pct: top10Pct, max_single_pct: maxSingle, reason: 'top10 > 30%' } }
  }
  if (maxSingle > 10) {
    return { result: 'failed', detail: { top10_pct: top10Pct, max_single_pct: maxSingle, reason: 'single holder > 10%' } }
  }
  return { result: 'passed', detail: { top10_pct: parseFloat(top10Pct.toFixed(2)), max_single_pct: parseFloat(maxSingle.toFixed(2)) } }
}

// ── CHECK 4 — Honeypot / sellability (Jupiter SELL quote) ────────────────────

async function runCheck4(mint: string, pair: DexPair): Promise<CheckEntry> {
  try {
    // Estimate $10 worth of the token in raw units (assume 6 decimals)
    const priceUsd = parseFloat(pair.priceUsd || '0')
    const tokenUnits = priceUsd > 0 ? 10 / priceUsd : 1_000_000
    const rawAmount  = toRawAmount(Math.min(tokenUnits, 1e12), 6)

    const quote = await getQuote(mint, USDC_MINT, rawAmount, 200)  // 2% slippage tolerance for sell test
    const impact = Math.abs(parseFloat(quote.priceImpactPct))

    if (impact > 10) {
      return { result: 'failed', detail: { price_impact_pct: impact, reason: 'sell price impact > 10%' } }
    }
    return { result: 'passed', detail: { price_impact_pct: parseFloat(impact.toFixed(3)), out_amount: quote.outAmount } }
  } catch (e: any) {
    const isNoRoute = /no route|No route|cannot find/i.test(e.message ?? '')
    return {
      result: isNoRoute ? 'failed' : 'skipped',
      detail: { reason: isNoRoute ? 'no sell route — likely honeypot' : e.message },
    }
  }
}

// ── CHECK 5 — Âge + volume + holders ────────────────────────────────────────

function runCheck5(pair: DexPair): CheckEntry {
  const ageHours = (Date.now() - pair.pairCreatedAt) / 3_600_000
  const vol24h   = pair.volume?.h24 ?? 0
  const holders  = pair.info?.holders ?? null

  if (ageHours < 24) {
    return { result: 'failed', detail: { age_hours: parseFloat(ageHours.toFixed(1)), reason: 'age < 24h' } }
  }
  if (vol24h < 500_000) {
    return { result: 'failed', detail: { age_hours: parseFloat(ageHours.toFixed(1)), volume_24h: vol24h, reason: 'volume < $500k' } }
  }
  if (holders !== null && holders < 500) {
    return { result: 'failed', detail: { age_hours: parseFloat(ageHours.toFixed(1)), volume_24h: vol24h, holders, reason: 'holders < 500' } }
  }
  return {
    result: 'passed',
    detail: { age_hours: parseFloat(ageHours.toFixed(1)), volume_24h: vol24h, holders: holders ?? 'unknown' },
  }
}

// ── CHECK 6 — Score RugCheck global ──────────────────────────────────────────

function runCheck6(rug: any | null): CheckEntry {
  if (!rug) {
    return { result: 'skipped', detail: { reason: 'rugcheck unavailable' } }
  }

  const score        = rug.score ?? rug.rating ?? null
  const risks        = (rug.risks as any[]) || []
  const criticals    = risks.filter(r => r.level === 'danger')

  if (score === 'danger' || criticals.length > 0) {
    return {
      result: 'failed',
      detail: {
        score,
        critical_risks: criticals.map(r => r.name),
        reason: criticals.length > 0
          ? `critical risks: ${criticals.map(r => r.name).join(', ')}`
          : 'score = danger',
      },
    }
  }
  return { result: 'passed', detail: { score, total_risks: risks.length } }
}

// ── CHECK 7 — Bundle / insiders (RugCheck partial + SKIPPED pour RPC) ────────

function runCheck7(rug: any | null): CheckEntry {
  // Parts covered by RPC/Helius — deferred to Phase D
  const SKIPPED_PARTS = [
    'first-block-bundle-rpc',
    'cluster-funding-sources-rpc',
    'deployer-history-rpc',
  ]

  if (!rug) {
    return {
      result: 'skipped',
      detail: { reason: 'rugcheck unavailable — all bundle detection skipped', skipped_parts: SKIPPED_PARTS },
    }
  }

  const topHolders      = (rug.topHolders as any[]) || []
  const insiderNetworks = (rug.insiderNetworks ?? rug.insider_networks ?? []) as any[]

  // Creator still holding > 5%?
  const creatorEntry = topHolders.find(h => h.isCreator || h.is_creator)
  const creatorPct   = creatorEntry ? Number(creatorEntry.pct) : 0

  if (creatorPct > 5) {
    return {
      result: 'failed',
      detail: { creator_pct: creatorPct, reason: 'creator holds > 5%', skipped_parts: SKIPPED_PARTS },
    }
  }

  // Insider network combined holdings > 20%?
  const insiderPct = insiderNetworks.reduce(
    (s, n) => s + Number(n.holdingPct ?? n.holding_pct ?? 0), 0
  )
  if (insiderPct > 20) {
    return {
      result: 'failed',
      detail: { insider_pct: insiderPct, reason: 'insider networks > 20%', skipped_parts: SKIPPED_PARTS },
    }
  }

  return {
    result: 'passed',
    detail: {
      creator_pct: parseFloat(creatorPct.toFixed(2)),
      insider_pct: parseFloat(insiderPct.toFixed(2)),
      skipped_parts: SKIPPED_PARTS,
      note: 'partial coverage — RPC bundle detection deferred to Phase D',
    },
  }
}

// ── screenToken — orchestre les 7 checks (fail-fast après chaque check) ───────

export async function screenToken(
  mint: string,
  pair: DexPair,
  rug:  any | null
): Promise<ScreenResult> {
  const checks: Record<string, CheckEntry> = {}
  let firstFailed: string | null = null
  let failReason:  string | null = null

  const record = (key: string, entry: CheckEntry) => {
    checks[key] = entry
    if (firstFailed === null && entry.result === 'failed') {
      firstFailed = key
      failReason  = String(entry.detail?.reason ?? 'failed')
    }
  }

  const skip = (key: string) => {
    checks[key] = { result: 'skipped', detail: { reason: 'upstream check failed' } }
  }

  record('check1', await runCheck1(mint))

  if (!firstFailed) record('check2', runCheck2(pair, rug)); else skip('check2')
  if (!firstFailed) record('check3', runCheck3(rug));       else skip('check3')
  if (!firstFailed) record('check4', await runCheck4(mint, pair)); else skip('check4')

  // CHECK 5 always recorded (it's the basis of the pre-filter)
  record('check5', runCheck5(pair))

  if (!firstFailed) record('check6', runCheck6(rug)); else skip('check6')
  if (!firstFailed) record('check7', runCheck7(rug)); else skip('check7')

  // Count genuine skips (not "upstream failed" skips — those are consequences, not real skips)
  const genuineSkips = Object.values(checks).filter(
    c => c.result === 'skipped' && c.detail?.reason !== 'upstream check failed'
  ).length

  const eligible = firstFailed === null
  const grade: 'FULL' | 'PARTIAL' | 'WEAK' | null = eligible
    ? genuineSkips === 0 ? 'FULL'
    : genuineSkips <= 2  ? 'PARTIAL'
    : 'WEAK'
    : null

  return {
    mint,
    symbol:             pair.baseToken.symbol,
    name:               pair.baseToken.name,
    age_hours:          parseFloat(((Date.now() - pair.pairCreatedAt) / 3_600_000).toFixed(1)),
    volume_24h:         pair.volume?.h24 ?? 0,
    liquidity_usd:      pair.liquidity?.usd ?? 0,
    price_usd:          parseFloat(pair.priceUsd || '0'),
    check1:             checks['check1'],
    check2:             checks['check2'],
    check3:             checks['check3'],
    check4:             checks['check4'],
    check5:             checks['check5'],
    check6:             checks['check6'],
    check7:             checks['check7'],
    checks_skipped:     genuineSkips,
    eligible,
    eligible_grade:     grade,
    first_failed_check: firstFailed,
    fail_reason:        failReason,
  }
}

// ── runMemeScreening — point d'entrée principal ───────────────────────────────

export async function runMemeScreening(
  supabase: SupabaseClient
): Promise<{ screened: number; eligible: number; opened: number }> {
  const candidates = await discoverCandidates(supabase)
  console.log(`[memecoin] ${candidates.length} candidat(s) à screener`)

  let eligible = 0
  let opened   = 0

  for (const { mint, pair } of candidates) {
    try {
      const rug    = await fetchRugCheck(mint)
      const result = await screenToken(mint, pair, rug)

      await supabase.from('kymia_memecoin_screens').insert({
        mint:               result.mint,
        symbol:             result.symbol,
        name:               result.name,
        age_hours:          result.age_hours,
        volume_24h:         result.volume_24h,
        liquidity_usd:      result.liquidity_usd,
        price_usd:          result.price_usd,
        check1_result: result.check1.result, check1_detail: result.check1.detail,
        check2_result: result.check2.result, check2_detail: result.check2.detail,
        check3_result: result.check3.result, check3_detail: result.check3.detail,
        check4_result: result.check4.result, check4_detail: result.check4.detail,
        check5_result: result.check5.result, check5_detail: result.check5.detail,
        check6_result: result.check6.result, check6_detail: result.check6.detail,
        check7_result: result.check7.result, check7_detail: result.check7.detail,
        checks_skipped:     result.checks_skipped,
        eligible:           result.eligible,
        eligible_grade:     result.eligible_grade,
        first_failed_check: result.first_failed_check,
        fail_reason:        result.fail_reason,
      })

      if (result.eligible) {
        eligible++

        // ── Filtre momentum h6 (R9) ────────────────────────────────────────
        // Ne pas entrer si le token a déjà fait > +80% dans les 6 dernières heures.
        // Si la donnée manque (null), on ne bloque pas.
        const h6Change = pair.priceChange?.h6 ?? null
        if (h6Change !== null && h6Change > 80) {
          console.log(
            `[memecoin] H6_SKIP: ${result.symbol} (${result.mint.slice(0, 8)}…)` +
            ` h6=+${h6Change.toFixed(1)}% > 80% — achat de sommet évité`
          )
        } else {
          // openPaperTrade imported from paper.ts to avoid circular deps
          const { openPaperTrade } = await import('./paper')
          const wasOpened = await openPaperTrade(supabase, result.mint, result.symbol, result.price_usd)
          if (wasOpened) opened++
          console.log(
            `[memecoin] ELIGIBLE: ${result.symbol} (${result.mint.slice(0, 8)}…)` +
            ` grade=${result.eligible_grade} skips=${result.checks_skipped}` +
            ` h6=${h6Change !== null ? '+' + h6Change.toFixed(1) + '%' : 'n/a'} opened=${wasOpened}`
          )
        }
      } else {
        console.log(
          `[memecoin] REJECTED: ${result.symbol} — ${result.first_failed_check}: ${result.fail_reason}`
        )
      }
    } catch (e: any) {
      console.error(`[memecoin] screen error ${mint.slice(0, 8)}…: ${e.message}`)
    }
  }

  console.log(`[memecoin] screening terminé: ${candidates.length} screenés, ${eligible} éligibles, ${opened} trades fictifs ouverts`)
  return { screened: candidates.length, eligible, opened }
}
