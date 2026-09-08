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

import { SupabaseClient } from '@supabase/supabase-js'
import { fetchRugCheck }  from '@/lib/memecoin/screen'
import { getMarketCap }   from '@/lib/risque/pumpfun'
import { checkRug }       from '@/lib/risque/rug'

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

interface HeliusTx {
  signature:        string
  timestamp:        number
  type?:            string
  transactionError: unknown
  tokenTransfers?:  TokenTransfer[]
  nativeTransfers?: NativeTransfer[]
}

interface SwapSide {
  mint: string
  net:  number
}

// ── Analyse du solde net par mint pour un wallet donné ────────────────────────
// Même logique que lib/risque/watch.ts (dupliquée intentionnellement —
// les deux modules peuvent évoluer indépendamment).

function analyzeNetBalances(
  tx:            HeliusTx,
  walletAddress: string,
): {
  buys:             SwapSide[]
  sells:            SwapSide[]
  lamportsPaid:     number    // SOL sortant (pour un achat)
  lamportsReceived: number    // SOL entrant (pour une vente)
  stablePaid:       number    // USDC/USDT sortant
} {
  const empty = { buys: [], sells: [], lamportsPaid: 0, lamportsReceived: 0, stablePaid: 0 }
  if (tx.transactionError !== null) return empty

  const transfers = tx.tokenTransfers ?? []
  const netByMint = new Map<string, number>()

  for (const t of transfers) {
    if (t.toUserAccount === walletAddress && t.tokenAmount > 0)
      netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) + t.tokenAmount)
    if (t.fromUserAccount === walletAddress && t.tokenAmount > 0)
      netByMint.set(t.mint, (netByMint.get(t.mint) ?? 0) - t.tokenAmount)
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

  const stablePaid = [...netByMint.entries()]
    .filter(([mint, net]) => (mint === USDC_MINT || mint === USDT_MINT) && net < 0)
    .reduce((s, [, net]) => s + Math.abs(net), 0)

  return { buys, sells, lamportsPaid, lamportsReceived, stablePaid }
}

// ── Traitement d'un achat ─────────────────────────────────────────────────────

async function processBuy(
  supabase:      SupabaseClient,
  tx:            HeliusTx,
  mint:          string,
  walletAddress: string,
  walletLabel:   string,
  lamportsPaid:  number,
  stablePaid:    number,
  maxMcUsd:      number,
): Promise<void> {
  // ── Market cap ──────────────────────────────────────────────────────────
  const mcResult = await getMarketCap(mint)

  console.log(
    `[webhook] BUY ${mint.slice(0, 8)}… wallet=${walletLabel}` +
    ` mcap=${mcResult ? '$' + mcResult.usd.toFixed(0) + ' (' + mcResult.source + ')' : 'null'}` +
    (mcResult && mcResult.usd > maxMcUsd ? ` — > $${maxMcUsd} (stocké, filtré à la lecture)` : '')
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
        market_cap_usd:      mcResult?.usd ?? null,
        mcap_source:         mcResult?.source ?? null,
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
      market_cap_at_buy: mcResult?.usd ?? null,
    })

  if (buyErr) {
    if (buyErr.code === '23505') {
      console.log(`[webhook] buy ${tx.signature.slice(0, 8)}… déjà présent — skip`)
      return
    }
    console.error(`[webhook] buy insert ${tx.signature.slice(0, 8)}…: ${buyErr.message}`)
    return
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
): Promise<void> {
  if (!Array.isArray(payload) || payload.length === 0) {
    console.log(`[webhook] raw ${rawId.slice(0, 8)}: payload vide ou invalide`)
    return
  }

  // ── Charger les wallets surveillés ──────────────────────────────────────
  const { data: wallets, error: walletErr } = await supabase
    .from('kymia_risque_wallets')
    .select('address, label')

  if (walletErr) throw new Error(`wallet select: ${walletErr.message}`)
  if (!wallets?.length) {
    console.warn('[webhook] kymia_risque_wallets vide')
    return
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
  let processed = 0

  for (const tx of txs) {
    if (tx.transactionError !== null) continue

    // Identifier les wallets de notre liste impliqués dans cette tx
    const transfers = tx.tokenTransfers ?? []
    const involved  = new Set<string>()
    for (const t of transfers) {
      if (walletMap.has(t.fromUserAccount)) involved.add(t.fromUserAccount)
      if (walletMap.has(t.toUserAccount))   involved.add(t.toUserAccount)
    }

    if (involved.size === 0) continue

    for (const walletAddress of involved) {
      const walletLabel = walletMap.get(walletAddress)!
      const { buys, sells, lamportsPaid, lamportsReceived, stablePaid } =
        analyzeNetBalances(tx, walletAddress)

      for (const buy of buys) {
        try {
          await processBuy(
            supabase, tx, buy.mint,
            walletAddress, walletLabel,
            lamportsPaid, stablePaid, maxMcUsd,
          )
          processed++
        } catch (e: any) {
          console.error(`[webhook] processBuy ${buy.mint.slice(0, 8)}… ${walletLabel}:`, e.message)
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
          processed++
        } catch (e: any) {
          console.error(`[webhook] processSell ${sell.mint.slice(0, 8)}… ${walletLabel}:`, e.message)
        }
      }
    }
  }

  console.log(`[webhook] raw ${rawId.slice(0, 8)}: ${txs.length} txs → ${processed} événements traités`)
}
