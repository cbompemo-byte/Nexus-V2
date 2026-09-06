// lib/smartmoney/watch.ts
// Smart Money Watch — Étape 2 : surveillance des achats récents.
// Job séparé, cycle 60 min (cron-job.org → /api/smartmoney/watch).
// Observation pure — aucun trade réel.
//
// Pour chaque wallet VERIFIED :
//   1. Fetch les SWAP txs depuis le dernier watch_cursor (cursor Helius)
//   2. Détecte les BUY (SOL/USDC → token)
//   3. Lance les checks 1,2,3,4,6,7 sur chaque token acheté
//      (check5 âge/volume loggué mais NON BLOQUANT — un wallet vérifié
//       qui achète = meilleure preuve qu'un âge minimum)
//   4. Log le signal dans kymia_smartmoney_signals
//   5. Met à jour la convergence (3+ wallets distincts sur même token en 6h)
//
// Budget Helius : ≤ 50 crédits/wallet/run × 15 wallets × 24 runs/jour
//                = ~18 000 crédits/mois (18% du quota 100K)

import { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchRugCheck,
  fetchPairForMint,
  runCheck1,
  runCheck2,
  runCheck3,
  runCheck4,
  runCheck5,
  runCheck6,
  runCheck7,
  type DexPair,
} from '@/lib/memecoin/screen'

// ── Config ─────────────────────────────────────────────────────────────────────

const HELIUS_API_KEY        = process.env.NEXT_PUBLIC_HELIEUS_KEY ?? ''
const HELIUS_BASE           = 'https://api.helius.xyz/v0'
const USDC_MINT             = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL_MINT             = 'So11111111111111111111111111111111111111112'
const USDT_MINT             = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const STABLES               = new Set([USDC_MINT, WSOL_MINT, USDT_MINT])
const LAMPORTS_PER_SOL      = 1_000_000_000
const MAX_TXS_PER_WATCH     = 50                // crédits max par wallet par run
const CONVERGENCE_WINDOW_MS = 6 * 3600_000      // fenêtre 6h
const CONVERGENCE_MIN       = 3                 // 3+ wallets distincts = convergence

// ── Types internes ─────────────────────────────────────────────────────────────

interface TokenTransfer {
  mint:            string
  fromUserAccount: string
  toUserAccount:   string
  tokenAmount:     number   // montant brut (non normalisé)
}

interface NativeTransfer {
  fromUserAccount: string
  toUserAccount:   string
  amount:          number   // lamports
}

interface HeliusTx {
  signature:        string
  timestamp:        number
  transactionError: unknown
  type:             string
  tokenTransfers?:  TokenTransfer[]
  nativeTransfers?: NativeTransfer[]
  events?: {
    swap?: {
      nativeInput?:   { amount: string }
      nativeOutput?:  { amount: string }
      tokenInputs?:   Array<{ mint: string; tokenAmount: number }>
      tokenOutputs?:  Array<{ mint: string; tokenAmount: number }>
    }
  }
}

interface BuyEvent {
  signature:  string
  timestamp:  number
  mint:       string
  solAmount:  number | null
  usdcAmount: number | null
}

// ── parseBuyEvent — détecte uniquement les BUY (SOL/USDC/USDT → token) ──────────
//
// Deux chemins par ordre de priorité :
//
//   Chemin C (primaire) — tokenTransfers top-level
//     Présent dans toutes les txs Helius enrichies, y compris PUMP_FUN
//     sans events.swap. On vérifie le SENS du flux :
//       BUY  = wallet reçoit un non-stable (toUserAccount === address)
//              ET envoie un stable OU paie en SOL natif
//       VENTE = wallet envoie un non-stable (fromUserAccount === address) → ignoré
//     Multi-hop : on prend le DERNIER non-stable reçu (token final).
//
//   Chemin A (fallback) — events.swap.tokenOutputs
//     Pour les txs non-PUMP_FUN qui ont la structure enrichie complète.

function parseBuyEvent(tx: HeliusTx, walletAddress: string): BuyEvent | null {
  if (tx.transactionError !== null) return null

  // ── Chemin C ────────────────────────────────────────────────────────────────
  const transfers = tx.tokenTransfers ?? []

  if (transfers.length === 0) return null

  // ── Solde net par mint pour CE wallet ────────────────────────────────────────
  // Somme des entrées (toUserAccount) moins sorties (fromUserAccount).
  // Fix BUG routing : un token reçu puis renvoyé dans la même tx → net = 0 → ignoré.
  // Fix BUG path A  : events.swap.tokenOutputs supprimé — ne vérifie pas l'adresse
  //                   wallet et génère des faux positifs sur txs RAYDIUM multi-hop.
  const netByMint = new Map<string, number>()
  for (const t of transfers) {
    if (t.toUserAccount === walletAddress && t.tokenAmount > 0) {
      netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) + t.tokenAmount)
    }
    if (t.fromUserAccount === walletAddress && t.tokenAmount > 0) {
      netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) - t.tokenAmount)
    }
  }

  // Tokens non-stables avec solde net positif = effectivement acquis dans ce tx
  const acquired = [...netByMint.entries()]
    .filter(([mint, net]) => !STABLES.has(mint) && net > 0)
    .sort((a, b) => b[1] - a[1])   // tri par net décroissant

  if (acquired.length === 0) return null

  const [finalMint] = acquired[0]

  // Montant payé — meilleur effort (tokenTransfers normalisés, pas de /1e6)
  const stablePaid = [...netByMint.entries()]
    .filter(([mint, net]) => (mint === USDC_MINT || mint === USDT_MINT) && net < 0)
    .reduce((s, [, net]) => s + Math.abs(net), 0)

  const nativeOuts   = tx.nativeTransfers ?? []
  const lamportsPaid = nativeOuts
    .filter(t => t.fromUserAccount === walletAddress)
    .reduce((s, t) => s + t.amount, 0)

  return {
    signature:  tx.signature,
    timestamp:  tx.timestamp,
    mint:       finalMint,
    solAmount:  lamportsPaid > 0 ? lamportsPaid / LAMPORTS_PER_SOL : null,
    usdcAmount: stablePaid  > 0 ? stablePaid                       : null,
  }
}

// ── fetchNewBuys — txs SWAP depuis le dernier curseur ─────────────────────────

async function fetchNewBuys(
  address:    string,
  lastCursor: string | null,
): Promise<{ buys: BuyEvent[]; newCursor: string | null; credits: number }> {
  // `address` est passé à parseBuyEvent pour vérifier la direction du flux
  const url = new URL(`${HELIUS_BASE}/addresses/${address}/transactions`)
  url.searchParams.set('api-key', HELIUS_API_KEY)
  url.searchParams.set('type',    'SWAP')
  url.searchParams.set('limit',   String(MAX_TXS_PER_WATCH))

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'KYMIA/1.0' },
    signal:  AbortSignal.timeout(12_000),
  })

  if (!res.ok) throw new Error(`Helius HTTP ${res.status}`)

  const txs: HeliusTx[] = await res.json()
  if (!Array.isArray(txs) || txs.length === 0) {
    return { buys: [], newCursor: lastCursor, credits: 1 }
  }

  const newCursor = txs[0].signature   // tx la plus récente = nouveau curseur

  // Txs nouvelles depuis lastCursor (exclut lastCursor lui-même)
  const cutoffIdx = lastCursor
    ? txs.findIndex(t => t.signature === lastCursor)
    : txs.length
  const newTxs = txs.slice(0, cutoffIdx === -1 ? txs.length : cutoffIdx)

  const buys: BuyEvent[] = []
  for (const tx of newTxs) {
    const buy = parseBuyEvent(tx, address)
    if (buy) buys.push(buy)
  }

  return { buys, newCursor, credits: txs.length }
}

// ── checkAndSignal — checks sécurité + insertion signal ───────────────────────

async function checkAndSignal(
  supabase:      SupabaseClient,
  walletAddress: string,
  walletLabel:   string | null,
  walletSource:  string | null,
  buy:           BuyEvent,
): Promise<void> {
  const { mint } = buy

  // ── Données token ────────────────────────────────────────────────────────────
  const pair: DexPair | null = await fetchPairForMint(mint)

  if (!pair) {
    console.log(`[watch] ${mint.slice(0, 8)}… pas de pair DexScreener — signal ignoré`)
    return
  }

  const rug           = await fetchRugCheck(mint)
  const priceAtSignal = parseFloat(pair.priceUsd || '0')

  // ── Checks 1,2,3,4,6,7 (check5 loggué séparément, non bloquant) ─────────────
  const check1 = await runCheck1(mint)
  const check2 = runCheck2(pair, rug)
  const check3 = runCheck3(rug)
  const check4 = await runCheck4(mint, pair)
  const check5 = runCheck5(pair)    // observation uniquement — ne détermine pas checks_passed
  const check6 = runCheck6(rug)
  const check7 = runCheck7(rug)

  // checks_passed = true si checks 1,2,3,4,6,7 tous passed ou genuinely skipped
  // (les "upstream check failed" ne comptent pas comme échec — la cause racine
  //  est déjà capturée dans le check qui a réellement échoué)
  const securityChecks = [check1, check2, check3, check4, check6, check7]
  const checksPassed   = securityChecks.every(c => c.result !== 'failed')

  const check5Note = check5.result === 'failed'
    ? `non bloquant (mode SM) : ${String(check5.detail?.reason ?? 'failed')}`
    : null

  const genuineSkips = securityChecks.filter(
    c => c.result === 'skipped' && c.detail?.reason !== 'upstream check failed'
  ).length
  const grade: 'FULL' | 'PARTIAL' | 'WEAK' | null = checksPassed
    ? (genuineSkips === 0 ? 'FULL' : genuineSkips <= 2 ? 'PARTIAL' : 'WEAK')
    : null

  const checksDetail = {
    check1, check2, check3, check4,
    check5: { ...check5, sm_note: 'non bloquant en mode smart money' },
    check6, check7,
  }

  const signalAt = new Date().toISOString()

  console.log(
    `[watch] ${walletAddress.slice(0, 8)}… BUY ${mint.slice(0, 8)}…` +
    ` price=$${priceAtSignal.toFixed(8)}` +
    ` checks=${checksPassed ? 'PASSED' : 'FAILED'} grade=${grade ?? 'n/a'}` +
    (check5Note ? ` | check5: ${check5Note}` : '')
  )

  // ── Insertion signal ─────────────────────────────────────────────────────────
  const { error: insertErr } = await supabase
    .from('kymia_smartmoney_signals')
    .insert({
      wallet_address:  walletAddress,
      wallet_label:    walletLabel,
      wallet_source:   walletSource,
      token_mint:      mint,
      token_symbol:    pair.baseToken.symbol,
      token_name:      pair.baseToken.name,
      signal_at:       signalAt,
      price_at_signal: priceAtSignal > 0 ? priceAtSignal : null,
      tx_signature:    buy.signature,
      checks_passed:   checksPassed,
      checks_detail:   checksDetail,
      eligible_grade:  grade,
      check5_note:     check5Note,
    })

  if (insertErr) {
    console.error(`[watch] insert signal ${mint.slice(0, 8)}…:`, insertErr.message)
    return
  }

  // ── Convergence — 3+ wallets distincts sur même token en 6h ─────────────────
  const windowStart = new Date(Date.now() - CONVERGENCE_WINDOW_MS).toISOString()

  const { data: recentSignals } = await supabase
    .from('kymia_smartmoney_signals')
    .select('wallet_address')
    .eq('token_mint', mint)
    .gte('signal_at', windowStart)

  if (recentSignals && recentSignals.length > 0) {
    const distinctWallets = new Set(recentSignals.map(r => r.wallet_address)).size
    if (distinctWallets >= CONVERGENCE_MIN) {
      await supabase
        .from('kymia_smartmoney_signals')
        .update({ is_convergence: true, convergence_count: distinctWallets })
        .eq('token_mint', mint)
        .gte('signal_at', windowStart)
      console.log(
        `[watch] CONVERGENCE ${mint.slice(0, 8)}…` +
        ` — ${distinctWallets} wallets distincts en 6h`
      )
    }
  }
}

// ── runSmartMoneyWatch — point d'entrée public ────────────────────────────────

export interface WatchRunResult {
  wallets_checked:    number
  buys_found:         number
  signals_attempted:  number
  credits_used:       number
}

export async function runSmartMoneyWatch(
  supabase: SupabaseClient,
): Promise<WatchRunResult> {
  if (!HELIUS_API_KEY) throw new Error('NEXT_PUBLIC_HELIEUS_KEY manquant')

  const { data: wallets, error } = await supabase
    .from('kymia_smart_wallets')
    .select('address, label, source, watch_cursor, last_watched_at')
    .eq('status', 'VERIFIED')
    .order('last_watched_at', { ascending: true, nullsFirst: true })

  if (error) throw new Error(`wallet select: ${error.message}`)

  if (!wallets?.length) {
    console.log('[watch] aucun wallet VERIFIED — run annulé')
    return { wallets_checked: 0, buys_found: 0, signals_attempted: 0, credits_used: 0 }
  }

  console.log(`[watch] ${wallets.length} wallet(s) VERIFIED à surveiller`)

  let totalCredits  = 0
  let totalBuys     = 0
  let totalSignals  = 0

  for (const w of wallets as any[]) {
    const lastCursor: string | null = w.watch_cursor ?? null
    let newCursor:    string | null = lastCursor
    let buys:         BuyEvent[]    = []

    try {
      const fetched  = await fetchNewBuys(w.address, lastCursor)
      buys           = fetched.buys
      newCursor      = fetched.newCursor
      totalCredits  += fetched.credits

      console.log(
        `[watch] ${(w.address as string).slice(0, 8)}…` +
        ` credits=${fetched.credits} new_buys=${buys.length}` +
        (buys.length > 0 ? ` tokens=[${buys.map(b => b.mint.slice(0, 6)).join(', ')}]` : '')
      )
    } catch (e: any) {
      console.error(`[watch] ${(w.address as string).slice(0, 8)}… fetch error:`, e.message)
    }

    totalBuys += buys.length

    for (const buy of buys) {
      try {
        await checkAndSignal(supabase, w.address, w.label ?? null, w.source ?? null, buy)
        totalSignals++
      } catch (e: any) {
        console.error(`[watch] checkAndSignal ${buy.mint.slice(0, 8)}…:`, e.message)
      }
      // Throttle entre appels DexScreener + RugCheck
      await new Promise(r => setTimeout(r, 400))
    }

    await supabase
      .from('kymia_smart_wallets')
      .update({
        last_watched_at: new Date().toISOString(),
        watch_cursor:    newCursor,
      })
      .eq('address', w.address)
  }

  console.log(
    `[watch] run terminé — wallets=${wallets.length}` +
    ` buys=${totalBuys} signals=${totalSignals} credits=${totalCredits}`
  )

  return {
    wallets_checked:   wallets.length,
    buys_found:        totalBuys,
    signals_attempted: totalSignals,
    credits_used:      totalCredits,
  }
}
