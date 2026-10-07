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
  convergenceStrongBuyers:          number   // nb de wallets forts requis pour le fast-path (0 = désactivé)
  strongPathWindowMinutes:          number   // fenêtre max entre 1er et dernier strong buyer (minutes, 0 = désactivé)
  minAvgUsdPerBuy:                  number   // USD moyen / achat qualifié sur le token dans la fenêtre (0 = désactivé)
  blockIfSoldWithinMinutes:         number   // skip si un wallet suivi a vendu ce token dans les N dernières minutes (0 = désactivé)
  minPriceVsFirstTriggerPct:        number   // skip si prix courant < X% du mcap du 1er déclencheur — couteau qui tombe (0 = désactivé)
  maxDrawdownFromPeakPct:           number   // skip si mcap courant a baissé de plus de X% depuis le pic dans la fenêtre (0 = désactivé)
  takeProfitPct:                    number   // clôture dès que le prix atteint entry × (1 + pct/100) ; 0 = désactivé
  takeProfitSellPct:                number   // % de la position vendu au TP ; 100 = fermeture totale (défaut 50)
  scoutSizeUsd:                     number   // taille position éclaireur en $ (défaut 25)
  scoutMaxMcapUsd:                  number   // mcap max pour déclencher un éclaireur (défaut 300K$)
  scoutMinUsd:                      number   // achat min $ d'un wallet tier A pour qualifier (défaut 1000$)
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
    convergenceStrongBuyers:  num('convergence_strong_buyers',   3),
    strongPathWindowMinutes:  num('strong_path_window_minutes', 360),
    minAvgUsdPerBuy:          num('min_avg_usd_per_buy',        500),
    blockIfSoldWithinMinutes:         num('block_if_sold_within_minutes',           30),
    minPriceVsFirstTriggerPct:        num('min_price_vs_first_trigger_pct',         70),
    maxDrawdownFromPeakPct:           num('max_drawdown_from_peak_pct',             20),
    takeProfitPct:                    num('take_profit_pct',                         15),
    takeProfitSellPct:                num('take_profit_sell_pct',                    50),
    scoutSizeUsd:                     num('scout_size_usd',                          25),
    scoutMaxMcapUsd:                  num('scout_max_mcap_usd',                 300_000),
    scoutMinUsd:                      num('scout_min_usd',                        1_000),
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

// ── logSkippedConvergence ─────────────────────────────────────────────────────
// Insère une ligne dans kymia_risque_skipped quand une convergence RÉELLE
// (≥ 2 wallets qualifiés) est bloquée par un filtre.
// Non bloquant : toute erreur est swallowée pour ne jamais perturber checkEntry.

async function logSkippedConvergence(
  supabase:     SupabaseClient,
  mint:         string,
  skipReason:   string,
  buyerCount:   number,
  currentPrice: number,
  marketCapUsd: number | null,
): Promise<void> {
  if (buyerCount < 2) return
  try {
    await supabase.from('kymia_risque_skipped').insert({
      token_mint:    mint,
      skip_reason:   skipReason,
      buyer_count:   buyerCount,
      price_at_skip: currentPrice,
      mcap_at_skip:  marketCapUsd,
      skipped_at:    new Date().toISOString(),
    })
  } catch (e: any) {
    console.warn(`[positions] logSkip ${mint.slice(0, 8)}… ${skipReason}: ${e.message}`)
  }
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
    .select('id, strategy_tag, size_usd, entry_price_usd, partial_tp_taken')
    .eq('token_mint', mint)
    .eq('status', 'OPEN')
    .limit(1)
    .maybeSingle()

  type OpenPosRow = {
    id:               string
    strategy_tag:     string | null
    size_usd:         number
    entry_price_usd:  number
    partial_tp_taken: boolean
  }
  const openPosRow = openPos as OpenPosRow | null

  // Bloquer si : position non-SCOUT ouverte, OU SCOUT avec partial TP déjà pris
  // (phase trailing seule — on ne remet pas de capital dessus).
  if (openPosRow && (openPosRow.strategy_tag !== 'SCOUT' || openPosRow.partial_tp_taken)) {
    const reason = 'position déjà ouverte sur ce mint'
    console.log(`${tag} SKIP: ${reason}`)
    return { entered: false, reason }
  }
  // openPosRow?.strategy_tag === 'SCOUT' && !openPosRow.partial_tp_taken
  // → laisser passer tous les filtres, puis compléter en SCOUT+CONV si tout passe.

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

  // ── min_avg_usd_per_buy : filtre commun aux deux chemins ─────────────────────
  // total_usd / nb_achats_qualifiés sur ce token dans la fenêtre.
  // Discrimine les MM qui font beaucoup de micro-achats ($0) des vrais acheteurs.
  if (settings.minAvgUsdPerBuy > 0) {
    const qualifiedBuys = (recentBuys ?? []).filter(b => {
      if (mmWallets.has(b.wallet_address as string)) return false
      return buyUsd(b) >= settings.minUsdPerBuyer
    })
    const sumQualifiedUsd = qualifiedBuys.reduce((s, b) => s + buyUsd(b), 0)
    const avgUsdPerBuy    = qualifiedBuys.length > 0 ? sumQualifiedUsd / qualifiedBuys.length : 0
    if (qualifiedBuys.length > 0 && avgUsdPerBuy < settings.minAvgUsdPerBuy) {
      const reason =
        `avg $${avgUsdPerBuy.toFixed(0)}/achat (${sumQualifiedUsd.toFixed(0)}$ / ${qualifiedBuys.length} achats)` +
        ` < min $${settings.minAvgUsdPerBuy}`
      console.log(`${tag} SKIP: ${reason}`)
      await logSkippedConvergence(supabase, mint, 'min_avg_usd', buyerMap.size, currentPrice, marketCapUsd)
      return { entered: false, reason }
    }
    console.log(
      `${tag} avg/achat: $${avgUsdPerBuy.toFixed(0)}` +
      ` (${qualifiedBuys.length} achats qualifiés, $${sumQualifiedUsd.toFixed(0)} total)` +
      ` — seuil $${settings.minAvgUsdPerBuy} OK`
    )
  }

  // ── Filtre ventes : retirer les acheteurs qui ont depuis vendu ce token ──────
  // Un wallet dans buyerMap qui a une vente postérieure à son achat ne détient plus
  // le token → il ne compte pas dans la convergence (sinon on entre comme liquidité
  // de sortie — bug DtFkKBC3 : risque_14 vendu 150s avant notre entrée).
  //
  // block_if_sold_within_minutes : si QUELCONQUE wallet suivi a vendu ce token dans
  // les N dernières minutes, bloquer l'entrée même si les acheteurs restants suffisent.
  const { data: allSells } = await supabase
    .from('kymia_risque_sells')
    .select('wallet_address, sold_at')
    .eq('token_mint', mint)

  if ((allSells ?? []).length > 0) {
    // Latest sell per wallet → used to detect still-holding vs already-out
    const latestSellAt = new Map<string, string>()
    for (const s of allSells as { wallet_address: string; sold_at: string }[]) {
      const prev = latestSellAt.get(s.wallet_address)
      if (!prev || s.sold_at > prev) latestSellAt.set(s.wallet_address, s.sold_at)
    }

    // Remove from convergence any wallet whose last sell is AFTER their first buy
    const removedSellers: string[] = []
    for (const [addr, entry] of buyerMap) {
      const lastSell = latestSellAt.get(addr)
      if (lastSell && lastSell > entry.firstBoughtAt) {
        buyerMap.delete(addr)
        removedSellers.push(addr.slice(0, 8) + '…')
      }
    }
    if (removedSellers.length > 0) {
      console.log(`${tag} ${removedSellers.length} acheteur(s) exclu(s) — ont vendu ce token: ${removedSellers.join(', ')}`)
    }

    // block_if_sold_within_minutes : bloquer même si les acheteurs restants suffisent
    if (settings.blockIfSoldWithinMinutes > 0) {
      const cutoffIso = new Date(Date.now() - settings.blockIfSoldWithinMinutes * 60_000).toISOString()
      const recentSell = (allSells as { wallet_address: string; sold_at: string }[])
        .find(s => s.sold_at >= cutoffIso)
      if (recentSell) {
        const minAgo = ((Date.now() - new Date(recentSell.sold_at).getTime()) / 60_000).toFixed(0)
        const reason =
          `wallet ${recentSell.wallet_address.slice(0, 8)}… a vendu il y a ${minAgo}min` +
          ` (block_if_sold_within=${settings.blockIfSoldWithinMinutes}min)`
        console.log(`${tag} SKIP: ${reason}`)
        await logSkippedConvergence(supabase, mint, 'block_if_sold', buyerMap.size, currentPrice, marketCapUsd)
        return { entered: false, reason }
      }
    }
  }

  // ── Strong buyers fast-path ────────────────────────────────────────────────
  // Si ≥ convergence_strong_buyers wallets distincts ont CHACUN dépensé ≥ 200$,
  // on saute les filtres temporels (convergence window, price run, âge) et on va
  // directement aux checks de sécurité. Cible les tokens très jeunes avec signal fort.
  // Filtre mcap relevé à 1M$ (vs maxMcUsd normal).
  const STRONG_MIN_USD   = 200          // seuil fort par acheteur (hardcodé — non DB)
  const STRONG_MAX_MC    = 1_000_000    // mcap plafond pour le fast-path

  const strongBuyers = [...buyerMap.entries()].filter(([, v]) => v.totalUsd >= STRONG_MIN_USD)
  const isStrongPath = settings.convergenceStrongBuyers > 0
    && strongBuyers.length >= settings.convergenceStrongBuyers

  if (!isStrongPath && buyerMap.size < settings.minBuyersForEntry) {
    const mmNote  = mmWallets.size > 0 ? ` (${mmWallets.size} MM exclus)` : ''
    const strongNote = settings.convergenceStrongBuyers > 0
      ? ` | strong: ${strongBuyers.length}/${settings.convergenceStrongBuyers} (≥$${STRONG_MIN_USD})`
      : ''
    const reason = `${buyerMap.size}/${settings.minBuyersForEntry} wallets qualifiés dans fenêtre 6h (min $${settings.minUsdPerBuyer})${mmNote}${strongNote}`
    console.log(`${tag} SKIP: ${reason}`)
    await logSkippedConvergence(supabase, mint, 'not_enough_buyers', buyerMap.size, currentPrice, marketCapUsd)
    return { entered: false, reason }
  }

  // Trier par ordre d'apparition (1er achat chronologique)
  const sortedBuyers = [...buyerMap.entries()]
    .sort((a, b) => a[1].firstBoughtAt.localeCompare(b[1].firstBoughtAt))

  // strongSorted : strong buyers triés par ordre d'apparition.
  // Défini ici (hors bloc) pour être accessible dans les checks de prix communs.
  const strongSorted = [...strongBuyers].sort(
    (a, b) => a[1].firstBoughtAt.localeCompare(b[1].firstBoughtAt)
  )

  if (isStrongPath) {
    // Mcap check avec seuil élevé (1M$) pour le fast-path
    if (marketCapUsd !== null && marketCapUsd > STRONG_MAX_MC) {
      const reason = `[strong] mcap $${marketCapUsd.toFixed(0)} > seuil fast-path $${STRONG_MAX_MC.toLocaleString()}`
      console.log(`${tag} SKIP: ${reason}`)
      await logSkippedConvergence(supabase, mint, 'strong_mcap', buyerMap.size, currentPrice, marketCapUsd)
      return { entered: false, reason }
    }

    // ── Fenêtre de convergence du chemin fort ──────────────────────────────────
    // Les N strong buyers doivent tous être dans une fenêtre de strong_path_window_minutes.
    // Évite que 3 wallets achetant sur 28h (ex : AL55bcvn) déclenchent une entrée.
    if (settings.strongPathWindowMinutes > 0 && strongBuyers.length >= 2) {
      const spanMin =
        (new Date(strongSorted.at(-1)![1].firstBoughtAt).getTime() -
         new Date(strongSorted[0][1].firstBoughtAt).getTime()) / 60_000
      if (spanMin > settings.strongPathWindowMinutes) {
        const reason =
          `[strong] convergence trop lente — ${spanMin.toFixed(0)}min entre 1er et dernier strong buyer` +
          ` (max ${settings.strongPathWindowMinutes}min)`
        console.log(`${tag} SKIP: ${reason}`)
        await logSkippedConvergence(supabase, mint, 'strong_convergence_window', buyerMap.size, currentPrice, marketCapUsd)
        return { entered: false, reason }
      }
      console.log(
        `${tag} [strong] convergence: ${spanMin.toFixed(0)}min` +
        ` (max ${settings.strongPathWindowMinutes}min) — OK`
      )
    }

    console.log(
      `${tag} [strong-path] ${strongBuyers.length}/${settings.convergenceStrongBuyers}` +
      ` acheteurs ≥$${STRONG_MIN_USD}`
    )
  }

  if (!isStrongPath) {
    // ── Condition convergence_window_minutes : fenêtre entre 1er et Nème acheteur ──
    const nthBuyerEntry   = sortedBuyers[settings.minBuyersForEntry - 1]
    const firstBuyerEntry = sortedBuyers[0]
    const convergenceSpanMin =
      (new Date(nthBuyerEntry[1].firstBoughtAt).getTime() -
       new Date(firstBuyerEntry[1].firstBoughtAt).getTime()) / 60_000

    if (convergenceSpanMin > settings.convergenceWindowMinutes) {
      const reason = `convergence trop lente — ${convergenceSpanMin.toFixed(0)}min entre 1er et ${settings.minBuyersForEntry}e acheteur (max ${settings.convergenceWindowMinutes}min)`
      console.log(`${tag} SKIP: ${reason}`)
      await logSkippedConvergence(supabase, mint, 'convergence_window', buyerMap.size, currentPrice, marketCapUsd)
      return { entered: false, reason }
    }
  }

  // ── Checks de prix — COMMUNS aux deux chemins ─────────────────────────────
  // 1er déclencheur = 1er strong buyer (strong path) ou 1er acheteur qualifié (normal path).
  // BUG CORRIGÉ : la strong path avait un "skip price-run" qui court-circuitait ces checks,
  // laissant passer DtFkKBC3 (1er trigger 121K → entrée 265K = +119%).
  const firstTriggerMcap = isStrongPath
    ? strongSorted[0]?.[1].firstMcap
    : sortedBuyers[0]?.[1].firstMcap

  if (firstTriggerMcap && firstTriggerMcap > 0) {
    const firstTriggerPrice = firstTriggerMcap / 1e9
    const pricePctOfFirst   = (currentPrice / firstTriggerPrice) * 100   // 100% = même prix
    const runPct            = pricePctOfFirst - 100                       // >0 = monté, <0 = tombé

    // ── max_price_run_pct : skip si le prix a trop monté depuis le 1er déclencheur ──
    // S'applique maintenant aux DEUX chemins (corrige le bug strong-path).
    if (runPct > settings.maxPriceRunPct) {
      const pathLabel = isStrongPath ? '[strong] ' : ''
      const reason = `${pathLabel}prix +${runPct.toFixed(0)}% depuis le 1er déclencheur (mcap ${firstTriggerMcap.toFixed(0)}→${(currentPrice * 1e9).toFixed(0)}, max +${settings.maxPriceRunPct}%)`
      console.log(`${tag} SKIP: ${reason}`)
      await logSkippedConvergence(supabase, mint, 'max_price_run', buyerMap.size, currentPrice, marketCapUsd)
      return { entered: false, reason }
    }

    // ── min_price_vs_first_trigger_pct : "couteau qui tombe" ──────────────────
    // Skip si le prix courant est inférieur à X% du prix du 1er déclencheur.
    // Ex : 1er acheteur à 360K, entrée à 180K → 50% < seuil 70% → SKIP.
    if (settings.minPriceVsFirstTriggerPct > 0 && pricePctOfFirst < settings.minPriceVsFirstTriggerPct) {
      const pathLabel = isStrongPath ? '[strong] ' : ''
      const reason =
        `${pathLabel}couteau qui tombe : prix à ${pricePctOfFirst.toFixed(0)}% du 1er déclencheur` +
        ` (mcap ${firstTriggerMcap.toFixed(0)}→${(currentPrice * 1e9).toFixed(0)}, min ${settings.minPriceVsFirstTriggerPct}%)`
      console.log(`${tag} SKIP: ${reason}`)
      await logSkippedConvergence(supabase, mint, 'couteau_qui_tombe', buyerMap.size, currentPrice, marketCapUsd)
      return { entered: false, reason }
    }

    console.log(
      `${tag} price vs 1er déclencheur: ${pricePctOfFirst.toFixed(0)}%` +
      ` (run=${runPct > 0 ? '+' : ''}${runPct.toFixed(0)}%,` +
      ` max_run=${settings.maxPriceRunPct}%, min_pct=${settings.minPriceVsFirstTriggerPct}%) — OK`
    )
  }

  // ── max_drawdown_from_peak_pct : "après le pic" ────────────────────────────
  // Skip si le mcap courant est inférieur de plus de X% au plus haut mcap_at_buy
  // observé sur ce token dans la fenêtre 6h.
  // Ex : pic 594K, entrée 404K → drawdown 32% > seuil 20% → SKIP.
  if (settings.maxDrawdownFromPeakPct > 0 && (marketCapUsd ?? 0) > 0) {
    const mcapValues = (recentBuys ?? [])
      .map(b => b.market_cap_at_buy as number | null)
      .filter((v): v is number => v !== null && v > 0)
    if (mcapValues.length > 0) {
      const peakMcap     = Math.max(...mcapValues)
      const drawdownPct  = (peakMcap - marketCapUsd!) / peakMcap * 100
      if (drawdownPct > settings.maxDrawdownFromPeakPct) {
        const reason =
          `après le pic : mcap $${Math.round(marketCapUsd!)} à -${drawdownPct.toFixed(0)}%` +
          ` du pic $${Math.round(peakMcap)} dans la fenêtre (max -${settings.maxDrawdownFromPeakPct}%)`
        console.log(`${tag} SKIP: ${reason}`)
        await logSkippedConvergence(supabase, mint, 'drawdown_depuis_pic', buyerMap.size, currentPrice, marketCapUsd)
        return { entered: false, reason }
      }
      console.log(
        `${tag} drawdown depuis pic: -${drawdownPct.toFixed(0)}%` +
        ` (pic $${Math.round(peakMcap)}, courant $${Math.round(marketCapUsd!)},` +
        ` max -${settings.maxDrawdownFromPeakPct}%) — OK`
      )
    }
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
            await logSkippedConvergence(supabase, mint, 'dex_buy_ratio', buyerMap.size, currentPrice, marketCapUsd)
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
    await logSkippedConvergence(supabase, mint, 'danger_score', buyerMap.size, currentPrice, marketCapUsd)
    return { entered: false, reason }
  }

  // ── Toutes conditions remplies → ouvrir la position ──────────────────────────
  const activeBuyers  = isStrongPath ? strongBuyers : sortedBuyers
  const totalUsd      = activeBuyers.reduce((s, [, v]) => s + v.totalUsd, 0)
  const triggerLabels = activeBuyers.map(([, v]) => v.label)
  const triggerReason = isStrongPath
    ? `[strong] ${strongBuyers.length} wallets ≥$${STRONG_MIN_USD}, $${totalUsd.toFixed(0)} total`
    : `${buyerMap.size} wallets, $${totalUsd.toFixed(0)} total`
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

  // ── Upgrade SCOUT → SCOUT+CONV (complément avec entrée en prix moyen pondéré) ──
  if (openPosRow?.strategy_tag === 'SCOUT') {
    const addedSize   = Math.max(0, settings.positionSizeUsd - openPosRow.size_usd)
    const totalSize   = openPosRow.size_usd + addedSize
    // Prix moyen pondéré : (entry_scout × size_scout + prix_actuel × complément) / total
    const newEntry    = addedSize > 0
      ? (openPosRow.entry_price_usd * openPosRow.size_usd + currentPrice * addedSize) / totalSize
      : openPosRow.entry_price_usd
    const newStopUsd  = newEntry * (1 - settings.stopLossPct / 100)

    const { error: upgradeErr } = await supabase
      .from('kymia_risque_positions')
      .update({
        strategy_tag:       'SCOUT+CONV',
        size_usd:           totalSize,
        original_size_usd:  totalSize,
        entry_price_usd:    parseFloat(newEntry.toFixed(12)),
        stop_price_usd:     parseFloat(newStopUsd.toFixed(12)),
        trigger_reason:     triggerReason,
        trigger_wallets:    triggerLabels,
        updated_at:         new Date().toISOString(),
      })
      .eq('id', openPosRow.id)
      .eq('status', 'OPEN')

    if (upgradeErr) throw new Error(`scout upgrade: ${upgradeErr.message}`)

    console.log(
      `[positions] SCOUT→SCOUT+CONV ${mint.slice(0, 8)}…` +
      ` entry: $${openPosRow.entry_price_usd}×$${openPosRow.size_usd}` +
      ` + $${currentPrice}×$${addedSize}` +
      ` → new entry=$${newEntry.toFixed(8)} stop=$${newStopUsd.toFixed(8)} total=$${totalSize}` +
      ` trigger="${triggerReason}"`
    )

    return { entered: true, positionId: openPosRow.id, reason: `SCOUT→SCOUT+CONV: ${triggerReason}` }
  }

  // ── Insert CONV normal ────────────────────────────────────────────────────────
  const { data: inserted, error: insertErr } = await supabase
    .from('kymia_risque_positions')
    .insert({
      token_mint:         mint,
      token_symbol:       token?.symbol ?? null,
      entry_price_usd:    currentPrice,
      entry_market_cap:   marketCapUsd,
      size_usd:           settings.positionSizeUsd,
      original_size_usd:  settings.positionSizeUsd,
      trigger_reason:     triggerReason,
      trigger_wallets:    triggerLabels,
      security_score:     token?.risque_score ?? null,
      stop_price_usd:     stopPriceUsd,
      high_since_entry:   currentPrice,
      trailing_active:    false,
      strategy_tag:       'CONV',
      status:             'OPEN',
      is_paper:           isPaper,
      tx_signature_entry: null,
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
  | 'CLOSED_TAKE_PROFIT'

export interface PositionRow {
  id:                string
  token_mint:        string
  token_symbol:      string | null
  entry_at:          string
  entry_price_usd:   number
  size_usd:          number
  original_size_usd: number | null   // fixé à l'ouverture, jamais modifié — base du pnl_pct final
  stop_price_usd:    number
  high_since_entry:  number | null
  trailing_active:   boolean
  trigger_wallets:   string[]
  is_paper:          boolean
  partial_tp_taken:  boolean
  realized_pnl_usd:  number | null   // PnL encaissé lors de la vente partielle
  strategy_tag:      string | null   // 'CONV' | 'SCOUT' | 'SCOUT+CONV'
}

export async function closePosition(
  supabase:   SupabaseClient,
  position:   PositionRow,
  exitPrice:  number,
  status:     ClosedStatus,
  exitReason: string,
): Promise<boolean> {
  // PnL total = gain déjà encaissé (vente partielle) + gain sur la part restante.
  // pnl_pct calculé sur original_size_usd pour rester cohérent avec la taille initiale.
  const realizedPnl     = position.realized_pnl_usd ?? 0
  const remainingPnlUsd = (exitPrice - position.entry_price_usd) / position.entry_price_usd * position.size_usd
  const pnlUsd          = realizedPnl + remainingPnlUsd
  const baseSizeUsd     = position.original_size_usd ?? position.size_usd
  const pnlPct          = pnlUsd / baseSizeUsd * 100
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

// ── takePartialProfit ─────────────────────────────────────────────────────────
// Vend sellPct% de la position au prix exitPrice sans clôturer.
// Après l'appel :
//   - realized_pnl_usd = PnL sur la part vendue
//   - size_usd         = part restante
//   - stop_price_usd   = entry_price_usd (breakeven — on ne peut plus perdre)
//   - trailing_active  = true (force l'activation dès le TP)
// Guard idempotent : .eq('partial_tp_taken', false).

export async function takePartialProfit(
  supabase:  SupabaseClient,
  position:  PositionRow,
  exitPrice: number,
  sellPct:   number,
): Promise<boolean> {
  const soldFraction     = sellPct / 100
  const pnlOnSold        = (exitPrice - position.entry_price_usd) / position.entry_price_usd
                           * position.size_usd * soldFraction
  const remainingSizeUsd = position.size_usd * (1 - soldFraction)
  const gainPct          = ((exitPrice - position.entry_price_usd) / position.entry_price_usd * 100).toFixed(1)
  const now              = new Date().toISOString()

  const { data: updated } = await supabase
    .from('kymia_risque_positions')
    .update({
      partial_tp_taken:  true,
      realized_pnl_usd:  parseFloat(pnlOnSold.toFixed(4)),
      size_usd:          parseFloat(remainingSizeUsd.toFixed(4)),
      stop_price_usd:    position.entry_price_usd,         // breakeven
      trailing_active:   true,                              // force activation du trailing
      high_since_entry:  Math.max(position.high_since_entry ?? exitPrice, exitPrice),
      updated_at:        now,
    })
    .eq('id', position.id)
    .eq('status', 'OPEN')
    .eq('partial_tp_taken', false)   // idempotent
    .select('id')
    .maybeSingle()

  if (!updated) {
    console.log(`[positions] ${position.id} partial TP déjà pris ou position fermée — skip`)
    return false
  }

  console.log(
    `[positions] ${position.is_paper ? 'PAPER' : 'LIVE'} PARTIAL TP` +
    ` ${position.token_mint.slice(0, 8)}…` +
    ` +${gainPct}% → vente ${sellPct}% ($${pnlOnSold.toFixed(2)} réalisé)` +
    ` reste: $${remainingSizeUsd.toFixed(2)}, stop=breakeven $${position.entry_price_usd}`
  )

  return true
}

// ── checkScoutEntry ───────────────────────────────────────────────────────────
// Ouvre une position SCOUT (taille réduite) quand un wallet tier A achète
// ≥ scout_min_usd sur un token < scout_max_mcap_usd, sans vente récente ni
// position existante, score ≠ DANGER.
// L'appelant (webhook) vérifie déjà que le wallet est tier A avant d'appeler.

export async function checkScoutEntry(
  supabase:      SupabaseClient,
  mint:          string,
  walletAddress: string,
  walletLabel:   string,
  buyUsd:        number,
  currentPrice:  number,
  marketCapUsd:  number | null,
): Promise<EntryResult> {
  const settings = await loadSettings(supabase)
  const isPaper  = !settings.liveMode
  const tag      = `[scout] ${mint.slice(0, 8)}…`

  // Seuil $ d'achat
  if (buyUsd < settings.scoutMinUsd) {
    console.log(`${tag} SKIP: achat $${buyUsd.toFixed(0)} < min $${settings.scoutMinUsd}`)
    return { entered: false, reason: `scout: achat $${buyUsd.toFixed(0)} < min $${settings.scoutMinUsd}` }
  }

  // Seuil mcap
  if (marketCapUsd !== null && marketCapUsd > settings.scoutMaxMcapUsd) {
    console.log(`${tag} SKIP: mcap $${marketCapUsd.toFixed(0)} > seuil $${settings.scoutMaxMcapUsd}`)
    return { entered: false, reason: `scout: mcap $${marketCapUsd.toFixed(0)} > seuil $${settings.scoutMaxMcapUsd}` }
  }

  // Pas de position déjà ouverte (SCOUT ou autre)
  const { data: existingOpen } = await supabase
    .from('kymia_risque_positions')
    .select('id')
    .eq('token_mint', mint)
    .eq('status', 'OPEN')
    .limit(1)
    .maybeSingle()

  if (existingOpen) {
    console.log(`${tag} SKIP: position déjà ouverte`)
    return { entered: false, reason: 'scout: position déjà ouverte' }
  }

  // Pas de ré-entrée sur un token clôturé
  const { data: closedPos } = await supabase
    .from('kymia_risque_positions')
    .select('id')
    .eq('token_mint', mint)
    .neq('status', 'OPEN')
    .limit(1)
    .maybeSingle()

  if (closedPos) {
    console.log(`${tag} SKIP: token déjà tradé`)
    return { entered: false, reason: 'scout: token déjà tradé' }
  }

  // Pas de vente récente d'un wallet suivi
  if (settings.blockIfSoldWithinMinutes > 0) {
    const cutoffIso = new Date(Date.now() - settings.blockIfSoldWithinMinutes * 60_000).toISOString()
    const { data: recentSells } = await supabase
      .from('kymia_risque_sells')
      .select('wallet_address')
      .eq('token_mint', mint)
      .gte('sold_at', cutoffIso)
      .limit(1)

    if ((recentSells ?? []).length > 0) {
      console.log(`${tag} SKIP: vente récente (block_if_sold_within=${settings.blockIfSoldWithinMinutes}min)`)
      return { entered: false, reason: `scout: vente récente d'un wallet suivi` }
    }
  }

  // Plafond concurrent (même garde-fou que checkEntry)
  const safeConcurrentMax = settings.liveMode
    ? Math.min(settings.maxConcurrentPositions, Math.floor(settings.capitalUsd / Math.max(settings.positionSizeUsd, 1)))
    : settings.maxConcurrentPositions

  const { count: openCount } = await supabase
    .from('kymia_risque_positions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'OPEN')

  if ((openCount ?? 0) >= safeConcurrentMax) {
    console.log(`${tag} SKIP: ${openCount}/${safeConcurrentMax} positions concurrent max`)
    return { entered: false, reason: `scout: ${openCount}/${safeConcurrentMax} concurrent max` }
  }

  // Score sécurité
  const { data: token } = await supabase
    .from('kymia_risque_tokens')
    .select('risque_score, symbol')
    .eq('mint', mint)
    .maybeSingle()

  if (token?.risque_score === 'DANGER') {
    console.log(`${tag} SKIP: score DANGER`)
    return { entered: false, reason: 'scout: score DANGER' }
  }

  // Ouvrir la position scout
  const stopPriceUsd = currentPrice * (1 - settings.stopLossPct / 100)

  console.log(
    `${tag} SCOUT ENTRY: ${walletLabel} a acheté $${buyUsd.toFixed(0)}` +
    ` mcap ${marketCapUsd ? '$' + marketCapUsd.toFixed(0) : 'n/a'}` +
    ` price=$${currentPrice} size=$${settings.scoutSizeUsd} stop=$${stopPriceUsd.toFixed(8)}`
  )

  const { data: inserted, error: insertErr } = await supabase
    .from('kymia_risque_positions')
    .insert({
      token_mint:         mint,
      token_symbol:       token?.symbol ?? null,
      entry_price_usd:    currentPrice,
      entry_market_cap:   marketCapUsd,
      size_usd:           settings.scoutSizeUsd,
      original_size_usd:  settings.scoutSizeUsd,
      trigger_reason:     `scout: ${walletLabel} acheté $${buyUsd.toFixed(0)}`,
      trigger_wallets:    [walletLabel],
      security_score:     token?.risque_score ?? null,
      stop_price_usd:     stopPriceUsd,
      high_since_entry:   currentPrice,
      trailing_active:    false,
      strategy_tag:       'SCOUT',
      status:             'OPEN',
      is_paper:           isPaper,
      tx_signature_entry: null,
    })
    .select('id')
    .single()

  if (insertErr) throw new Error(`scout insert: ${insertErr.message}`)

  console.log(
    `[positions] ${isPaper ? 'PAPER' : 'LIVE'} SCOUT ENTRY ${mint.slice(0, 8)}…` +
    ` price=$${currentPrice} size=$${settings.scoutSizeUsd}` +
    ` stop=$${stopPriceUsd.toFixed(8)} trigger="${walletLabel}"`
  )

  return { entered: true, positionId: (inserted as any).id, reason: `scout: ${walletLabel}` }
}
