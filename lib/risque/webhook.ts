// lib/risque/webhook.ts
// Traitement des événements Helius Enhanced Transaction (type SWAP).
// Appelé depuis app/api/webhook/helius/route.ts via after() — s'exécute
// APRÈS le 200 envoyé à Helius.
//
// Flux par transaction :
//   1. Identifier les wallets surveillés impliqués (kymia_risque_wallets)
//   2. Calculer le solde net par mint pour chaque wallet concerné
//   3. Net > 0 non-stable → BUY  : market cap + checkRug + upsert token + insert buy
//   4. Net < 0 non-stable → SELL : insert sell + update seller_count
//
// Seuil market cap : stocké dans kymia_risque_settings ('max_mc_usd').
// On STOCKE TOUT — le seuil ne sert qu'au log. Filtrer à la lecture permet
// d'ajuster le seuil rétroactivement sans perte de données.
//
// Déduplication : tx_signature UNIQUE sur kymia_risque_buys et kymia_risque_sells —
// un replay ne crée pas de doublon.

import { SupabaseClient }             from '@supabase/supabase-js'
import { fetchRugCheck }              from '@/lib/memecoin/screen'
import { getTokenMarketData }         from '@/lib/risque/pumpfun'
import { checkRug }                   from '@/lib/risque/rug'
import { checkEntry }                 from '@/lib/risque/positions'

// ── Constantes ────────────────────────────────────────────────────────────────

const USDC_MINT        = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT_MINT        = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const WSOL_MINT        = 'So11111111111111111111111111111111111111112'
const STABLES          = new Set([USDC_MINT, USDT_MINT, WSOL_MINT])
const LAMPORTS_PER_SOL = 1_000_000_000

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface TokenBalanceChange {
  userAccount:    string   // wallet (résolu depuis l'ATA par Helius)
  tokenAccount:   string   // ATA
  mint:           string
  rawTokenAmount: { tokenAmount: string; decimals: number }
}

interface AccountData {
  account:             string
  nativeBalanceChange: number
  tokenBalanceChanges: TokenBalanceChange[]
}

interface HeliusTx {
  signature:        string
  timestamp:        number
  type?:            string
  transactionError: unknown
  tokenTransfers?:  TokenTransfer[]
  nativeTransfers?: NativeTransfer[]
  accountData?:     AccountData[]   // Helius Enhanced — userAccount résolu (pas ATA)
}

interface SwapSide {
  mint: string
  net:  number
}

// ── Analyse du solde net par mint pour un wallet donné ────────────────────────
//
// Source primaire : accountData[].tokenBalanceChanges (Helius Enhanced).
//   → userAccount = wallet (résolu), pas l'ATA.
//   → Fix du bug pump.fun : tokenTransfers[].toUserAccount = ATA pour les achats
//     → le wallet n'était jamais détecté comme receveur → 0 achats enregistrés.
//
// Fallback : tokenTransfers net-balance (payloads sans accountData).
//   → Ventes fonctionnaient déjà (fromUserAccount = wallet pour les envois).

function analyzeNetBalances(
  tx:            HeliusTx,
  walletAddress: string,
): {
  buys:             SwapSide[]
  sells:            SwapSide[]
  lamportsPaid:     number    // SOL sortant (pour un achat)
  lamportsReceived: number    // SOL entrant (pour une vente)
  stablePaid:       number    // USDC/USDT sortant (décimales ajustées)
} {
  const empty = { buys: [], sells: [], lamportsPaid: 0, lamportsReceived: 0, stablePaid: 0 }
  if (tx.transactionError !== null) return empty

  const netByMint    = new Map<string, number>()
  let useAccountData = false

  // ── Primaire : accountData.tokenBalanceChanges ────────────────────────────
  for (const ad of (tx.accountData ?? [])) {
    for (const tc of (ad.tokenBalanceChanges ?? [])) {
      if (tc.userAccount !== walletAddress) continue
      const raw     = parseInt(tc.rawTokenAmount.tokenAmount, 10)
      const decimal = raw / Math.pow(10, tc.rawTokenAmount.decimals)
      if (decimal !== 0) {
        netByMint.set(tc.mint, (netByMint.get(tc.mint) ?? 0) + decimal)
        useAccountData = true
      }
    }
  }

  // ── Fallback : tokenTransfers net-balance ─────────────────────────────────
  if (!useAccountData) {
    for (const t of (tx.tokenTransfers ?? [])) {
      if (t.toUserAccount === walletAddress && t.tokenAmount > 0)
        netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) + t.tokenAmount)
      if (t.fromUserAccount === walletAddress && t.tokenAmount > 0)
        netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) - t.tokenAmount)
    }
  }

  const buys = [...netByMint.entries()]
    .filter(([mint, net]) => !STABLES.has(mint) && net > 0)
    .map(([mint, net]) => ({ mint, net }))
    .sort((a, b) => b.net - a.net)

  const sells = [...netByMint.entries()]
    .filter(([mint, net]) => !STABLES.has(mint) && net < 0)
    .map(([mint, net]) => ({ mint, net: Math.abs(net) }))
    .sort((a, b) => b.net - a.net)

  const native = tx.nativeTransfers ?? []
  const lamportsPaid     = native.filter(t => t.fromUserAccount === walletAddress).reduce((s, t) => s + t.amount, 0)
  const lamportsReceived = native.filter(t => t.toUserAccount   === walletAddress).reduce((s, t) => s + t.amount, 0)

  // stablePaid : déjà en unités décimales dans les deux chemins
  const stablePaid = [...netByMint.entries()]
    .filter(([mint, net]) => (mint === USDC_MINT || mint === USDT_MINT) && net < 0)
    .reduce((s, [, net]) => s + Math.abs(net), 0)

  return { buys, sells, lamportsPaid, lamportsReceived, stablePaid }
}

// ── Traitement d'un achat ─────────────────────────────────────────────────────

// processBuy retourne les données de marché + le résultat de l'insert.
// inserted=true uniquement si l'INSERT a réussi (pas duplicate, pas erreur).
// lastError : message Supabase brut si l'insert a échoué (pour diagnostic).
interface BuyMarketData {
  priceUsd:     number | null
  marketCapUsd: number | null
  inserted:     boolean
  lastError:    string | null
}

async function processBuy(
  supabase:      SupabaseClient,
  tx:            HeliusTx,
  mint:          string,
  walletAddress: string,
  walletLabel:   string,
  lamportsPaid:  number,
  stablePaid:    number,
  maxMcUsd:      number,
): Promise<BuyMarketData> {
  // ── Market cap + prix ────────────────────────────────────────────────────
  const marketData = await getTokenMarketData(mint)

  console.log(
    `[webhook] BUY ${mint.slice(0, 8)}… wallet=${walletLabel}` +
    ` price=${marketData ? '$' + marketData.priceUsd.toFixed(8) : 'null'}` +
    ` mcap=${marketData ? '$' + marketData.marketCapUsd.toFixed(0) + ' (' + marketData.source + ')' : 'null'}` +
    (marketData && marketData.marketCapUsd > maxMcUsd ? ` — > $${maxMcUsd} (stocké, filtré à la lecture)` : '')
  )

  // ── Rug checks ──────────────────────────────────────────────────────────
  const rug       = await fetchRugCheck(mint)
  const rugResult = await checkRug(mint, rug)

  // ── Upsert token — AVANT l'insert buy (cohérence logique) ──────────────
  const { error: tokenErr } = await supabase
    .from('kymia_risque_tokens')
    .upsert(
      {
        mint,
        market_cap_usd:      marketData?.marketCapUsd ?? null,
        mcap_source:         marketData?.source ?? null,
        risque_score:        rugResult.score,
        score_reason:        rugResult.reason,
        rug_flags:           rugResult.flags,
        dev_pct:             rugResult.flags.dev_pct,
        top10_pct:           rugResult.flags.top10_pct,
        dev_sold:            rugResult.flags.dev_sold,
        bundled:             rugResult.flags.bundled,
        mint_auth_revoked:   rugResult.flags.mint_auth_revoked,
        freeze_auth_revoked: rugResult.flags.freeze_auth_revoked,
        updated_at:          new Date().toISOString(),
      },
      { onConflict: 'mint' },
    )

  if (tokenErr) {
    console.warn(`[webhook] token upsert ${mint.slice(0, 8)}…: ${tokenErr.message}`)
  }

  // ── Insert buy — unique sur tx_signature (idempotent sur replay) ────────
  const { error: buyErr } = await supabase
    .from('kymia_risque_buys')
    .insert({
      token_mint:        mint,
      wallet_address:    walletAddress,
      wallet_label:      walletLabel,
      tx_signature:      tx.signature,
      bought_at:         new Date(tx.timestamp * 1000).toISOString(),
      sol_amount:        lamportsPaid > 0 ? lamportsPaid / LAMPORTS_PER_SOL : null,
      usdc_amount:       stablePaid   > 0 ? stablePaid                       : null,
      market_cap_at_buy: marketData?.marketCapUsd ?? null,
    })

  if (buyErr) {
    if (buyErr.code === '23505') {
      console.log(`[webhook] buy ${tx.signature.slice(0, 8)}… déjà présent — skip`)
      return { priceUsd: marketData?.priceUsd ?? null, marketCapUsd: marketData?.marketCapUsd ?? null, inserted: false, lastError: null }
    }
    // Erreur non-duplicate : remonte le message brut Supabase pour diagnostic
    const errDetail = `buy insert: ${buyErr.message} (code=${buyErr.code ?? 'none'}) hint=${buyErr.hint ?? ''} detail=${buyErr.details ?? ''}`
    console.error(`[webhook] ${tx.signature.slice(0, 8)}… ${errDetail}`)
    return { priceUsd: null, marketCapUsd: null, inserted: false, lastError: errDetail }
  }

  // ── Mise à jour buyer_count (distinct wallets depuis kymia_risque_buys) ─
  // Max 18 lignes par token (18 wallets surveillés) — count en JS suffisant.
  const { data: buyerRows } = await supabase
    .from('kymia_risque_buys')
    .select('wallet_address')
    .eq('token_mint', mint)

  const distinctBuyers = buyerRows
    ? new Set(buyerRows.map(r => r.wallet_address)).size
    : 1

  await supabase
    .from('kymia_risque_tokens')
    .update({ buyer_count: distinctBuyers, updated_at: new Date().toISOString() })
    .eq('mint', mint)

  console.log(
    `[webhook] ✓ BUY ${mint.slice(0, 8)}…` +
    ` score=${rugResult.score}` +
    (rugResult.reason ? ` (${rugResult.reason})` : '') +
    ` buyers=${distinctBuyers}`
  )

  return { priceUsd: marketData?.priceUsd ?? null, marketCapUsd: marketData?.marketCapUsd ?? null, inserted: true, lastError: null }
}

// ── Traitement d'une vente ────────────────────────────────────────────────────

async function processSell(
  supabase:         SupabaseClient,
  tx:               HeliusTx,
  mint:             string,
  walletAddress:    string,
  walletLabel:      string,
  lamportsReceived: number,
): Promise<void> {
  const { error: sellErr } = await supabase
    .from('kymia_risque_sells')
    .insert({
      token_mint:     mint,
      wallet_address: walletAddress,
      wallet_label:   walletLabel,
      tx_signature:   tx.signature,
      sold_at:        new Date(tx.timestamp * 1000).toISOString(),
      sol_received:   lamportsReceived > 0 ? lamportsReceived / LAMPORTS_PER_SOL : null,
    })

  if (sellErr) {
    if (sellErr.code === '23505') {
      console.log(`[webhook] sell ${tx.signature.slice(0, 8)}… déjà présent — skip`)
      return
    }
    console.error(`[webhook] sell insert ${tx.signature.slice(0, 8)}…: ${sellErr.message}`)
    return
  }

  // Mise à jour seller_count — seulement si le token existe déjà
  const { data: sellerRows } = await supabase
    .from('kymia_risque_sells')
    .select('wallet_address')
    .eq('token_mint', mint)

  const distinctSellers = sellerRows
    ? new Set(sellerRows.map(r => r.wallet_address)).size
    : 1

  await supabase
    .from('kymia_risque_tokens')
    .update({ seller_count: distinctSellers, updated_at: new Date().toISOString() })
    .eq('mint', mint)

  console.log(
    `[webhook] ✓ SELL ${mint.slice(0, 8)}… wallet=${walletLabel}` +
    ` sol_received=${lamportsReceived > 0 ? (lamportsReceived / LAMPORTS_PER_SOL).toFixed(3) : 'n/a'}` +
    ` sellers=${distinctSellers}`
  )
}

// ── Point d'entrée public ─────────────────────────────────────────────────────

export async function processWebhookEvent(
  rawId:   string,
  payload: unknown,
  supabase: SupabaseClient,
): Promise<{ buysInserted: number; sellsInserted: number; buyErrors: string[] }> {
  if (!Array.isArray(payload) || payload.length === 0) {
    console.log(`[webhook] raw ${rawId.slice(0, 8)}: payload vide ou invalide`)
    return { buysInserted: 0, sellsInserted: 0, buyErrors: [] }
  }

  // ── Charger les wallets surveillés ──────────────────────────────────────
  const { data: wallets, error: walletErr } = await supabase
    .from('kymia_risque_wallets')
    .select('address, label')

  if (walletErr) throw new Error(`wallet select: ${walletErr.message}`)
  if (!wallets?.length) {
    console.warn('[webhook] kymia_risque_wallets vide')
    return { buysInserted: 0, sellsInserted: 0, buyErrors: [] }
  }

  const walletMap = new Map<string, string>(
    wallets.map(w => [w.address as string, (w.label ?? (w.address as string).slice(0, 8)) as string])
  )

  // ── Charger le seuil market cap (pour log uniquement) ───────────────────
  const { data: setting } = await supabase
    .from('kymia_risque_settings')
    .select('value')
    .eq('key', 'max_mc_usd')
    .maybeSingle()

  const maxMcUsd = setting ? Number(setting.value) : 50_000

  // ── Traiter chaque transaction ──────────────────────────────────────────
  const txs = payload as HeliusTx[]
  let buysInserted  = 0
  let sellsInserted = 0
  const buyErrors: string[] = []

  for (const tx of txs) {
    if (tx.transactionError !== null) continue

    // ── Identifier les wallets impliqués ─────────────────────────────────────
    // Source primaire : tokenBalanceChanges[].userAccount
    //   Helius résout ATA → wallet ici. Le feePayer (qui peut être un tiers —
    //   bot, agrégateur) n'apparaît PAS dans tokenBalanceChanges, donc il n'est
    //   jamais confondu avec un wallet suivi.
    //
    // Fallback : tokenTransfers[].fromUserAccount uniquement (ventes sans accountData).
    //   NB : toUserAccount n'est PAS utilisé — c'est l'ATA pour les achats pump.fun.
    //
    // Helius ne pousse que les txs où nos adresses figurent → involved.size=0
    // ne devrait pas arriver, mais le guard reste pour les txs système rares.
    const involved = new Set<string>()

    for (const ad of (tx.accountData ?? [])) {
      for (const tc of (ad.tokenBalanceChanges ?? [])) {
        if (walletMap.has(tc.userAccount)) involved.add(tc.userAccount)
      }
    }
    // Fallback : ventes où accountData est absent (tokenTransfers only)
    if (involved.size === 0) {
      for (const t of (tx.tokenTransfers ?? [])) {
        if (walletMap.has(t.fromUserAccount)) involved.add(t.fromUserAccount)
      }
    }

    if (involved.size === 0) continue

    for (const walletAddress of involved) {
      const walletLabel = walletMap.get(walletAddress)!
      const { buys, sells, lamportsPaid, lamportsReceived, stablePaid } =
        analyzeNetBalances(tx, walletAddress)

      for (const buy of buys) {
        let marketResult: BuyMarketData =
          { priceUsd: null, marketCapUsd: null, inserted: false, lastError: null }
        try {
          marketResult = await processBuy(
            supabase, tx, buy.mint,
            walletAddress, walletLabel,
            lamportsPaid, stablePaid, maxMcUsd,
          )
          // N'incrémente QUE si l'INSERT Supabase a effectivement réussi
          if (marketResult.inserted) {
            buysInserted++
          } else if (marketResult.lastError) {
            buyErrors.push(marketResult.lastError)
          }
        } catch (e: any) {
          console.error(`[webhook] processBuy ${buy.mint.slice(0, 8)}… ${walletLabel}:`, e.message)
          buyErrors.push(`processBuy threw: ${e.message}`)
        }

        // Vérifier les conditions d'entrée après chaque buy
        if (marketResult.priceUsd !== null) {
          try {
            const entry = await checkEntry(
              supabase, buy.mint,
              marketResult.priceUsd,
              marketResult.marketCapUsd,
            )
            if (entry.entered) {
              console.log(`[webhook] POSITION OUVERTE ${buy.mint.slice(0, 8)}…: ${entry.reason}`)
            }
          } catch (e: any) {
            console.error(`[webhook] checkEntry ${buy.mint.slice(0, 8)}…:`, e.message)
          }
        }

        // Throttle DexScreener + RugCheck + RPC
        await new Promise(r => setTimeout(r, 250))
      }

      for (const sell of sells) {
        try {
          await processSell(
            supabase, tx, sell.mint,
            walletAddress, walletLabel,
            lamportsReceived,
          )
          sellsInserted++
        } catch (e: any) {
          console.error(`[webhook] processSell ${sell.mint.slice(0, 8)}… ${walletLabel}:`, e.message)
        }
      }
    }
  }

  console.log(
    `[webhook] raw ${rawId.slice(0, 8)}: ${txs.length} txs` +
    ` → buys=${buysInserted} sells=${sellsInserted}` +
    (buyErrors.length > 0 ? ` buy_errors=${buyErrors.length}` : '')
  )
  if (buyErrors.length > 0) {
    console.error(`[webhook] buy errors raw ${rawId.slice(0, 8)}:`, buyErrors)
  }

  return { buysInserted, sellsInserted, buyErrors }
}
