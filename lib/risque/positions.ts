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

import { SupabaseClient }    from '@supabase/supabase-js'
import { fetchSolPriceUsd } from '@/lib/risque/pumpfun'

// ── Settings ──────────────────────────────────────────────────────────────────

export interface RisqueSettings {
  liveMode:                 boolean
  positionSizeUsd:          number
  capitalUsd:               number
  minBuyersForEntry:        number
  minSolPerBuyer:           number
  stopLossPct:              number
  trailingActivationPct:    number
  maxConcurrentPositions:   number
  maxMcUsd:                 number
  maxBuysPerWallet:         number   // >N achats qualifiés dans la fenêtre 6h = market maker → exclu
  minUsdPerBuyer:           number   // seuil USD : sol_amount×prix OU usdc_amount doit dépasser ce seuil
  maxPositionsPerDay:       number   // plafond journalier (UTC) — évite les jours d'activité intense
  convergenceWindowMinutes: number   // fenêtre max entre 1er et Nème acheteur qualifié (minutes)
  maxPriceRunPct:           number   // skip si prix a monté de plus de X% depuis 1er acheteur
  dexConfirmEnabled:        boolean  // si true, buy/sell ratio DexScreener 1h ≤ 50% bloque l'entrée
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
    maxBuysPerWallet:         num('max_buys_per_wallet',          5),
    minUsdPerBuyer:           num('min_usd_per_buyer',            10),
    maxPositionsPerDay:       num('max_positions_per_day',        10),
    convergenceWindowMinutes: num('convergence_window_minutes',   60),
    maxPriceRunPct:           num('max_price_run_pct',            50),
    dexConfirmEnabled:        map.get('dex_confirm_enabled') === true,
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
  const tag      = `[checkEntry] ${mint.slice(0, 8)}…`

  // ── Condition 3 : market cap ≤ seuil ────────────────────────────────────────
  if (marketCapUsd !== null && marketCapUsd > settings.maxMcUsd) {
    const reason = `mcap $${marketCapUsd.toFixed(0)} > seuil $${settings.maxMcUsd}`
    console.log(`${tag} SKIP: ${reason}`)
    return { entered: false, reason }
  }

  // ── Condition 5 : pas de position ouverte sur ce mint ────────────────────────
  const { data: openPos } = await supabase
    .from('kymia_risque_positions')
    .select('id')
    .eq('token_mint', mint)
    .eq('status', 'OPEN')
    .limit(1)
    .maybeSingle()

  if (openPos) {
    const reason = 'position déjà ouverte sur ce mint'
    console.log(`${tag} SKIP: ${reason}`)
    return { entered: false, reason }
  }

  // ── Condition 7 : pas de ré-entrée (token déjà clôturé) ──────────────────────
  const { data: closedPos } = await supabase
    .from('kymia_risque_positions')
    .select('id')
    .eq('token_mint', mint)
    .neq('status', 'OPEN')
    .limit(1)
    .maybeSingle()

  if (closedPos) {
    const reason = 'token déjà tradé — pas de ré-entrée'
    console.log(`${tag} SKIP: ${reason}`)
    return { entered: false, reason }
  }

  // ── Condition 6 : positions ouvertes < max concurrent ───────────────────────
  // GARDE-FOU LIVE : si live_mode=true, plafonner à floor(capital/size) pour
  // éviter qu'un max_concurrent_positions élevé (paper) ruine le capital réel.
  const safeConcurrentMax = settings.liveMode
    ? Math.min(
        settings.maxConcurrentPositions,
        Math.floor(settings.capitalUsd / Math.max(settings.positionSizeUsd, 1)),
      )
    : settings.maxConcurrentPositions

  if (settings.liveMode && safeConcurrentMax < settings.maxConcurrentPositions) {
    console.log(
      `${tag} [live] concurrent plafonné à ${safeConcurrentMax}` +
      ` (capital $${settings.capitalUsd} / size $${settings.positionSizeUsd})` +
      ` < setting ${settings.maxConcurrentPositions}`
    )
  }

  const { count: openCount } = await supabase
    .from('kymia_risque_positions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'OPEN')

  if ((openCount ?? 0) >= safeConcurrentMax) {
    const reason = `${openCount}/${safeConcurrentMax} positions concurrent max atteintes`
    console.log(`${tag} SKIP: ${reason}`)
    return { entered: false, reason }
  }

  // ── Condition 6b : plafond journalier (UTC) ───────────────────────────────
  const todayUtc = new Date()
  todayUtc.setUTCHours(0, 0, 0, 0)
  const { count: todayCount } = await supabase
    .from('kymia_risque_positions')
    .select('*', { count: 'exact', head: true })
    .gte('entry_at', todayUtc.toISOString())
    .eq('is_backfilled', false)   // ne pas compter les positions rétroactives

  if ((todayCount ?? 0) >= settings.maxPositionsPerDay) {
    const reason = `${todayCount}/${settings.maxPositionsPerDay} positions ouvertes aujourd'hui (UTC)`
    console.log(`${tag} SKIP: ${reason}`)
    return { entered: false, reason }
  }

  // ── Conditions 1 & 2 : wallets distincts avec montant USD ≥ min dans fenêtre 6h ──
  // Seuil en dollars (sol_amount × prix_sol OU usdc_amount) pour accepter les
  // acheteurs USDC et rester robuste aux variations du prix SOL.
  const windowStart = new Date(Date.now() - 6 * 3600_000).toISOString()
  const { data: recentBuys } = await supabase
    .from('kymia_risque_buys')
    .select('wallet_address, wallet_label, sol_amount, usdc_amount, bought_at, market_cap_at_buy')
    .eq('token_mint', mint)
    .gte('bought_at', windowStart)
  // Pas de filtre sur montant côté DB — filtre USD en mémoire ci-dessous.
  // La fenêtre 6h × token_mint garde le jeu petit (< quelques dizaines de lignes).

  // Prix SOL pour convertir sol_amount → USD. Fallback 100 si indisponible.
  let solPriceUsd = 100
  try { solPriceUsd = await fetchSolPriceUsd() } catch { /* fallback conservateur */ }

  // Valeur USD d'un achat (SOL converti + USDC, on prend le max pour éviter le double-compte)
  const buyUsd = (b: { sol_amount: number | null; usdc_amount: number | null }): number =>
    Math.max((b.sol_amount ?? 0) * solPriceUsd, b.usdc_amount ?? 0)

  // ── Détection market maker : wallet avec >maxBuysPerWallet achats qualifiés = MM ──
  const walletBuyCount = new Map<string, number>()
  for (const b of recentBuys ?? []) {
    if (buyUsd(b) < settings.minUsdPerBuyer) continue
    const key = b.wallet_address as string
    walletBuyCount.set(key, (walletBuyCount.get(key) ?? 0) + 1)
  }

  const mmWallets = new Set(
    [...walletBuyCount.entries()]
      .filter(([, n]) => n > settings.maxBuysPerWallet)
      .map(([wallet]) => wallet)
  )

  if (mmWallets.size > 0) {
    console.log(
      `${tag} MM exclus (>${settings.maxBuysPerWallet} achats ≥$${settings.minUsdPerBuyer}/6h):` +
      ` ${mmWallets.size} wallet(s) — ${[...mmWallets].join(', ')}`
    )
  }

  // Agréger par wallet : achats qualifiés (USD ≥ seuil) et non-MM
  // On track firstBoughtAt + firstMcap pour les checks temporels + price-run
  const buyerMap = new Map<string, { label: string; totalUsd: number; firstBoughtAt: string; firstMcap: number | null }>()
  for (const b of recentBuys ?? []) {
    const key = b.wallet_address as string
    if (mmWallets.has(key)) continue
    const usd = buyUsd(b)
    if (usd < settings.minUsdPerBuyer) continue
    if (!buyerMap.has(key)) {
      buyerMap.set(key, {
        label:        (b.wallet_label ?? key.slice(0, 8)) as string,
        totalUsd:     0,
        firstBoughtAt: b.bought_at as string,
        firstMcap:    b.market_cap_at_buy as number | null,
      })
    }
    const prev = buyerMap.get(key)!
    buyerMap.set(key, { ...prev, totalUsd: prev.totalUsd + usd })
  }

  if (buyerMap.size < settings.minBuyersForEntry) {
    const mmNote = mmWallets.size > 0 ? ` (${mmWallets.size} MM exclus)` : ''
    const reason = `${buyerMap.size}/${settings.minBuyersForEntry} wallets qualifiés dans fenêtre 6h (min $${settings.minUsdPerBuyer})${mmNote}`
    console.log(`${tag} SKIP: ${reason}`)
    return { entered: false, reason }
  }

  // Trier par ordre d'apparition (1er achat chronologique)
  const sortedBuyers = [...buyerMap.entries()]
    .sort((a, b) => a[1].firstBoughtAt.localeCompare(b[1].firstBoughtAt))

  // ── Condition convergence_window_minutes : fenêtre entre 1er et Nème acheteur ──
  const nthBuyerEntry = sortedBuyers[settings.minBuyersForEntry - 1]
  const firstBuyerEntry = sortedBuyers[0]
  const convergenceSpanMin =
    (new Date(nthBuyerEntry[1].firstBoughtAt).getTime() -
     new Date(firstBuyerEntry[1].firstBoughtAt).getTime()) / 60_000

  if (convergenceSpanMin > settings.convergenceWindowMinutes) {
    const reason = `convergence trop lente — ${convergenceSpanMin.toFixed(0)}min entre 1er et ${settings.minBuyersForEntry}e acheteur (max ${settings.convergenceWindowMinutes}min)`
    console.log(`${tag} SKIP: ${reason}`)
    return { entered: false, reason }
  }

  // ── Condition max_price_run_pct : skip si déjà trop monté ────────────────────
  // Compare le prix courant au prix d'entrée du 1er acheteur déclencheur.
  // Évite d'acheter sur une bougie déjà consommée.
  const firstMcap = firstBuyerEntry[1].firstMcap
  if (firstMcap && firstMcap > 0) {
    const firstBuyerPrice = firstMcap / 1e9
    const runPct = (currentPrice - firstBuyerPrice) / firstBuyerPrice * 100
    if (runPct > settings.maxPriceRunPct) {
      const reason = `prix a monté de +${runPct.toFixed(0)}% depuis le 1er acheteur (max +${settings.maxPriceRunPct}%)`
      console.log(`${tag} SKIP: ${reason}`)
      return { entered: false, reason }
    }
    console.log(`${tag} price run: +${runPct.toFixed(0)}% depuis 1er acheteur (seuil ${settings.maxPriceRunPct}%) — OK`)
  }

  // ── DexScreener buy/sell ratio 1h — stocké, bloquant si dex_confirm_enabled ───
  // Appel léger (DexScreener, 0 crédit Helius). Non bloquant par défaut.
  // Stocké dans kymia_risque_tokens.dex_buy_ratio_1h pour calibrage.
  try {
    const dexRes = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(4_000) }
    )
    if (dexRes.ok) {
      const dexData = await dexRes.json()
      const pairs = (dexData.pairs ?? []) as Array<{
        txns?: { h1?: { buys: number; sells: number } }
        liquidity?: { usd: number }
      }>
      const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
      if (best?.txns?.h1) {
        const { buys, sells } = best.txns.h1
        const total = buys + sells
        const buyRatio = total > 0 ? buys / total : null
        if (buyRatio !== null) {
          await supabase
            .from('kymia_risque_tokens')
            .update({ dex_buy_ratio_1h: buyRatio, updated_at: new Date().toISOString() })
            .eq('mint', mint)
          const ratioStr = `${(buyRatio * 100).toFixed(0)}% (${buys}B/${sells}S)`
          if (settings.dexConfirmEnabled && buyRatio <= 0.5) {
            const reason = `DexScreener 1h buy ratio ${ratioStr} ≤ 50% — signal faible`
            console.log(`${tag} SKIP: ${reason}`)
            return { entered: false, reason }
          }
          console.log(`${tag} DexScreener ratio 1h: ${ratioStr}${settings.dexConfirmEnabled ? '' : ' — non bloquant'}`)
        }
      }
    }
  } catch (e: any) {
    console.warn(`${tag} DexScreener ratio fetch: ${e.message}`)
  }

  // ── Condition 4 : score ≠ DANGER ─────────────────────────────────────────────
  // CAUTION et DATA_UNAVAILABLE sont acceptés (tokens de 3 min = données limitées)
  const { data: token } = await supabase
    .from('kymia_risque_tokens')
    .select('risque_score, symbol')
    .eq('mint', mint)
    .maybeSingle()

  if (token?.risque_score === 'DANGER') {
    const reason = 'score DANGER — entrée refusée'
    console.log(`${tag} SKIP: ${reason}`)
    return { entered: false, reason }
  }

  // ── Toutes conditions remplies → ouvrir la position ──────────────────────────
  const totalUsd      = sortedBuyers.reduce((s, [, v]) => s + v.totalUsd, 0)
  const triggerLabels = sortedBuyers.map(([, v]) => v.label)
  const triggerReason = `${buyerMap.size} wallets, $${totalUsd.toFixed(0)} total`
  const stopPriceUsd  = currentPrice * (1 - settings.stopLossPct / 100)

  console.log(
    `${tag} OPEN: ${buyerMap.size} buyers ($${totalUsd.toFixed(0)} total), mcap ${marketCapUsd ? '$' + marketCapUsd.toFixed(0) : 'n/a'},` +
    ` score ${token?.risque_score ?? 'n/a'}, price=$${currentPrice}, stop=$${stopPriceUsd.toFixed(8)}`
  )

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
