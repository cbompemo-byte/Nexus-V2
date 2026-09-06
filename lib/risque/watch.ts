// lib/risque/watch.ts
// Module Risque — copy-trading manuel pump.fun (observation pure).
// Job cycle 30 min (cron-job.org → /api/risque/watch).
//
// Pour chaque wallet dans kymia_risque_wallets :
//   1. Fetch les SWAP txs Helius depuis le dernier watch_cursor
//   2. Détecte les BUY via solde net par mint (parseBuyEvent identique à watch.ts)
//   3. Filtre market_cap <= 30 000 USD (DexScreener)
//   4. Lance screenToken (7 checks memecoins, check5 informatif)
//   5. Upsert dans kymia_risque_signals (1 ligne/token, buyer_count incrémenté)
//
// AUCUN trade automatique. Aucune écriture dans kymia_dryrun_positions
// ni kymia_memecoin_paper. Observation uniquement.

import { SupabaseClient }            from '@supabase/supabase-js'
import { fetchPairForMint, fetchRugCheck, screenToken, type DexPair } from '@/lib/memecoin/screen'

// ── Config ─────────────────────────────────────────────────────────────────────

const HELIUS_API_KEY    = process.env.NEXT_PUBLIC_HELIEUS_KEY ?? ''
const HELIUS_BASE       = 'https://api.helius.xyz/v0'
const USDC_MINT         = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL_MINT         = 'So11111111111111111111111111111111111111112'
const USDT_MINT         = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const STABLES           = new Set([USDC_MINT, WSOL_MINT, USDT_MINT])
const LAMPORTS_PER_SOL  = 1_000_000_000
const MAX_TXS_PER_WATCH = 50
const MARKET_CAP_MAX    = 30_000   // USD — filtre d'affichage principal

// ── Types ──────────────────────────────────────────────────────────────────────

interface TokenTransfer {
  mint:            string
  fromUserAccount: string
  toUserAccount:   string
  tokenAmount:     number
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
  tokenTransfers?:  TokenTransfer[]
  nativeTransfers?: NativeTransfer[]
}

interface BuyEvent {
  signature:  string
  timestamp:  number
  mint:       string
  solAmount:  number | null
  usdcAmount: number | null
}

// ── parseBuyEvent — solde net par mint ────────────────────────────────────────
// Identique à lib/smartmoney/watch.ts.
// BUY = solde net positif sur un non-stable après la tx.
// Routing zero-net (reçu + renvoyé même montant) → ignoré.
// Pas de vérification de paiement SOL (transite via comptes intermédiaires).

function parseBuyEvent(tx: HeliusTx, walletAddress: string): BuyEvent | null {
  if (tx.transactionError !== null) return null

  const transfers = tx.tokenTransfers ?? []
  if (transfers.length === 0) return null

  const netByMint = new Map<string, number>()
  for (const t of transfers) {
    if (t.toUserAccount === walletAddress && t.tokenAmount > 0)
      netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) + t.tokenAmount)
    if (t.fromUserAccount === walletAddress && t.tokenAmount > 0)
      netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) - t.tokenAmount)
  }

  const acquired = [...netByMint.entries()]
    .filter(([mint, net]) => !STABLES.has(mint) && net > 0)
    .sort((a, b) => b[1] - a[1])

  if (acquired.length === 0) return null

  const [finalMint] = acquired[0]

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

// ── fetchNewBuys ───────────────────────────────────────────────────────────────

async function fetchNewBuys(
  address:    string,
  lastCursor: string | null,
): Promise<{ buys: BuyEvent[]; newCursor: string | null; credits: number }> {
  const url = new URL(`${HELIUS_BASE}/addresses/${address}/transactions`)
  url.searchParams.set('api-key', HELIUS_API_KEY)
  url.searchParams.set('type',    'SWAP')
  url.searchParams.set('limit',   String(MAX_TXS_PER_WATCH))

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'KYMIA-RISQUE/1.0' },
    signal:  AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`Helius HTTP ${res.status}`)

  const txs: HeliusTx[] = await res.json()
  if (!Array.isArray(txs) || txs.length === 0)
    return { buys: [], newCursor: lastCursor, credits: 1 }

  const newCursor = txs[0].signature
  const cutoffIdx = lastCursor ? txs.findIndex(t => t.signature === lastCursor) : txs.length
  const newTxs    = txs.slice(0, cutoffIdx === -1 ? txs.length : cutoffIdx)

  const buys: BuyEvent[] = []
  for (const tx of newTxs) {
    const buy = parseBuyEvent(tx, address)
    if (buy) buys.push(buy)
  }

  return { buys, newCursor, credits: txs.length }
}

// ── processSignal — filtre mcap + checks + upsert ─────────────────────────────

type SignalResult = 'saved' | 'updated' | 'filtered_mcap' | 'no_pair'

async function processSignal(
  supabase:    SupabaseClient,
  walletLabel: string,
  buy:         BuyEvent,
): Promise<SignalResult> {
  const { mint } = buy

  // DexScreener — pair + market cap
  const pair: DexPair | null = await fetchPairForMint(mint)
  if (!pair) {
    console.log(`[risque] ${mint.slice(0, 8)}… pas de pair DexScreener`)
    return 'no_pair'
  }

  const marketCap = pair.marketCap ?? null
  if (marketCap === null || marketCap > MARKET_CAP_MAX) {
    console.log(`[risque] ${mint.slice(0, 8)}… mcap=${marketCap ?? 'null'} > ${MARKET_CAP_MAX} — filtré`)
    return 'filtered_mcap'
  }

  const symbol = pair.baseToken.symbol ?? mint.slice(0, 8)

  // ── Checks sécurité ──────────────────────────────────────────────────────────
  // screenToken réutilisé tel quel. check5 (âge/volume) est informatif :
  // les tokens pump.fun < 30K mcap sont systématiquement < 24h → fail check5 attendu.
  //
  // memecoin_score :
  //   FULL / PARTIAL / WEAK  — éligible (grade de screenToken)
  //   INELIGIBLE:<check>     — au moins un check échoue (ex: INELIGIBLE:check2)
  //   DATA_UNAVAILABLE       — screenToken a levé une exception (RPC, Jupiter, etc.)
  //
  // null ne doit plus apparaître — il signifiait auparavant "éligible_grade null"
  // ce qui était indiscernable de "check non exécuté".

  let securityChecks: Record<string, unknown> | null = null
  let memeScore: string = 'DATA_UNAVAILABLE'

  console.log(`[risque] ${symbol} — lancement screenToken (mcap=$${marketCap.toFixed(0)})`)
  try {
    const rug    = await fetchRugCheck(mint)
    const screen = await screenToken(mint, pair, rug)

    securityChecks = {
      check1: screen.check1,
      check2: screen.check2,
      check3: screen.check3,
      check4: screen.check4,
      check5: { ...screen.check5, note: 'informatif — pas de filtre âge en mode Risque' },
      check6: screen.check6,
      check7: screen.check7,
      first_failed: screen.first_failed_check ?? null,
    }

    memeScore = screen.eligible_grade
      ?? `INELIGIBLE:${screen.first_failed_check ?? 'unknown'}`

    console.log(
      `[risque] ${walletLabel} BUY ${symbol}` +
      ` mcap=$${marketCap.toFixed(0)} score=${memeScore}`
    )
  } catch (e: any) {
    console.error(`[risque] screenToken ${symbol} (${mint.slice(0, 8)}…):`, e.message)
    // memeScore reste 'DATA_UNAVAILABLE', securityChecks reste null
  }

  // ── Upsert : 1 ligne par token, buyer_count incrémenté par wallet ────────────
  const { data: existing } = await supabase
    .from('kymia_risque_signals')
    .select('id, buyer_count, buyer_wallets')
    .eq('token_mint', mint)
    .maybeSingle()

  if (existing) {
    const wallets: string[] = existing.buyer_wallets ?? []
    if (wallets.includes(walletLabel)) return 'updated'
    await supabase
      .from('kymia_risque_signals')
      .update({
        buyer_count:   existing.buyer_count + 1,
        buyer_wallets: [...wallets, walletLabel],
        updated_at:    new Date().toISOString(),
      })
      .eq('token_mint', mint)
    return 'updated'
  }

  await supabase.from('kymia_risque_signals').insert({
    token_mint:        mint,
    token_symbol:      pair.baseToken.symbol ?? null,
    token_name:        pair.baseToken.name   ?? null,
    contract_address:  mint,
    market_cap_at_buy: marketCap,
    buyer_count:       1,
    buyer_wallets:     [walletLabel],
    security_checks:   securityChecks,
    memecoin_score:    memeScore,
    first_detected_at: new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  })
  return 'saved'
}

// ── runRisqueWatch — point d'entrée public ────────────────────────────────────

export interface RisqueWatchResult {
  wallets_checked: number
  buys_found:      number
  signals_saved:   number
  filtered_mcap:   number
  credits_used:    number
}

export async function runRisqueWatch(
  supabase: SupabaseClient,
): Promise<RisqueWatchResult> {
  if (!HELIUS_API_KEY) throw new Error('NEXT_PUBLIC_HELIEUS_KEY manquant')

  const { data: wallets, error } = await supabase
    .from('kymia_risque_wallets')
    .select('address, label, watch_cursor')
    .order('last_watched_at', { ascending: true, nullsFirst: true })

  if (error) throw new Error(`wallet select: ${error.message}`)
  if (!wallets?.length) {
    console.log('[risque] aucun wallet — run annulé')
    return { wallets_checked: 0, buys_found: 0, signals_saved: 0, filtered_mcap: 0, credits_used: 0 }
  }

  console.log(`[risque] ${wallets.length} wallets à surveiller`)

  let totalCredits  = 0
  let totalBuys     = 0
  let totalSaved    = 0
  let totalFiltered = 0

  for (const w of wallets as any[]) {
    const lastCursor: string | null = w.watch_cursor ?? null
    let   newCursor:  string | null = lastCursor
    let   buys:       BuyEvent[]    = []

    try {
      const fetched  = await fetchNewBuys(w.address, lastCursor)
      buys           = fetched.buys
      newCursor      = fetched.newCursor
      totalCredits  += fetched.credits
      console.log(
        `[risque] ${(w.address as string).slice(0, 8)}…` +
        ` credits=${fetched.credits} new_buys=${buys.length}`
      )
    } catch (e: any) {
      console.error(`[risque] ${(w.address as string).slice(0, 8)}… fetch:`, e.message)
    }

    totalBuys += buys.length

    for (const buy of buys) {
      try {
        const result = await processSignal(supabase, w.label ?? w.address.slice(0, 8), buy)
        if (result === 'saved')           totalSaved++
        if (result === 'filtered_mcap')   totalFiltered++
      } catch (e: any) {
        console.error(`[risque] processSignal ${buy.mint.slice(0, 8)}…:`, e.message)
      }
      await new Promise(r => setTimeout(r, 400))   // throttle DexScreener + RugCheck
    }

    await supabase
      .from('kymia_risque_wallets')
      .update({ last_watched_at: new Date().toISOString(), watch_cursor: newCursor })
      .eq('address', w.address)
  }

  console.log(
    `[risque] terminé — wallets=${wallets.length}` +
    ` buys=${totalBuys} saved=${totalSaved} filtered=${totalFiltered} credits=${totalCredits}`
  )

  return {
    wallets_checked: wallets.length,
    buys_found:      totalBuys,
    signals_saved:   totalSaved,
    filtered_mcap:   totalFiltered,
    credits_used:    totalCredits,
  }
}
