// app/api/admin/risque/replay/route.ts
// Rejoue le traitement d'un ou plusieurs webhooks Helius.
//
// Mode single (test) :
//   POST /api/admin/risque/replay?raw_id=<uuid>
//   → rejoue UN payload, retourne buys_inserted + sells_inserted
//
// Mode batch :
//   POST /api/admin/risque/replay?mode=batch&limit=50
//   → rejoue tous les payloads WHERE buys_inserted = 0 (pas de filtre sur processed)
//     car les 1678 entrées historiques sont processed=true mais buys_inserted=0 (bug parsing).
//   → idempotent : UNIQUE(tx_signature) sur buys/sells empêche les doublons.
//   → throttle 300ms entre chaque replay pour ménager Helius/DexScreener/RPC.
//
// Header requis : x-admin-key: <KYMIA_ADMIN_KEY>

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { processWebhookEvent }       from '@/lib/risque/webhook'

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

function makeSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars manquants')
  return createClient(url, key, { auth: { persistSession: false } })
}

// ── Mode single ───────────────────────────────────────────────────────────────

async function replaySingle(
  supabase:  ReturnType<typeof makeSupabase>,
  rawId:     string,
): Promise<NextResponse> {
  const { data: raw, error: fetchErr } = await supabase
    .from('kymia_risque_webhooks_raw')
    .select('id, payload, processed, error, buys_inserted, sells_inserted')
    .eq('id', rawId)
    .maybeSingle()

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!raw)     return NextResponse.json({ error: `raw_id ${rawId} introuvable` }, { status: 404 })

  console.log(
    `[replay] single raw_id=${rawId}` +
    ` (processed=${raw.processed} buys=${raw.buys_inserted ?? '?'} sells=${raw.sells_inserted ?? '?'})`
  )

  try {
    const { buysInserted, sellsInserted, buyErrors, tokenErrors } = await processWebhookEvent(rawId, raw.payload, supabase)
    const firstError = tokenErrors[0] ?? buyErrors[0] ?? null
    await supabase
      .from('kymia_risque_webhooks_raw')
      .update({
        processed:      true,
        processed_at:   new Date().toISOString(),
        error:          firstError,
        buys_inserted:  buysInserted,
        sells_inserted: sellsInserted,
      })
      .eq('id', rawId)

    return NextResponse.json({
      ok:             true,
      raw_id:         rawId,
      buys_inserted:  buysInserted,
      sells_inserted: sellsInserted,
      buy_errors:     buyErrors.length   > 0 ? buyErrors   : undefined,
      token_errors:   tokenErrors.length > 0 ? tokenErrors : undefined,
    })
  } catch (e: any) {
    await supabase
      .from('kymia_risque_webhooks_raw')
      .update({ error: e.message })
      .eq('id', rawId)

    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// ── Mode batch ────────────────────────────────────────────────────────────────

async function replayBatch(
  supabase: ReturnType<typeof makeSupabase>,
  limit:    number,
): Promise<NextResponse> {
  // Filtre : buys_inserted = 0 (couvre toutes les entrées historiques du bug parsing,
  // indépendamment de processed). Les entrées sans achats réels resteront à 0 après
  // replay — ce n'est pas un problème (idempotent).
  const { data: rows, error: fetchErr } = await supabase
    .from('kymia_risque_webhooks_raw')
    .select('id, payload')
    .eq('buys_inserted', 0)
    .order('received_at', { ascending: true })
    .limit(limit)

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!rows?.length) {
    return NextResponse.json({ ok: true, replayed: 0, buys_inserted: 0, sells_inserted: 0, errors: [] })
  }

  console.log(`[replay] batch: ${rows.length} entrées à rejouer (limit=${limit})`)

  let totalBuys  = 0
  let totalSells = 0
  const errors: Array<{ raw_id: string; error: string }> = []

  for (const row of rows) {
    const rawId = row.id as string
    try {
      const { buysInserted, sellsInserted } = await processWebhookEvent(rawId, row.payload, supabase)
      await supabase
        .from('kymia_risque_webhooks_raw')
        .update({
          processed:      true,
          processed_at:   new Date().toISOString(),
          error:          null,
          buys_inserted:  buysInserted,
          sells_inserted: sellsInserted,
        })
        .eq('id', rawId)

      totalBuys  += buysInserted
      totalSells += sellsInserted
    } catch (e: any) {
      console.error(`[replay] batch ${rawId.slice(0, 8)}…: ${e.message}`)
      errors.push({ raw_id: rawId, error: e.message })
      await supabase
        .from('kymia_risque_webhooks_raw')
        .update({ error: e.message })
        .eq('id', rawId)
    }

    // Throttle : ménage Helius RPC + DexScreener + RugCheck
    await new Promise(r => setTimeout(r, 300))
  }

  console.log(
    `[replay] batch terminé — replayed=${rows.length}` +
    ` buys=${totalBuys} sells=${totalSells} errors=${errors.length}`
  )

  return NextResponse.json({
    ok:             true,
    replayed:       rows.length,
    buys_inserted:  totalBuys,
    sells_inserted: totalSells,
    errors:         errors.length > 0 ? errors : [],
  })
}

// ── Mode fix-sol-amounts ──────────────────────────────────────────────────────
// Corrige rétroactivement les sol_amount NULL dans kymia_risque_buys.
//
// Cause : l'ancienne version utilisait nativeTransfers.fromUserAccount pour déduire
// le SOL payé, mais pour les swaps pump.fun le SOL transite via le programme
// (fromUserAccount ≠ wallet) → lamportsPaid = 0 → sol_amount = null.
//
// Fix : lire accountData[wallet].nativeBalanceChange depuis le payload brut stocké.
// Fallback WSOL : si nativeBalanceChange = 0, lire tokenBalanceChanges[WSOL_MINT].
// WSOL a 9 décimales (= lamports) — rawTokenAmount.tokenAmount est signé.

const WSOL_MINT_FIX = 'So11111111111111111111111111111111111111112'

async function fixSolAmounts(
  supabase: ReturnType<typeof makeSupabase>,
  limit:    number,
): Promise<NextResponse> {
  // On lit les webhooks_raw où buys_inserted > 0 — ces payloads ont des buys connus.
  const { data: rows, error: fetchErr } = await supabase
    .from('kymia_risque_webhooks_raw')
    .select('id, payload')
    .gt('buys_inserted', 0)
    .order('received_at', { ascending: true })
    .limit(limit)

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!rows?.length) {
    return NextResponse.json({ ok: true, mode: 'fix-sol-amounts', processed: 0, updated: 0 })
  }

  console.log(`[replay] fix-sol-amounts: ${rows.length} payloads à analyser`)

  const { data: wallets } = await supabase.from('kymia_risque_wallets').select('address')
  const walletSet = new Set((wallets ?? []).map(w => w.address as string))

  let totalUpdated   = 0
  let totalNative    = 0   // corrigés via nativeBalanceChange
  let totalWsol      = 0   // corrigés via WSOL tokenBalanceChange
  let totalSkipped   = 0   // nativeBalanceChange = 0 ET pas de WSOL → toujours NULL

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
    signature:   string
    accountData: RawAccountData[]
  }

  for (const row of rows) {
    const txs = (Array.isArray(row.payload) ? row.payload : []) as RawTx[]

    for (const tx of txs) {
      if (!tx.signature) continue

      for (const ad of (tx.accountData ?? [])) {
        if (!walletSet.has(ad.account)) continue

        // ── Primaire : nativeBalanceChange ──────────────────────────────────
        let lamports = ad.nativeBalanceChange

        // ── Fallback : WSOL tokenBalanceChange ──────────────────────────────
        // Achat avec WSOL déjà wrappé → nativeBalanceChange = 0
        // mais tokenBalanceChanges[WSOL_MINT].rawTokenAmount.tokenAmount < 0 (lamports)
        if (lamports === 0) {
          for (const tc of (ad.tokenBalanceChanges ?? [])) {
            if (tc.mint !== WSOL_MINT_FIX) continue
            const raw = parseInt(tc.rawTokenAmount.tokenAmount, 10)
            if (raw < 0) {
              lamports = raw   // déjà en lamports (WSOL, 9 décimales)
              break
            }
          }
        }

        if (lamports >= 0) {
          totalSkipped++
          continue   // pas d'info SOL sur ce wallet pour cette tx
        }

        const solAmount = -lamports / 1_000_000_000
        const isWsol    = ad.nativeBalanceChange === 0

        const { data: updatedRows } = await supabase
          .from('kymia_risque_buys')
          .update({ sol_amount: solAmount })
          .eq('tx_signature',   tx.signature)
          .eq('wallet_address', ad.account)
          .is('sol_amount', null)
          .select('id')

        const n = updatedRows?.length ?? 0
        totalUpdated += n
        if (n > 0) {
          if (isWsol) totalWsol++ ; else totalNative++
        }
      }
    }
  }

  console.log(
    `[replay] fix-sol-amounts terminé — payloads=${rows.length}` +
    ` updated=${totalUpdated} (native=${totalNative} wsol=${totalWsol})` +
    ` skipped_no_data=${totalSkipped}`
  )

  return NextResponse.json({
    ok:              true,
    mode:            'fix-sol-amounts',
    payloads:        rows.length,
    updated:         totalUpdated,
    updated_native:  totalNative,
    updated_wsol:    totalWsol,
    skipped_no_data: totalSkipped,
  })
}

// ── Mode fix-tokens ───────────────────────────────────────────────────────────
// Reprocesse les entrées où le buy a été inséré (buys_inserted > 0) mais où
// le token est possiblement absent (replays d'avant le fix graceful-degradation).
// Le buy insert retournera 23505 (idempotent) ; seul l'upsert token est effectif.

async function replayFixTokens(
  supabase: ReturnType<typeof makeSupabase>,
  limit:    number,
): Promise<NextResponse> {
  const { data: rows, error: fetchErr } = await supabase
    .from('kymia_risque_webhooks_raw')
    .select('id, payload')
    .gt('buys_inserted', 0)
    .order('received_at', { ascending: true })
    .limit(limit)

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!rows?.length) {
    return NextResponse.json({ ok: true, mode: 'fix-tokens', replayed: 0, token_errors: [] })
  }

  console.log(`[replay] fix-tokens: ${rows.length} entrées à retraiter (limit=${limit})`)

  let tokenFixed = 0
  const tokenErrors: string[] = []

  for (const row of rows) {
    const rawId = row.id as string
    try {
      const result = await processWebhookEvent(rawId, row.payload, supabase)
      tokenFixed++
      if (result.tokenErrors.length > 0) {
        tokenErrors.push(...result.tokenErrors)
      }
    } catch (e: any) {
      console.error(`[replay] fix-tokens ${rawId.slice(0, 8)}…: ${e.message}`)
      tokenErrors.push(`${rawId.slice(0, 8)}: ${e.message}`)
    }

    await new Promise(r => setTimeout(r, 300))
  }

  console.log(`[replay] fix-tokens terminé — replayed=${rows.length} token_errors=${tokenErrors.length}`)

  return NextResponse.json({
    ok:           true,
    mode:         'fix-tokens',
    replayed:     rows.length,
    token_errors: tokenErrors.length > 0 ? tokenErrors : undefined,
  })
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let supabase: ReturnType<typeof makeSupabase>
  try {
    supabase = makeSupabase()
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }

  const mode  = req.nextUrl.searchParams.get('mode')
  const rawId = req.nextUrl.searchParams.get('raw_id')
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10), 200)

  if (mode === 'batch')            return replayBatch(supabase, limit)
  if (mode === 'fix-tokens')       return replayFixTokens(supabase, limit)
  if (mode === 'fix-sol-amounts')  return fixSolAmounts(supabase, limit)
  if (rawId)                       return replaySingle(supabase, rawId)

  return NextResponse.json(
    { error: 'Paramètre requis : raw_id=<uuid>, mode=batch, mode=fix-tokens, ou mode=fix-sol-amounts' },
    { status: 400 },
  )
}
