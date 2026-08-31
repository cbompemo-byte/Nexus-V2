// lib/smartmoney/audit.ts
// Smart Money — Étape 1 : audit des wallets candidats.
// Observation pure, aucun trade, aucun signal.
//
// Budget Helius :
//   - 1 crédit par transaction fetchée (conservative estimate)
//   - Max 500 txs/wallet pour ne pas épuiser le quota
//   - Garde-fou : job s'arrête si > 80% du quota mensuel consommé
//
// PnL :
//   - pnl_90d_sol  : exact, calculé depuis les montants de swap SOL-dénominés
//   - pnl_90d_usdc : exact, calculé depuis les montants de swap USDC-dénominés
//   - Jamais d'estimation, jamais de conversion avec prix approximatif
//   - null = DATA_UNAVAILABLE

import { SupabaseClient } from '@supabase/supabase-js'

// ── Config ────────────────────────────────────────────────────────────────────

const HELIUS_API_KEY     = process.env.NEXT_PUBLIC_HELIEUS_KEY ?? ''
const HELIUS_BASE        = 'https://api.helius.xyz/v0'
const USDC_MINT          = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL_MINT          = 'So11111111111111111111111111111111111111112'
const LAMPORTS_PER_SOL   = 1_000_000_000
const NINETY_DAYS_MS     = 90 * 24 * 3600_000
const MAX_TXS_PER_WALLET = 500    // cap crédits : 500/wallet → ~250 crédits (5 pages × 100 txs)
const WALLETS_PER_RUN    = 3      // wallets audités par appel cron

// Seuils bot — swap_count utilisé comme proxy (fetching type=SWAP uniquement)
const BOT_SWAP_COUNT_MAX      = 1500   // > 1500 swaps/90j = bot
const BOT_MEDIAN_HOLD_MAX_S   = 120    // médiane < 2 min = MEV/arb
const BOT_FAILED_RATIO_MAX    = 0.25   // > 25% swaps échoués = bot compétitif
const BOT_TOKENS_PER_DAY_MAX  = 15     // > 15 tokens uniques/jour = scatter bot

// ── Types internes ────────────────────────────────────────────────────────────

interface HeliusTx {
  signature:        string
  timestamp:        number   // unix seconds
  transactionError: unknown  // null = succès, objet = échec
  type:             string
  events?: {
    swap?: {
      nativeInput?:   { amount: string }
      nativeOutput?:  { amount: string }
      tokenInputs?:   Array<{ mint: string; tokenAmount: number }>
      tokenOutputs?:  Array<{ mint: string; tokenAmount: number }>
    }
  }
}

interface SwapEvent {
  signature:   string
  timestamp:   number   // unix seconds
  mint:        string   // token négocié (jamais SOL ni USDC)
  side:        'BUY' | 'SELL'
  solAmount:   number | null   // SOL dépensé/reçu (null si USDC-dénominé)
  usdcAmount:  number | null   // USDC dépensé/reçu (null si SOL-dénominé)
  tokenAmount: number
}

interface WalletMetrics {
  swapCount:          number
  failedSwapRatio:    number
  uniqueTokensPerDay: number
  medianHoldSeconds:  number | null
  avgHoldHours:       number | null
  winRate:            number | null
  tradesClosed:       number   // paires BUY/SELL avec PnL mesurable (SOL-SOL ou USDC-USDC)
  tradesMixedDenom:   number   // paires matchées FIFO mais devise incompatible — observation seule
  pnl90dSol:         number | null
  pnl90dUsdc:        number | null
}

// ── Quota Helius ──────────────────────────────────────────────────────────────

interface QuotaState {
  creditsUsed:  number
  creditsLimit: number
  guardPct:     number
  blocked:      boolean
}

async function checkAndResetQuota(supabase: SupabaseClient): Promise<QuotaState> {
  const currentMonth = new Date().toISOString().slice(0, 7)   // '2026-08'

  const { data, error } = await supabase
    .from('kymia_helius_quota')
    .select('*')
    .eq('id', 1)
    .single()

  if (error || !data) {
    console.error('[smartmoney] quota fetch error:', error?.message ?? 'no row')
    // Fail open — ne bloque pas le job si la table est inaccessible
    return { creditsUsed: 0, creditsLimit: 100_000, guardPct: 80, blocked: false }
  }

  // Reset automatique si nouveau mois
  if (data.month_year !== currentMonth) {
    await supabase.from('kymia_helius_quota').update({
      month_year:         currentMonth,
      credits_used:       0,
      guard_triggered_at: null,
      updated_at:         new Date().toISOString(),
    }).eq('id', 1)
    console.log(`[smartmoney] quota reset → ${currentMonth}`)
    return { creditsUsed: 0, creditsLimit: data.credits_limit, guardPct: data.guard_pct, blocked: false }
  }

  const threshold = Math.floor(data.credits_limit * data.guard_pct / 100)
  const blocked   = data.credits_used >= threshold
  return {
    creditsUsed:  data.credits_used,
    creditsLimit: data.credits_limit,
    guardPct:     data.guard_pct,
    blocked,
  }
}

async function incrementQuota(supabase: SupabaseClient, credits: number): Promise<void> {
  const now = new Date().toISOString()

  const { data } = await supabase
    .from('kymia_helius_quota')
    .select('credits_used, credits_limit, guard_pct')
    .eq('id', 1)
    .single()

  if (!data) return

  const newTotal  = data.credits_used + credits
  const threshold = Math.floor(data.credits_limit * data.guard_pct / 100)
  const hit       = newTotal >= threshold

  await supabase.from('kymia_helius_quota').update({
    credits_used:       newTotal,
    guard_triggered_at: hit ? now : null,
    updated_at:         now,
  }).eq('id', 1)

  if (hit) {
    console.warn(
      `[smartmoney] QUOTA GUARD TRIGGERED — ${newTotal}/${data.credits_limit} crédits` +
      ` (${data.guard_pct}% seuil). Job suspendu jusqu'au mois prochain.`
    )
  }
}

// ── Helius fetch (une page de 100 txs max) ────────────────────────────────────

interface PageResult {
  txs:          HeliusTx[]
  creditsUsed:  number
  nextCursor:   string | null
  hitTimeLimit: boolean
}

async function fetchSwapPage(
  address:   string,
  cursor:    string | null,
  cutoffMs:  number,
): Promise<PageResult> {
  const url = new URL(`${HELIUS_BASE}/addresses/${address}/transactions`)
  url.searchParams.set('api-key', HELIUS_API_KEY)
  url.searchParams.set('type',    'SWAP')
  url.searchParams.set('limit',   '100')
  if (cursor) url.searchParams.set('before', cursor)

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'KYMIA/1.0' },
    signal:  AbortSignal.timeout(12_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Helius HTTP ${res.status}: ${body.slice(0, 200)}`)
  }

  const txs: HeliusTx[] = await res.json()
  if (!Array.isArray(txs) || txs.length === 0) {
    return { txs: [], creditsUsed: 1, nextCursor: null, hitTimeLimit: false }
  }

  // Filtre la fenêtre 90 jours
  const inWindow    = txs.filter(t => t.timestamp * 1000 >= cutoffMs)
  const hitTimeLimit = inWindow.length < txs.length

  return {
    txs:          inWindow,
    creditsUsed:  txs.length,   // 1 crédit par tx fetché (conservateur)
    nextCursor:   hitTimeLimit ? null : txs[txs.length - 1].signature,
    hitTimeLimit,
  }
}

// ── Parser un swap Helius → SwapEvent ─────────────────────────────────────────

function parseSwapEvent(tx: HeliusTx): SwapEvent | null {
  if (!tx.events?.swap) return null
  const s = tx.events.swap

  const inputs  = s.tokenInputs  ?? []
  const outputs = s.tokenOutputs ?? []

  // Token "réel" = ni USDC ni WSOL
  const tokenIn   = inputs.find(t => t.mint !== USDC_MINT && t.mint !== WSOL_MINT)
  const tokenOut  = outputs.find(t => t.mint !== USDC_MINT && t.mint !== WSOL_MINT)
  const usdcIn    = inputs.find(t => t.mint === USDC_MINT)
  const usdcOut   = outputs.find(t => t.mint === USDC_MINT)
  const wsolIn    = inputs.find(t => t.mint === WSOL_MINT)
  const wsolOut   = outputs.find(t => t.mint === WSOL_MINT)

  // BUY : SOL/USDC → TOKEN
  if (tokenOut && !tokenIn) {
    const mint = tokenOut.mint

    if (usdcIn) {
      return {
        signature: tx.signature, timestamp: tx.timestamp, mint, side: 'BUY',
        solAmount: null, usdcAmount: usdcIn.tokenAmount / 1_000_000,
        tokenAmount: tokenOut.tokenAmount,
      }
    }

    // SOL natif ou WSOL
    const lamports = s.nativeInput?.amount
      ? Number(s.nativeInput.amount)
      : (wsolIn?.tokenAmount ?? 0)
    if (lamports > 0) {
      return {
        signature: tx.signature, timestamp: tx.timestamp, mint, side: 'BUY',
        solAmount: lamports / LAMPORTS_PER_SOL, usdcAmount: null,
        tokenAmount: tokenOut.tokenAmount,
      }
    }
  }

  // SELL : TOKEN → SOL/USDC
  if (tokenIn && !tokenOut) {
    const mint = tokenIn.mint

    if (usdcOut) {
      return {
        signature: tx.signature, timestamp: tx.timestamp, mint, side: 'SELL',
        solAmount: null, usdcAmount: usdcOut.tokenAmount / 1_000_000,
        tokenAmount: tokenIn.tokenAmount,
      }
    }

    const lamports = s.nativeOutput?.amount
      ? Number(s.nativeOutput.amount)
      : (wsolOut?.tokenAmount ?? 0)
    if (lamports > 0) {
      return {
        signature: tx.signature, timestamp: tx.timestamp, mint, side: 'SELL',
        solAmount: lamports / LAMPORTS_PER_SOL, usdcAmount: null,
        tokenAmount: tokenIn.tokenAmount,
      }
    }
  }

  return null   // swap multi-token ou pattern non reconnu → ignoré
}

// ── Calcul des métriques ──────────────────────────────────────────────────────

function computeMetrics(events: SwapEvent[], windowDays: number): WalletMetrics {
  // Groupe par mint
  const byMint = new Map<string, { buys: SwapEvent[]; sells: SwapEvent[] }>()
  let failedCount = 0

  for (const e of events) {
    if (!byMint.has(e.mint)) byMint.set(e.mint, { buys: [], sells: [] })
    byMint.get(e.mint)![e.side === 'BUY' ? 'buys' : 'sells'].push(e)
  }

  // Note: failed count computed upstream from tx.transactionError

  const holdSeconds: number[] = []
  let tradesClosed    = 0   // paires avec PnL mesurable uniquement
  let tradesMixedDenom = 0  // paires matchées mais devise incompatible
  let wins = 0
  let pnlSol  = 0
  let pnlUsdc = 0
  let hasSolPnl  = false
  let hasUsdcPnl = false

  for (const { buys, sells } of byMint.values()) {
    const sortedBuys  = [...buys].sort((a, b) => a.timestamp - b.timestamp)
    const sortedSells = [...sells].sort((a, b) => a.timestamp - b.timestamp)

    // Matching FIFO
    let bi = 0
    for (const sell of sortedSells) {
      if (bi >= sortedBuys.length) break
      const buy = sortedBuys[bi++]

      const holdSec = sell.timestamp - buy.timestamp
      if (holdSec >= 0) holdSeconds.push(holdSec)

      if (buy.solAmount !== null && sell.solAmount !== null) {
        const gain = sell.solAmount - buy.solAmount
        pnlSol += gain
        hasSolPnl = true
        if (gain > 0) wins++
        tradesClosed++
      } else if (buy.usdcAmount !== null && sell.usdcAmount !== null) {
        const gain = sell.usdcAmount - buy.usdcAmount
        pnlUsdc += gain
        hasUsdcPnl = true
        if (gain > 0) wins++
        tradesClosed++
      } else {
        // Devise incompatible (achat SOL / vente USDC ou inverse) — PnL non calculable,
        // jamais estimé (pas de prix midpoint). Comptabilisé séparément comme signal
        // de style de trading (agrégateur, arbitrage cross-devise).
        tradesMixedDenom++
      }
    }
  }

  const activeDays = Math.max(1, windowDays)
  const uniqueTokensPerDay = byMint.size / activeDays

  let medianHoldSeconds: number | null = null
  if (holdSeconds.length > 0) {
    const sorted = [...holdSeconds].sort((a, b) => a - b)
    const mid    = Math.floor(sorted.length / 2)
    medianHoldSeconds = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid]
  }

  const avgHoldHours = holdSeconds.length > 0
    ? holdSeconds.reduce((a, b) => a + b, 0) / holdSeconds.length / 3600
    : null

  const winRate = tradesClosed > 0 ? wins / tradesClosed : null

  return {
    swapCount:          events.length,
    failedSwapRatio:    0,   // rempli par l'appelant
    uniqueTokensPerDay: parseFloat(uniqueTokensPerDay.toFixed(2)),
    medianHoldSeconds:  medianHoldSeconds !== null ? Math.round(medianHoldSeconds) : null,
    avgHoldHours:       avgHoldHours !== null ? parseFloat(avgHoldHours.toFixed(2)) : null,
    winRate:            winRate !== null ? parseFloat(winRate.toFixed(4)) : null,
    tradesClosed,
    tradesMixedDenom,
    pnl90dSol:         hasSolPnl  ? parseFloat(pnlSol.toFixed(6))  : null,
    pnl90dUsdc:        hasUsdcPnl ? parseFloat(pnlUsdc.toFixed(4)) : null,
  }
}

// ── Filtres bot ───────────────────────────────────────────────────────────────

function applyBotFilters(
  swapCount:   number,
  m:           WalletMetrics,
): { verdict: 'VERIFIED' | 'REJECTED'; reason: string | null } {
  // VERIFIED = non-bot uniquement. Aucune exigence de PnL ou trades_closed.
  // La qualification viendra du taux de succès des signaux a posteriori.
  if (swapCount > BOT_SWAP_COUNT_MAX) {
    return { verdict: 'REJECTED', reason: `swap_count_90d=${swapCount} > ${BOT_SWAP_COUNT_MAX} (fréquence bot)` }
  }
  if (m.medianHoldSeconds !== null && m.medianHoldSeconds < BOT_MEDIAN_HOLD_MAX_S) {
    return { verdict: 'REJECTED', reason: `median_hold=${m.medianHoldSeconds}s < ${BOT_MEDIAN_HOLD_MAX_S}s (MEV/arb)` }
  }
  if (m.failedSwapRatio > BOT_FAILED_RATIO_MAX) {
    return { verdict: 'REJECTED', reason: `failed_swap_ratio=${(m.failedSwapRatio * 100).toFixed(0)}% > ${BOT_FAILED_RATIO_MAX * 100}% (bot compétitif)` }
  }
  if (m.uniqueTokensPerDay > BOT_TOKENS_PER_DAY_MAX) {
    return { verdict: 'REJECTED', reason: `unique_tokens_per_day=${m.uniqueTokensPerDay.toFixed(1)} > ${BOT_TOKENS_PER_DAY_MAX} (scatter bot)` }
  }
  return { verdict: 'VERIFIED', reason: null }
}

// ── Audit d'un seul wallet ────────────────────────────────────────────────────

async function auditWallet(
  supabase: SupabaseClient,
  address:  string,
): Promise<{ credits: number; status: string }> {
  const cutoffMs = Date.now() - NINETY_DAYS_MS

  // Marque AUDITING pour éviter un double-run concurrent
  await supabase.from('kymia_smart_wallets').update({
    status:     'AUDITING',
    updated_at: new Date().toISOString(),
  }).eq('address', address)

  let totalCredits = 0
  let cursor:       string | null = null
  const allSwaps:   SwapEvent[]   = []
  let totalFetched  = 0
  let failedSwaps   = 0
  let partial       = false

  // Pagination : jusqu'à 90j ou MAX_TXS_PER_WALLET
  while (totalFetched < MAX_TXS_PER_WALLET) {
    let page: PageResult
    try {
      page = await fetchSwapPage(address, cursor, cutoffMs)
    } catch (e: any) {
      console.error(`[smartmoney] ${address.slice(0, 8)}… page error: ${e.message}`)
      break
    }

    totalCredits += page.creditsUsed
    totalFetched += page.txs.length

    for (const tx of page.txs) {
      if (tx.transactionError !== null) failedSwaps++
      const ev = parseSwapEvent(tx)
      if (ev) allSwaps.push(ev)
    }

    if (page.hitTimeLimit || !page.nextCursor) break
    cursor = page.nextCursor

    if (totalFetched >= MAX_TXS_PER_WALLET) {
      partial = true
      break
    }

    // Throttle : ~8 req/s pour rester sous la limite Helius free
    await new Promise(r => setTimeout(r, 125))
  }

  console.log(
    `[smartmoney] ${address.slice(0, 8)}…` +
    ` swaps=${allSwaps.length} fetched=${totalFetched}` +
    ` credits=${totalCredits}${partial ? ' (partial)' : ''}`
  )

  // ── Diagnostic : 0 swap détecté malgré type=SWAP → inspecte les types bruts
  if (totalFetched === 0) {
    try {
      const diagUrl = new URL(`${HELIUS_BASE}/addresses/${address}/transactions`)
      diagUrl.searchParams.set('api-key', HELIUS_API_KEY)
      diagUrl.searchParams.set('limit',   '5')   // sans filtre type=SWAP
      const diagRes = await fetch(diagUrl.toString(), {
        headers: { 'User-Agent': 'KYMIA/1.0' },
        signal:  AbortSignal.timeout(8_000),
      })
      if (diagRes.ok) {
        const diagTxs: HeliusTx[] = await diagRes.json()
        const types = diagTxs.length > 0
          ? diagTxs.map(t => t.type).join(', ')
          : 'aucune tx trouvée'
        console.warn(`[smartmoney] ${address.slice(0, 8)}… DIAG 0-swap — types des 5 dernières tx brutes: [${types}]`)
      }
    } catch { /* diagnostic only — non bloquant */ }
  }

  const metrics = computeMetrics(allSwaps, 90)
  metrics.failedSwapRatio = totalFetched > 0
    ? parseFloat((failedSwaps / totalFetched).toFixed(4))
    : 0

  const { verdict, reason } = applyBotFilters(totalFetched, metrics)

  if (verdict === 'REJECTED') {
    console.log(`[smartmoney] ${address.slice(0, 8)}… REJECTED — ${reason}`)
  } else {
    console.log(
      `[smartmoney] ${address.slice(0, 8)}… VERIFIED` +
      ` | win=${metrics.winRate !== null ? (metrics.winRate * 100).toFixed(0) + '%' : 'n/a'}` +
      ` | trades=${metrics.tradesClosed}` +
      ` | mixed=${metrics.tradesMixedDenom}` +
      ` | medHold=${metrics.medianHoldSeconds !== null ? (metrics.medianHoldSeconds / 3600).toFixed(1) + 'h' : 'n/a'}` +
      ` | pnl_sol=${metrics.pnl90dSol !== null ? metrics.pnl90dSol.toFixed(3) + ' SOL' : 'n/a'}` +
      ` | pnl_usdc=${metrics.pnl90dUsdc !== null ? '$' + metrics.pnl90dUsdc.toFixed(2) : 'n/a'}`
    )
  }

  await supabase.from('kymia_smart_wallets').update({
    last_audited:            new Date().toISOString(),
    audit_cursor:            null,
    audit_partial:           partial,
    status:                  verdict,
    reject_reason:           reason,
    tx_count_90d:            totalFetched,
    swap_count_90d:          allSwaps.length,
    failed_tx_ratio:         metrics.failedSwapRatio,
    unique_tokens_per_day:   metrics.uniqueTokensPerDay,
    median_hold_seconds:     metrics.medianHoldSeconds,
    avg_hold_hours:          metrics.avgHoldHours,
    win_rate:                metrics.winRate,
    trades_closed:           metrics.tradesClosed,
    trades_mixed_denom:      metrics.tradesMixedDenom,
    pnl_90d_sol:             metrics.pnl90dSol,
    pnl_90d_usdc:            metrics.pnl90dUsdc,
    credits_used_last_audit: totalCredits,
    updated_at:              new Date().toISOString(),
  }).eq('address', address)

  return { credits: totalCredits, status: verdict }
}

// ── Point d'entrée public — appelé par le cron ────────────────────────────────

export interface AuditRunResult {
  wallets_processed: number
  wallets_skipped:   string | null
  credits_this_run:  number
  credits_month:     number
  guard_pct:         number
}

export async function runSmartMoneyAudit(
  supabase: SupabaseClient,
): Promise<AuditRunResult> {
  if (!HELIUS_API_KEY) {
    console.error('[smartmoney] HELIUS_API_KEY manquant — audit impossible')
    return { wallets_processed: 0, wallets_skipped: 'HELIUS_API_KEY missing', credits_this_run: 0, credits_month: 0, guard_pct: 0 }
  }

  // ── Vérification quota ─────────────────────────────────────────────────────
  const quota = await checkAndResetQuota(supabase)
  const usedPct = (quota.creditsUsed / quota.creditsLimit * 100).toFixed(1)
  console.log(`[smartmoney] quota: ${quota.creditsUsed}/${quota.creditsLimit} (${usedPct}%) ${quota.blocked ? '⛔ GUARD' : '✓'}`)

  if (quota.blocked) {
    console.warn(`[smartmoney] QUOTA GUARD actif (${usedPct}% >= ${quota.guardPct}%) — run annulé`)
    return {
      wallets_processed: 0,
      wallets_skipped:   `quota guard: ${usedPct}% >= ${quota.guardPct}%`,
      credits_this_run:  0,
      credits_month:     quota.creditsUsed,
      guard_pct:         quota.guardPct,
    }
  }

  // ── Sélection wallets (CANDIDATE, VERIFIED, INSUFFICIENT_DATA, plus ancien en premier) ──
  const { data: wallets, error } = await supabase
    .from('kymia_smart_wallets')
    .select('address')
    .in('status', ['CANDIDATE', 'VERIFIED'])
    .order('last_audited', { ascending: true, nullsFirst: true })
    .limit(WALLETS_PER_RUN)

  if (error) {
    console.error('[smartmoney] wallet select error:', error.message)
    return { wallets_processed: 0, wallets_skipped: `db error: ${error.message}`, credits_this_run: 0, credits_month: quota.creditsUsed, guard_pct: quota.guardPct }
  }

  if (!wallets?.length) {
    console.log('[smartmoney] aucun wallet à auditer (table vide ou tous en statut REJECTED/AUDITING)')
    return { wallets_processed: 0, wallets_skipped: 'no wallets to audit', credits_this_run: 0, credits_month: quota.creditsUsed, guard_pct: quota.guardPct }
  }

  let cycleCredits = 0

  for (const { address } of wallets) {
    // Re-vérifie le quota avant chaque wallet (peut être atteint en cours de run)
    const mid = await checkAndResetQuota(supabase)
    if (mid.blocked) {
      console.warn(`[smartmoney] quota guard mid-run — arrêt après ${cycleCredits} crédits`)
      break
    }

    try {
      const { credits } = await auditWallet(supabase, address)
      cycleCredits += credits
      await incrementQuota(supabase, credits)
    } catch (e: any) {
      console.error(`[smartmoney] ${address.slice(0, 8)}… audit failed: ${e.message}`)
      // Remet en CANDIDATE pour retry au prochain cycle
      await supabase.from('kymia_smart_wallets').update({
        status:     'CANDIDATE',
        updated_at: new Date().toISOString(),
      }).eq('address', address).eq('status', 'AUDITING')
    }
  }

  const finalQuota = await checkAndResetQuota(supabase)
  console.log(`[smartmoney] run terminé — ${cycleCredits} crédits ce run, ${finalQuota.creditsUsed} ce mois`)

  return {
    wallets_processed: wallets.length,
    wallets_skipped:   null,
    credits_this_run:  cycleCredits,
    credits_month:     finalQuota.creditsUsed,
    guard_pct:         finalQuota.guardPct,
  }
}
