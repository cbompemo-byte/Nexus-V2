// app/api/admin/risque/debug-buy/route.ts
// Diagnostic + rattrapage des montants NULL sur kymia_risque_buys.
//
// ── Modes ──────────────────────────────────────────────────────────────────────
//
//   GET ?tx=<sig>                    — inspecte un achat précis (sol_amount NULL)
//   GET ?limit=5                     — 5 derniers achats avec sol_amount IS NULL
//
//   GET ?action=inspect&tx=<sig>     — dump COMPLET du payload brut Helius pour
//                                      cette tx (nativeTransfers, tokenTransfers,
//                                      accountData de TOUS les comptes impliqués)
//
//   GET ?action=backfill&limit=N     — rattrapage : recalcule usdc_amount pour les
//                                      achats avec sol_amount IS NULL AND usdc_amount
//                                      IS NULL AND market_cap_at_buy IS NOT NULL,
//                                      via tokens_reçus × (mcap / 1 000 000 000).
//   GET ?action=backfill&limit=N&dry_run=true  — simule sans écrire
//
// Auth : x-admin-key

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'

const WSOL_MINT    = 'So11111111111111111111111111111111111111112'
const PUMP_SUPPLY  = 1_000_000_000

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

// Extrait les tokens reçus par `walletAddress` pour `tokenMint`
// depuis le tableau accountData d'une tx Helius Enhanced.
// Cherche dans TOUS les accountData (pas seulement celui du wallet) via userAccount.
function extractTokensReceived(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  accountData: any[],
  walletAddress: string,
  tokenMint: string,
): number {
  let total = 0
  for (const ad of (accountData ?? [])) {
    for (const tc of (ad.tokenBalanceChanges ?? [])) {
      if (tc.userAccount !== walletAddress) continue
      if (tc.mint !== tokenMint) continue
      const raw = parseInt(tc.rawTokenAmount?.tokenAmount ?? '0', 10)
      const dec = raw / Math.pow(10, tc.rawTokenAmount?.decimals ?? 6)
      total += dec
    }
  }
  return total
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  const sp      = req.nextUrl.searchParams
  const action  = sp.get('action') ?? 'diagnose'
  const txSig   = sp.get('tx')
  const limit   = Math.min(parseInt(sp.get('limit') ?? '5', 10), 50)
  const dryRun  = sp.get('dry_run') === 'true'

  // ────────────────────────────────────────────────────────────────────────────
  // MODE : inspect — dump complet du payload brut pour une tx donnée
  // ────────────────────────────────────────────────────────────────────────────
  if (action === 'inspect') {
    if (!txSig) return NextResponse.json({ error: '?tx=<signature> requis pour action=inspect' }, { status: 400 })

    // Chercher dans les 1000 derniers webhooks_raw
    const { data: rawRows } = await supabase
      .from('kymia_risque_webhooks_raw')
      .select('id, received_at, payload')
      .order('received_at', { ascending: false })
      .limit(1000)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let found: any = null
    let rawId: string | null = null
    for (const row of (rawRows ?? [])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txs = (Array.isArray(row.payload) ? row.payload : []) as any[]
      for (const tx of txs) {
        if (tx.signature === txSig) {
          found = tx
          rawId = row.id as string
          break
        }
      }
      if (found) break
    }

    if (!found) {
      return NextResponse.json({
        ok: false,
        message: `Tx ${txSig.slice(0, 16)}… introuvable dans les 1000 derniers webhooks_raw`,
      })
    }

    // Résumé structuré pour lisibilité
    const summary = {
      signature:       found.signature,
      timestamp:       new Date((found.timestamp ?? 0) * 1000).toISOString(),
      type:            found.type,
      transactionError: found.transactionError,
      raw_id:          rawId,
      // ── nativeTransfers ───────────────────────────────────────────────────
      nativeTransfers: (found.nativeTransfers ?? []).map((t: any) => ({
        from:   t.fromUserAccount?.slice(0, 12) + '…',
        to:     t.toUserAccount?.slice(0, 12) + '…',
        sol:    (t.amount / 1e9).toFixed(6),
        lamports: t.amount,
      })),
      // ── tokenTransfers ────────────────────────────────────────────────────
      tokenTransfers: (found.tokenTransfers ?? []).map((t: any) => ({
        mint:   t.mint?.slice(0, 12) + '…',
        from:   t.fromUserAccount?.slice(0, 12) + '…',
        to:     t.toUserAccount?.slice(0, 12) + '…',
        amount: t.tokenAmount,
      })),
      // ── accountData — TOUS les comptes ────────────────────────────────────
      accountData: (found.accountData ?? []).map((ad: any) => ({
        account:             ad.account?.slice(0, 16) + '…',
        nativeBalanceChange: ad.nativeBalanceChange,
        nativeBalanceSol:    (ad.nativeBalanceChange / 1e9).toFixed(6),
        tokenBalanceChanges: (ad.tokenBalanceChanges ?? []).map((tc: any) => ({
          userAccount: tc.userAccount?.slice(0, 12) + '…',
          mint:        tc.mint === WSOL_MINT ? 'WSOL' : tc.mint?.slice(0, 12) + '…',
          amount:      tc.rawTokenAmount?.tokenAmount,
          decimals:    tc.rawTokenAmount?.decimals,
        })),
      })),
    }

    return NextResponse.json({ ok: true, raw_id: rawId, tx: summary })
  }

  // ────────────────────────────────────────────────────────────────────────────
  // MODE : backfill — recalcule usdc_amount via tokens × (mcap / 1B)
  // ────────────────────────────────────────────────────────────────────────────
  if (action === 'backfill') {
    // 1. Trouver les achats sans montant mais avec mcap
    const { data: nullBuys, error: nbErr } = await supabase
      .from('kymia_risque_buys')
      .select('id, tx_signature, wallet_address, token_mint, market_cap_at_buy, bought_at, wallet_label')
      .is('sol_amount',  null)
      .is('usdc_amount', null)
      .not('market_cap_at_buy', 'is', null)
      .order('bought_at', { ascending: false })
      .limit(limit)

    if (nbErr) return NextResponse.json({ error: nbErr.message }, { status: 500 })
    if (!nullBuys?.length) {
      return NextResponse.json({ ok: true, message: 'Aucun achat à recalculer', updated: 0 })
    }

    // 2. Charger les payloads bruts pour ces signatures
    const sigSet = new Set(nullBuys.map(b => b.tx_signature as string))
    const { data: rawRows } = await supabase
      .from('kymia_risque_webhooks_raw')
      .select('payload')
      .order('received_at', { ascending: false })
      .limit(2000)

    // Index sig → accountData
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txIndex = new Map<string, any[]>()
    for (const row of (rawRows ?? [])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txs = (Array.isArray(row.payload) ? row.payload : []) as any[]
      for (const tx of txs) {
        if (tx.signature && sigSet.has(tx.signature) && !txIndex.has(tx.signature)) {
          txIndex.set(tx.signature, tx.accountData ?? [])
        }
      }
    }

    const results = []
    let updated = 0

    for (const buy of nullBuys) {
      const sig          = buy.tx_signature as string
      const walletAddr   = buy.wallet_address as string
      const tokenMint    = buy.token_mint as string
      const mcap         = buy.market_cap_at_buy as number
      const accountData  = txIndex.get(sig)

      if (!accountData) {
        results.push({ sig: sig.slice(0, 12), status: 'payload_not_found' })
        continue
      }

      const tokensReceived = extractTokensReceived(accountData, walletAddr, tokenMint)
      if (tokensReceived <= 0) {
        results.push({ sig: sig.slice(0, 12), status: 'tokens_not_found_in_payload' })
        continue
      }

      const estimatedUsd = parseFloat((tokensReceived * (mcap / PUMP_SUPPLY)).toFixed(4))

      if (dryRun) {
        results.push({
          sig:          sig.slice(0, 12),
          wallet_label: buy.wallet_label,
          bought_at:    buy.bought_at,
          status:       'would_update',
          tokens:       tokensReceived.toFixed(0),
          mcap:         Math.round(mcap),
          estimated_usd: estimatedUsd,
        })
      } else {
        const { error: uErr } = await supabase
          .from('kymia_risque_buys')
          .update({ usdc_amount: estimatedUsd })
          .eq('id', buy.id as string)
          .is('usdc_amount', null)  // guard idempotent

        if (uErr) {
          results.push({ sig: sig.slice(0, 12), status: 'update_error', error: uErr.message })
        } else {
          results.push({
            sig:           sig.slice(0, 12),
            wallet_label:  buy.wallet_label,
            bought_at:     buy.bought_at,
            status:        'updated',
            tokens:        tokensReceived.toFixed(0),
            mcap:          Math.round(mcap),
            estimated_usd: estimatedUsd,
          })
          updated++
        }
      }
    }

    return NextResponse.json({
      ok:       true,
      dry_run:  dryRun,
      total:    nullBuys.length,
      updated:  dryRun ? '(dry run)' : updated,
      payload_coverage: `${txIndex.size}/${sigSet.size} signatures trouvées dans les 2000 derniers webhooks_raw`,
      results,
    })
  }

  // ────────────────────────────────────────────────────────────────────────────
  // MODE : diagnose (défaut) — analyse des achats sol_amount IS NULL
  // ────────────────────────────────────────────────────────────────────────────
  type RawAccountData = {
    account:             string
    nativeBalanceChange: number
    tokenBalanceChanges: Array<{
      mint:           string
      userAccount?:   string
      rawTokenAmount: { tokenAmount: string; decimals: number }
    }>
  }
  type RawTx = { signature: string; accountData?: RawAccountData[]; nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }> }

  let buysQuery = supabase
    .from('kymia_risque_buys')
    .select('id, tx_signature, wallet_address, wallet_label, bought_at, token_mint, market_cap_at_buy, usdc_amount')
    .is('sol_amount', null)

  if (txSig) {
    buysQuery = buysQuery.eq('tx_signature', txSig)
  } else {
    buysQuery = buysQuery.order('bought_at', { ascending: false }).limit(limit)
  }

  const { data: nullBuys, error: buysErr } = await buysQuery
  if (buysErr) return NextResponse.json({ error: buysErr.message }, { status: 500 })

  if (!nullBuys?.length) {
    return NextResponse.json({ ok: true, message: 'Aucun achat avec sol_amount IS NULL', count: 0 })
  }

  const sigSet = new Set(nullBuys.map(b => b.tx_signature as string))

  const { data: rawRows } = await supabase
    .from('kymia_risque_webhooks_raw')
    .select('payload')
    .in(
      'id',
      (await supabase
        .from('kymia_risque_webhooks_raw')
        .select('id')
        .gt('buys_inserted', 0)
        .order('received_at', { ascending: false })
        .limit(500)
      ).data?.map(r => r.id) ?? []
    )

  const txIndex = new Map<string, { accountData: RawAccountData[]; nativeTransfers: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }> }>()
  for (const row of (rawRows ?? [])) {
    const txs = (Array.isArray(row.payload) ? row.payload : []) as RawTx[]
    for (const tx of txs) {
      if (tx.signature && sigSet.has(tx.signature)) {
        txIndex.set(tx.signature, {
          accountData:     tx.accountData     ?? [],
          nativeTransfers: tx.nativeTransfers ?? [],
        })
      }
    }
  }

  const results = nullBuys.map(buy => {
    const sig        = buy.tx_signature as string
    const walletAddr = buy.wallet_address as string
    const tokenMint  = buy.token_mint as string
    const raw        = txIndex.get(sig)

    if (!raw) {
      return { tx_signature: sig.slice(0, 12) + '…', wallet_label: buy.wallet_label, payload_found: false,
               diagnosis: 'payload brut introuvable (> 500 derniers webhooks_raw)' }
    }

    // Wallet's own accountData entry
    const ad = raw.accountData.find(a => a.account === walletAddr)
    const nativeChange = ad?.nativeBalanceChange ?? 'absent'

    // WSOL via userAccount (iterate ALL accounts)
    let wsolDelta = 0
    for (const a of raw.accountData) {
      for (const tc of (a.tokenBalanceChanges ?? [])) {
        if (tc.mint !== WSOL_MINT) continue
        const owner = (tc as any).userAccount
        if (owner && owner !== walletAddr) continue
        if (!owner && a.account !== walletAddr) continue
        wsolDelta += parseInt(tc.rawTokenAmount.tokenAmount, 10) / 1e9
      }
    }

    // nativeTransfers
    const outgoing = raw.nativeTransfers.filter(t => t.fromUserAccount === walletAddr).reduce((s, t) => s + t.amount, 0)
    const incoming = raw.nativeTransfers.filter(t => t.toUserAccount   === walletAddr).reduce((s, t) => s + t.amount, 0)
    const nativeTransfersNetSol = (outgoing - incoming) / 1e9

    // Tokens received
    const tokensReceived = extractTokensReceived(raw.accountData, walletAddr, tokenMint)

    // Estimation USD mcap
    let estimatedUsdMcap: number | null = null
    if (tokensReceived > 0 && buy.market_cap_at_buy) {
      estimatedUsdMcap = parseFloat((tokensReceived * (buy.market_cap_at_buy / PUMP_SUPPLY)).toFixed(4))
    }

    let diagnosis: string
    const nativeChangeSol = typeof nativeChange === 'number' ? nativeChange / 1e9 : null

    if (buy.usdc_amount !== null) {
      diagnosis = `achat USDC (usdc_amount=${buy.usdc_amount}) — sol_amount légitimement NULL`
    } else if (nativeChangeSol !== null && nativeChangeSol < 0) {
      diagnosis = `nativeBalanceChange négatif (${nativeChangeSol.toFixed(4)} SOL) → fix primary devrait marcher — bug ?`
    } else if (nativeChangeSol !== null && nativeChangeSol > 0) {
      diagnosis = `nativeBalanceChange POSITIF (+${nativeChangeSol.toFixed(6)} SOL) = rent reçu → ancien bug fallback1 court-circuité. Fix appliqué.`
        + (outgoing > 0 ? ` nativeTransfers outgoing: ${(outgoing/1e9).toFixed(4)} SOL` : '')
    } else if (wsolDelta < 0) {
      diagnosis = `WSOL net = ${wsolDelta.toFixed(4)} → fallback2 devrait marcher — bug ?`
    } else if (outgoing > 0) {
      diagnosis = `nativeTransfers sortants = ${(outgoing/1e9).toFixed(4)} SOL (net ${nativeTransfersNetSol.toFixed(4)}) → couvert par fix fallback1`
    } else if (estimatedUsdMcap !== null) {
      diagnosis = `aucune source SOL — fallback mcap: $${estimatedUsdMcap} estimé`
    } else {
      diagnosis = 'aucune source de montant (native=0, wsol=0, nativeTransfers=0, mcap absent)'
    }

    return {
      tx_signature:          sig.slice(0, 16) + '…',
      wallet_label:          buy.wallet_label,
      token_mint:            tokenMint.slice(0, 12) + '…',
      bought_at:             buy.bought_at,
      market_cap_at_buy:     buy.market_cap_at_buy,
      usdc_amount:           buy.usdc_amount,
      payload_found:         true,
      nativeBalanceChange_sol: nativeChangeSol,
      wsol_delta_sol:        wsolDelta,
      native_transfers:      { outgoing_sol: outgoing/1e9, incoming_sol: incoming/1e9, net_sol: nativeTransfersNetSol },
      tokens_received:       tokensReceived > 0 ? tokensReceived.toFixed(0) : null,
      estimated_usd_mcap:    estimatedUsdMcap,
      diagnosis,
    }
  })

  const usdcOnly  = results.filter(r => (r as any).usdc_amount !== null).length
  const noPayload = results.filter(r => !(r as any).payload_found).length
  const positiveNative = results.filter(r => (r as any).nativeBalanceChange_sol !== null && (r as any).nativeBalanceChange_sol > 0).length

  return NextResponse.json({
    ok:      true,
    count:   results.length,
    summary: {
      usdc_only:       usdcOnly,
      positive_native: positiveNative,
      no_payload:      noPayload,
      note:            `positive_native = bug fallback1 court-circuité (maintenant fixé dans analyzeNetBalances)`,
    },
    actions_disponibles: [
      `?action=inspect&tx=<sig>  — dump complet du payload Helius`,
      `?action=backfill&limit=N  — recalcule usdc_amount via mcap`,
      `?action=backfill&limit=N&dry_run=true  — simulation`,
    ],
    results,
  })
}
