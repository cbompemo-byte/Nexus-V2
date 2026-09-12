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
    const { buysInserted, sellsInserted } = await processWebhookEvent(rawId, raw.payload, supabase)
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

    return NextResponse.json({ ok: true, raw_id: rawId, buys_inserted: buysInserted, sells_inserted: sellsInserted })
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

  if (mode === 'batch') {
    const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10), 200)
    return replayBatch(supabase, limit)
  }

  if (rawId) {
    return replaySingle(supabase, rawId)
  }

  return NextResponse.json(
    { error: 'Paramètre requis : raw_id=<uuid> ou mode=batch' },
    { status: 400 },
  )
}
