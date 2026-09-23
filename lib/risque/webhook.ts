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

  // ── SOL : primaire accountData.nativeBalanceChange, fallback nativeTransfers ──
  // Pour un achat pump.fun, le SOL transite par le programme (pas wallet→pool direct).
  // nativeTransfers.fromUserAccount peut manquer selon le routing. Le nativeBalanceChange
  // du wallet dans accountData est la valeur nette fiable : négatif = payé, positif = reçu.
  let lamportsPaid     = 0
  let lamportsReceived = 0

  for (const ad of (tx.accountData ?? [])) {
    if (ad.account !== walletAddress) continue
    const change = ad.nativeBalanceChange
    if (change < 0) lamportsPaid     = -change
    if (change > 0) lamportsReceived =  change
  }

  // Fallback 1 : nativeTransfers (payloads anciens sans accountData)
  if (lamportsPaid === 0 && lamportsReceived === 0) {
    const native = tx.nativeTransfers ?? []
    lamportsPaid     = native.filter(t => t.fromUserAccount === walletAddress).reduce((s, t) => s + t.amount, 0)
    lamportsReceived = native.filter(t => t.toUserAccount   === walletAddress).reduce((s, t) => s + t.amount, 0)
  }

  // Fallback 2 : WSOL tokenBalanceChange — paiement via wrapped SOL.
  // Quand l'achat est fait avec du WSOL (déjà wrappé), nativeBalanceChange = 0
  // mais le wallet perd du WSOL (SPL token). netByMint[WSOL_MINT] est négatif.
  // WSOL a 9 décimales (même unité que SOL), donc × 1e9 = lamports.
  if (lamportsPaid === 0) {
    const wsolNet = netByMint.get(WSOL_MINT) ?? 0
    if (wsolNet < 0) lamportsPaid = Math.round(Math.abs(wsolNet) * LAMPORTS_PER_SOL)
  }
  if (lamportsReceived === 0) {
    const wsolNet = netByMint.get(WSOL_MINT) ?? 0
    if (wsolNet > 0) lamportsReceived = Math.round(wsolNet * LAMPORTS_PER_SOL)
  }

  // stablePaid : déjà en unités décimales dans les deux chemins
  const stablePaid = [...netByMint.entries()]
    .filter(([mint, net]) => (mint === USDC_MINT || mint === USDT_MINT) && net < 0)
    .reduce((s, [, net]) => s + Math.abs(net), 0)

  return { buys, sells, lamportsPaid, lamportsReceived, stablePaid }
}

// ── Traitement d'un achat ─────────────────────────────────────────────────────

// processBuy retourne les données de marché + résultat des inserts.
// inserted=true uniquement si l'INSERT buy a réussi.
// lastError/tokenError : messages Supabase bruts pour diagnostic.
interface BuyMarketData {
  priceUsd:     number | null
  marketCapUsd: number | null
  marketCapSol: number | null  // disponible si source=onchain_sol_only
  inserted:     boolean
  lastError:    string | null  // erreur buy insert
  tokenError:   string | null  // erreur token upsert
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

  // ── Enrichissement 1 : prix + market cap ─────────────────────────────────
  // Dégradation gracieuse : exception isolée, token créé avec market_cap_usd=null
  let marketData: import('@/lib/risque/pumpfun').TokenMarketData | null = null
  try {
    marketData = await getTokenMarketData(mint)
  } catch (e: any) {
    console.warn(`[webhook] getTokenMarketData ${mint.slice(0, 8)}…: ${e.message}`)
  }

  console.log(
    `[webhook] BUY ${mint.slice(0, 8)}… wallet=${walletLabel}` +
    ` price=${marketData?.priceUsd != null ? '$' + marketData.priceUsd.toFixed(8) : 'null'}` +
    ` mcap=${marketData?.marketCapUsd != null
        ? '$' + marketData.marketCapUsd.toFixed(0) + ' (' + marketData.source + ')'
        : marketData?.source === 'onchain_sol_only'
          ? `${marketData.marketCapSol?.toFixed(2)} SOL (onchain_sol_only)`
          : 'null'}` +
    (marketData?.marketCapUsd != null && marketData.marketCapUsd > maxMcUsd ? ` — > $${maxMcUsd} (stocké, filtré à la lecture)` : '')
  )

  // ── Vérification token existant — évite les appels DAS+RugCheck inutiles ──
  // Si le token a déjà un symbol ET un risque_score valide en base, on saute
  // les enrichissements coûteux (1 crédit DAS + ~3 crédits RugCheck par appel).
  const { data: existingToken } = await supabase
    .from('kymia_risque_tokens')
    .select('symbol, name, risque_score')
    .eq('mint', mint)
    .maybeSingle()

  const needsDas = !existingToken?.symbol
  const needsRugCheck = !existingToken?.risque_score
                     || existingToken.risque_score === 'DATA_UNAVAILABLE'

  if (!needsDas && !needsRugCheck) {
    console.log(`[webhook] ${mint.slice(0, 8)}… déjà enrichi (symbol+score) — DAS+Rug skippés`)
  }

  // ── Enrichissement 2 : rug check ──────────────────────────────────────────
  // Dégradation gracieuse : exception isolée, token créé avec risque_score='DATA_UNAVAILABLE'
  let rugResult: import('@/lib/risque/rug').RugResult = {
    score: existingToken?.risque_score ?? 'DATA_UNAVAILABLE',
    reason: null,
    flags: {
      mint_auth_revoked: null, freeze_auth_revoked: null,
      dev_pct: null, top10_pct: null,
      dev_sold: null, bundled: null,
      danger_risks: [], warn_risks: [],
    },
  }
  if (needsRugCheck) {
    try {
      const rug = await fetchRugCheck(mint)
      rugResult = await checkRug(mint, rug)
    } catch (e: any) {
      console.warn(`[webhook] checkRug ${mint.slice(0, 8)}…: ${e.message}`)
    }
  }

  // ── Enrichissement 3 : métadonnées Helius DAS (symbol / name) ────────────
  let tokenSymbol: string | null = existingToken?.symbol ?? null
  let tokenName:   string | null = existingToken?.name   ?? null
  if (needsDas) {
    const heliusKey = process.env.NEXT_PUBLIC_HELIEUS_KEY
    if (heliusKey) {
      try {
        const dasRes = await fetch(
          `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'KYMIA/1.0' },
            body:    JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'getAsset', params: { id: mint } }),
            signal:  AbortSignal.timeout(5_000),
          },
        )
        if (dasRes.ok) {
          const dasData = await dasRes.json()
          const r = dasData?.result
          // Fungible SPL tokens: token_info.symbol est la source primaire (on-chain),
          // content.metadata.symbol est l'off-chain JSON (parfois absent pour les tokens récents)
          tokenSymbol = r?.token_info?.symbol
                     ?? r?.content?.metadata?.symbol
                     ?? null
          tokenName   = r?.content?.metadata?.name
                     ?? r?.token_info?.name
                     ?? null
          if (!tokenSymbol && !tokenName) {
            console.warn(`[webhook] DAS ${mint.slice(0, 8)}…: symbol/name absents (interface=${r?.interface})`)
          }
        } else {
          console.warn(`[webhook] DAS getAsset ${mint.slice(0, 8)}…: HTTP ${dasRes.status}`)
        }
      } catch (e: any) {
        console.warn(`[webhook] DAS getAsset ${mint.slice(0, 8)}…: ${e.message}`)
      }
    }
  }

  // ── Upsert token — TOUJOURS, enrichissements null ou non ─────────────────
  // Le token (fait que le wallet a acheté ce mint) est la donnée primaire.
  // market_cap et risque_score sont des enrichissements — leur échec ne
  // doit jamais empêcher l'enregistrement du token.
  // On ne surécrit PAS les données existantes avec null si on a skippé l'enrichissement.
  const upsertBase = {
    mint,
    market_cap_usd: marketData?.marketCapUsd ?? null,
    market_cap_sol: marketData?.marketCapSol ?? null,
    mcap_source:    marketData?.source ?? 'UNAVAILABLE',
    updated_at:     new Date().toISOString(),
  }
  const upsertEnrichment = {
    ...(needsDas ? { symbol: tokenSymbol, name: tokenName } : {}),
    ...(needsRugCheck ? {
      risque_score:        rugResult.score,
      score_reason:        rugResult.reason,
      rug_flags:           rugResult.flags,
      dev_pct:             rugResult.flags.dev_pct,
      top10_pct:           rugResult.flags.top10_pct,
      dev_sold:            rugResult.flags.dev_sold,
      bundled:             rugResult.flags.bundled,
      mint_auth_revoked:   rugResult.flags.mint_auth_revoked,
      freeze_auth_revoked: rugResult.flags.freeze_auth_revoked,
    } : {}),
  }
  const { error: tokenErr } = await supabase
    .from('kymia_risque_tokens')
    .upsert(
      { ...upsertBase, ...upsertEnrichment },
      { onConflict: 'mint' },
    )

  const tokenError = tokenErr
    ? `token upsert: ${tokenErr.message} (code=${tokenErr.code ?? 'none'}) hint=${tokenErr.hint ?? ''} detail=${tokenErr.details ?? ''}`
    : null
  if (tokenError) {
    console.error(`[webhook] ${mint.slice(0, 8)}… ${tokenError}`)
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
      return { priceUsd: marketData?.priceUsd ?? null, marketCapUsd: marketData?.marketCapUsd ?? null, marketCapSol: marketData?.marketCapSol ?? null, inserted: false, lastError: null, tokenError }
    }
    const errDetail = `buy insert: ${buyErr.message} (code=${buyErr.code ?? 'none'}) hint=${buyErr.hint ?? ''} detail=${buyErr.details ?? ''}`
    console.error(`[webhook] ${tx.signature.slice(0, 8)}… ${errDetail}`)
    return { priceUsd: null, marketCapUsd: null, marketCapSol: null, inserted: false, lastError: errDetail, tokenError }
  }

  // ── Mise à jour buyer_count ───────────────────────────────────────────────
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

  return { priceUsd: marketData?.priceUsd ?? null, marketCapUsd: marketData?.marketCapUsd ?? null, marketCapSol: marketData?.marketCapSol ?? null, inserted: true, lastError: null, tokenError }
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
): Promise<{ buysInserted: number; sellsInserted: number; buyErrors: string[]; tokenErrors: string[] }> {
  if (!Array.isArray(payload) || payload.length === 0) {
    console.log(`[webhook] raw ${rawId.slice(0, 8)}: payload vide ou invalide`)
    return { buysInserted: 0, sellsInserted: 0, buyErrors: [], tokenErrors: [] }
  }

  // ── Charger les wallets surveillés ──────────────────────────────────────
  const { data: wallets, error: walletErr } = await supabase
    .from('kymia_risque_wallets')
    .select('address, label')

  if (walletErr) throw new Error(`wallet select: ${walletErr.message}`)
  if (!wallets?.length) {
    console.warn('[webhook] kymia_risque_wallets vide')
    return { buysInserted: 0, sellsInserted: 0, buyErrors: [], tokenErrors: [] }
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
  const buyErrors:   string[] = []
  const tokenErrors: string[] = []

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
          { priceUsd: null, marketCapUsd: null, marketCapSol: null, inserted: false, lastError: null, tokenError: null }
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
          if (marketResult.tokenError) {
            tokenErrors.push(marketResult.tokenError)
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
  if (tokenErrors.length > 0) {
    console.error(`[webhook] token errors raw ${rawId.slice(0, 8)}:`, tokenErrors)
  }

  return { buysInserted, sellsInserted, buyErrors, tokenErrors }
}
