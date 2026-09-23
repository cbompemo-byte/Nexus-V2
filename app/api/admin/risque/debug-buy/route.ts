// app/api/admin/risque/debug-buy/route.ts
// Diagnostic de l'extraction sol_amount sur les achats à montant NULL.
//
// Usage :
//   GET /api/admin/risque/debug-buy?limit=5
//     → inspecte les 5 premiers achats avec sol_amount IS NULL
//   GET /api/admin/risque/debug-buy?tx=<signature>
//     → inspecte un achat précis
//
// Pour chaque achat, affiche :
//   - wallet_address, bought_at, market_cap_at_buy, usdc_amount
//   - nativeBalanceChange du wallet dans le payload brut
//   - tokenBalanceChange WSOL du wallet dans le payload brut
//   - tokenBalanceChange du token acheté (montant reçu)
//   - estimation sol_amount si fix appliqué (native ou WSOL)
//
// Auth : x-admin-key

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

interface TokenBalanceChange {
  mint:           string
  rawTokenAmount: { tokenAmount: string; decimals: number }
}

interface RawAccountData {
  account:             string
  nativeBalanceChange: number
  tokenBalanceChanges: TokenBalanceChange[]
}

interface RawTx {
  signature:    string
  accountData?: RawAccountData[]
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  const txFilter = req.nextUrl.searchParams.get('tx')
  const limit    = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '5', 10), 20)

  // ── 1. Charger les achats avec sol_amount IS NULL ─────────────────────────
  let buysQuery = supabase
    .from('kymia_risque_buys')
    .select('id, tx_signature, wallet_address, wallet_label, bought_at, token_mint, market_cap_at_buy, usdc_amount')
    .is('sol_amount', null)

  if (txFilter) {
    buysQuery = buysQuery.eq('tx_signature', txFilter)
  } else {
    buysQuery = buysQuery.order('bought_at', { ascending: false }).limit(limit)
  }

  const { data: nullBuys, error: buysErr } = await buysQuery
  if (buysErr) return NextResponse.json({ error: buysErr.message }, { status: 500 })

  if (!nullBuys?.length) {
    return NextResponse.json({ ok: true, message: 'Aucun achat avec sol_amount IS NULL', count: 0 })
  }

  // Dédupliquer les tx_signatures à charger
  const sigSet = new Set(nullBuys.map(b => b.tx_signature as string))

  // ── 2. Charger les payloads bruts correspondants ───────────────────────────
  const { data: rawRows } = await supabase
    .from('kymia_risque_webhooks_raw')
    .select('payload')
    .in(
      'id',
      // On cherche via le payload qui contient ces signatures — approche: charger
      // les raw récents et filtrer en mémoire (pas d'index sur signature dans raw)
      // Alternative : charger les 500 derniers raw avec buys_inserted > 0
      (await supabase
        .from('kymia_risque_webhooks_raw')
        .select('id')
        .gt('buys_inserted', 0)
        .order('received_at', { ascending: false })
        .limit(500)
      ).data?.map(r => r.id) ?? []
    )

  // Construire un index signature → accountData
  const txIndex = new Map<string, RawAccountData[]>()
  for (const row of (rawRows ?? [])) {
    const txs = (Array.isArray(row.payload) ? row.payload : []) as RawTx[]
    for (const tx of txs) {
      if (tx.signature && sigSet.has(tx.signature)) {
        txIndex.set(tx.signature, tx.accountData ?? [])
      }
    }
  }

  // ── 3. Analyser chaque achat NULL ─────────────────────────────────────────
  const results = nullBuys.map(buy => {
    const sig           = buy.tx_signature as string
    const walletAddr    = buy.wallet_address as string
    const accountData   = txIndex.get(sig)

    if (!accountData) {
      return {
        tx_signature:     sig.slice(0, 12) + '…',
        wallet_label:     buy.wallet_label,
        token_mint:       (buy.token_mint as string).slice(0, 12) + '…',
        bought_at:        buy.bought_at,
        market_cap_at_buy: buy.market_cap_at_buy,
        usdc_amount:      buy.usdc_amount,
        payload_found:    false,
        diagnosis:        'payload brut introuvable (> 500 derniers webhooks_raw)',
      }
    }

    const ad = accountData.find(a => a.account === walletAddr)

    if (!ad) {
      return {
        tx_signature:     sig.slice(0, 12) + '…',
        wallet_label:     buy.wallet_label,
        token_mint:       (buy.token_mint as string).slice(0, 12) + '…',
        bought_at:        buy.bought_at,
        market_cap_at_buy: buy.market_cap_at_buy,
        usdc_amount:      buy.usdc_amount,
        payload_found:    true,
        wallet_in_accountData: false,
        diagnosis:        'wallet absent de accountData — tx non liée à ce wallet ?',
      }
    }

    // nativeBalanceChange
    const nativeChange = ad.nativeBalanceChange

    // WSOL tokenBalanceChange (en lamports, car 9 décimales)
    const wsolTc = ad.tokenBalanceChanges?.find(tc => tc.mint === WSOL_MINT)
    const wsolRaw  = wsolTc ? parseInt(wsolTc.rawTokenAmount.tokenAmount, 10) : null
    const wsolLamports = wsolRaw !== null ? wsolRaw : null

    // Token acheté (montant reçu)
    const tokenMint = buy.token_mint as string
    const tokenTc   = ad.tokenBalanceChanges?.find(tc => tc.mint === tokenMint)
    const tokenReceivedRaw = tokenTc ? parseInt(tokenTc.rawTokenAmount.tokenAmount, 10) : null
    const tokenReceivedDec = tokenReceivedRaw !== null && tokenTc
      ? tokenReceivedRaw / Math.pow(10, tokenTc.rawTokenAmount.decimals)
      : null

    // Estimation sol_amount
    let estimatedSolAmount: number | null = null
    let estimatedSource: string | null = null

    if (nativeChange < 0) {
      estimatedSolAmount = -nativeChange / 1e9
      estimatedSource    = 'nativeBalanceChange'
    } else if (wsolLamports !== null && wsolLamports < 0) {
      estimatedSolAmount = -wsolLamports / 1e9
      estimatedSource    = 'WSOL_tokenBalanceChange'
    }

    // Estimation USD depuis token reçu × prix
    let estimatedUsdFromToken: number | null = null
    if (tokenReceivedDec !== null && buy.market_cap_at_buy) {
      estimatedUsdFromToken = tokenReceivedDec * (buy.market_cap_at_buy / 1e9)
    }

    let diagnosis: string
    if (estimatedSolAmount !== null) {
      diagnosis = `fix applicable via ${estimatedSource} → sol_amount ≈ ${estimatedSolAmount.toFixed(4)} SOL`
    } else if (buy.usdc_amount) {
      diagnosis = `achat USDC (usdc_amount=${buy.usdc_amount}) — sol_amount légitimement NULL`
    } else if (estimatedUsdFromToken !== null) {
      diagnosis = `aucune donnée SOL — estimation USD depuis token: ~$${estimatedUsdFromToken.toFixed(2)}`
    } else {
      diagnosis = 'aucune source de montant (native=0, wsol absent, usdc absent, token inconnu)'
    }

    return {
      tx_signature:            sig.slice(0, 12) + '…',
      wallet_label:            buy.wallet_label,
      token_mint:              tokenMint.slice(0, 12) + '…',
      bought_at:               buy.bought_at,
      market_cap_at_buy:       buy.market_cap_at_buy,
      usdc_amount:             buy.usdc_amount,
      payload_found:           true,
      wallet_in_accountData:   true,
      nativeBalanceChange:     nativeChange,
      wsol_lamports:           wsolLamports,
      token_received_decimal:  tokenReceivedDec,
      estimated_sol_amount:    estimatedSolAmount,
      estimated_usd_from_token: estimatedUsdFromToken,
      estimated_source:        estimatedSource,
      diagnosis,
    }
  })

  // Résumé
  const withFix      = results.filter(r => (r as any).estimated_sol_amount !== null).length
  const usdcOnly     = results.filter(r => !(r as any).estimated_sol_amount && (r as any).usdc_amount).length
  const noData       = results.filter(r => !(r as any).estimated_sol_amount && !(r as any).usdc_amount).length
  const noPayload    = results.filter(r => !(r as any).payload_found).length

  return NextResponse.json({
    ok:    true,
    count: results.length,
    summary: { fixable: withFix, usdc_only: usdcOnly, no_data: noData, payload_not_found: noPayload },
    results,
  })
}
