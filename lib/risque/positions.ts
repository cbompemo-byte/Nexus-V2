// lib/risque/positions.ts
// Logique d'entrée et de sortie des positions du module Risque.
//
// ╔══════════════════════════════════════════════════════════════════════╗
// ║  SAFETY BELT — CEINTURE DE SÉCURITÉ                                ║
// ║                                                                      ║
// ║  is_paper est TOUJOURS dérivé de live_mode lu en base à chaque      ║
// ║  appel. Il n'est JAMAIS passé comme paramètre par l'appelant.        ║
// ║  Tant que live_mode=false en base, is_paper=true est impossible      ║
// ║  à court-circuiter depuis le code.                                  ║
// ║                                                                      ║
// ║  Pour passer en live : UPDATE kymia_risque_settings                 ║
// ║    SET value='true', updated_at=now() WHERE key='live_mode';        ║
// ╚══════════════════════════════════════════════════════════════════════╝

import { SupabaseClient } from '@supabase/supabase-js'

// ── Settings ──────────────────────────────────────────────────────────────────

export interface RisqueSettings {
  liveMode:               boolean
  positionSizeUsd:        number
  capitalUsd:             number
  minBuyersForEntry:      number
  minSolPerBuyer:         number
  stopLossPct:            number
  trailingActivationPct:  number
  maxConcurrentPositions: number
  maxMcUsd:               number
}

export async function loadSettings(supabase: SupabaseClient): Promise<RisqueSettings> {
  const { data, error } = await supabase
    .from('kymia_risque_settings')
    .select('key, value')

  if (error) throw new Error(`settings load: ${error.message}`)

  const map = new Map<string, unknown>(
    (data ?? []).map(r => [r.key as string, r.value])
  )

  const num = (key: string, fallback: number) => {
    const v = map.get(key)
    return v !== undefined ? Number(v) : fallback
  }

  return {
    // SAFETY BELT : live_mode doit être le boolean JSON `true`, pas la string "true"
    liveMode:               map.get('live_mode') === true,
    positionSizeUsd:        num('position_size_usd',        100),
    capitalUsd:             num('capital_usd',              500),
    minBuyersForEntry:      num('min_buyers_for_entry',     2),
    minSolPerBuyer:         num('min_sol_per_buyer',        0.1),
    stopLossPct:            num('stop_loss_pct',            35),
    trailingActivationPct:  num('trailing_activation_pct',  30),
    maxConcurrentPositions: num('max_concurrent_positions', 3),
    maxMcUsd:               num('max_mc_usd',               50_000),
  }
}

// ── Trailing stop price ───────────────────────────────────────────────────────
// Distance s'élargit avec le profit pour capturer les gros mouvements.
//   < +100% : -20% du high
//   +100% à +300% : -30% du high
//   > +300% : -40% du high

export function trailingStopPrice(high: number, entryPrice: number): number {
  const profitPct = (high - entryPrice) / entryPrice * 100
  const distance  = profitPct < 100 ? 0.20
    : profitPct < 300 ? 0.30
    : 0.40
  return high * (1 - distance)
}

// ── checkEntry ────────────────────────────────────────────────────────────────
// Appelée après chaque buy webhook. Ouvre une position si les 7 conditions
// cumulatives sont remplies.

export type EntryResult =
  | { entered: true;  positionId: string; reason: string }
  | { entered: false; reason: string }

export async function checkEntry(
  supabase:     SupabaseClient,
  mint:         string,
  currentPrice: number,
  marketCapUsd: number | null,
): Promise<EntryResult> {
  // ── SAFETY BELT : dériver is_paper depuis la base, jamais depuis l'appelant ──
  const settings = await loadSettings(supabase)
  const isPaper  = !settings.liveMode   // false uniquement si live_mode=true en base

  // ── Condition 3 : market cap ≤ seuil ────────────────────────────────────────
  if (marketCapUsd !== null && marketCapUsd > settings.maxMcUsd) {
    return { entered: false, reason: `mcap $${marketCapUsd.toFixed(0)} > $${settings.maxMcUsd}` }
  }

  // ── Condition 5 : pas de position ouverte sur ce mint ────────────────────────
  const { data: openPos } = await supabase
    .from('kymia_risque_positions')
    .select('id')
    .eq('token_mint', mint)
    .eq('status', 'OPEN')
    .limit(1)
    .maybeSingle()

  if (openPos) return { entered: false, reason: 'position déjà ouverte sur ce mint' }

  // ── Condition 7 : pas de ré-entrée (token déjà clôturé) ──────────────────────
  const { data: closedPos } = await supabase
    .from('kymia_risque_positions')
    .select('id')
    .eq('token_mint', mint)
    .neq('status', 'OPEN')
    .limit(1)
    .maybeSingle()

  if (closedPos) return { entered: false, reason: 'token déjà tradé — pas de ré-entrée' }

  // ── Condition 6 : positions ouvertes < max ───────────────────────────────────
  const { count: openCount } = await supabase
    .from('kymia_risque_positions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'OPEN')

  if ((openCount ?? 0) >= settings.maxConcurrentPositions) {
    return {
      entered: false,
      reason:  `${openCount}/${settings.maxConcurrentPositions} positions max atteintes`,
    }
  }

  // ── Conditions 1 & 2 : wallets distincts avec SOL ≥ min dans fenêtre 6h ─────
  const windowStart = new Date(Date.now() - 6 * 3600_000).toISOString()
  const { data: recentBuys } = await supabase
    .from('kymia_risque_buys')
    .select('wallet_address, wallet_label, sol_amount')
    .eq('token_mint', mint)
    .gte('bought_at', windowStart)
    .gte('sol_amount', settings.minSolPerBuyer)

  // Agréger par wallet (plusieurs achats possibles depuis le même wallet)
  const buyerMap = new Map<string, { label: string; totalSol: number }>()
  for (const b of recentBuys ?? []) {
    const key  = b.wallet_address as string
    const prev = buyerMap.get(key) ?? {
      label:    (b.wallet_label ?? (key as string).slice(0, 8)) as string,
      totalSol: 0,
    }
    buyerMap.set(key, { label: prev.label, totalSol: prev.totalSol + (b.sol_amount ?? 0) })
  }

  if (buyerMap.size < settings.minBuyersForEntry) {
    return {
      entered: false,
      reason:  `${buyerMap.size}/${settings.minBuyersForEntry} wallets qualifiés (min ${settings.minSolPerBuyer} SOL)`,
    }
  }

  // ── Condition 4 : score ≠ DANGER ─────────────────────────────────────────────
  // CAUTION et DATA_UNAVAILABLE sont acceptés (tokens de 3 min = données limitées)
  const { data: token } = await supabase
    .from('kymia_risque_tokens')
    .select('risque_score, symbol')
    .eq('mint', mint)
    .maybeSingle()

  if (token?.risque_score === 'DANGER') {
    return { entered: false, reason: `score DANGER — entrée refusée` }
  }

  // ── Toutes conditions remplies → ouvrir la position ──────────────────────────
  const buyers        = [...buyerMap.values()]
  const totalSol      = buyers.reduce((s, b) => s + b.totalSol, 0)
  const triggerLabels = buyers.map(b => b.label)
  const triggerReason = `${buyerMap.size} wallets, ${totalSol.toFixed(2)} SOL total`
  const stopPriceUsd  = currentPrice * (1 - settings.stopLossPct / 100)

  if (!isPaper) {
    // ── LIVE BUY — stub non implémenté ──────────────────────────────────────
    // Atteint uniquement si live_mode=true en base (changement manuel délibéré).
    // TODO: executer un swap achat via Jupiter ou pump.fun SDK
    // const txSig = await executeBuySwap(mint, settings.positionSizeUsd)
    console.warn(
      `[positions] LIVE BUY non implémenté — position ouverte en paper` +
      ` (live_mode=true mais tx non exécutée)`
    )
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('kymia_risque_positions')
    .insert({
      token_mint:         mint,
      token_symbol:       token?.symbol ?? null,
      entry_price_usd:    currentPrice,
      entry_market_cap:   marketCapUsd,
      size_usd:           settings.positionSizeUsd,
      trigger_reason:     triggerReason,
      trigger_wallets:    triggerLabels,
      security_score:     token?.risque_score ?? null,
      stop_price_usd:     stopPriceUsd,
      high_since_entry:   currentPrice,
      trailing_active:    false,
      status:             'OPEN',
      is_paper:           isPaper,          // ← SAFETY BELT : toujours dérivé de live_mode
      tx_signature_entry: null,             // null en paper, tx hash en live
    })
    .select('id')
    .single()

  if (insertErr) throw new Error(`position insert: ${insertErr.message}`)

  console.log(
    `[positions] ${isPaper ? 'PAPER' : 'LIVE'} ENTRY ${mint.slice(0, 8)}…` +
    ` price=$${currentPrice}` +
    ` mcap=${marketCapUsd ? '$' + marketCapUsd.toFixed(0) : 'n/a'}` +
    ` stop=$${stopPriceUsd.toFixed(8)}` +
    ` trigger="${triggerReason}"` +
    ` score=${token?.risque_score ?? 'n/a'}`
  )

  return { entered: true, positionId: (inserted as any).id, reason: triggerReason }
}

// ── closePosition ─────────────────────────────────────────────────────────────
// Mise à jour atomique avec guard status='OPEN' — idempotent en cas de double appel.

export type ClosedStatus =
  | 'CLOSED_STOP'
  | 'CLOSED_TRAILING'
  | 'CLOSED_SIGNAL_REVERSE'
  | 'CLOSED_TIME'
  | 'CLOSED_MANUAL'

export interface PositionRow {
  id:               string
  token_mint:       string
  token_symbol:     string | null
  entry_at:         string
  entry_price_usd:  number
  size_usd:         number
  stop_price_usd:   number
  high_since_entry: number | null
  trailing_active:  boolean
  trigger_wallets:  string[]
  is_paper:         boolean
}

export async function closePosition(
  supabase:   SupabaseClient,
  position:   PositionRow,
  exitPrice:  number,
  status:     ClosedStatus,
  exitReason: string,
): Promise<boolean> {
  const pnlUsd = (exitPrice - position.entry_price_usd) / position.entry_price_usd * position.size_usd
  const pnlPct = (exitPrice - position.entry_price_usd) / position.entry_price_usd * 100
  const now    = new Date().toISOString()

  let txSignatureExit: string | null = null

  if (!position.is_paper) {
    // ── LIVE SELL — stub non implémenté ─────────────────────────────────────
    // Atteint uniquement si is_paper=false (= live_mode était true à l'entrée).
    // TODO: executer un swap vente via Jupiter ou pump.fun SDK
    // const txSig = await executeSellSwap(position.token_mint, position.size_usd)
    // txSignatureExit = txSig
    console.warn(`[positions] LIVE SELL non implémenté — clôture sans tx on-chain (id=${position.id})`)
  }

  // Guard .eq('status', 'OPEN') : ne met à jour que si encore ouverte.
  // Protection contre les doubles appels (concurrent monitor runs).
  const { data: updated } = await supabase
    .from('kymia_risque_positions')
    .update({
      status:            status,
      exit_at:           now,
      exit_price_usd:    exitPrice,
      exit_reason:       exitReason,
      pnl_usd:           parseFloat(pnlUsd.toFixed(4)),
      pnl_pct:           parseFloat(pnlPct.toFixed(2)),
      tx_signature_exit: txSignatureExit,
      updated_at:        now,
    })
    .eq('id', position.id)
    .eq('status', 'OPEN')
    .select('id')
    .maybeSingle()

  if (!updated) {
    console.log(`[positions] ${position.id} déjà clôturée — skip (concurrent run ?)`)
    return false
  }

  const sign = pnlUsd >= 0 ? '+' : ''
  console.log(
    `[positions] ${position.is_paper ? 'PAPER' : 'LIVE'} EXIT` +
    ` ${position.token_mint.slice(0, 8)}…` +
    ` ${status}` +
    ` entry=$${position.entry_price_usd} exit=$${exitPrice}` +
    ` pnl=${pnlPct.toFixed(1)}% (${sign}$${pnlUsd.toFixed(2)})` +
    ` reason="${exitReason}"`
  )

  return true
}
