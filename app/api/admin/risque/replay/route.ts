// app/api/admin/risque/replay/route.ts
// Rejoue le traitement d'un webhook Helius qui a échoué après le 200.
//
// Usage :
//   POST /api/admin/risque/replay?raw_id=<uuid>
//   Header : x-admin-key: <KYMIA_ADMIN_KEY>
//
// Lister les échecs à rejouer :
//   SELECT id, received_at, error
//   FROM kymia_risque_webhooks_raw
//   WHERE processed = false
//   ORDER BY received_at DESC;

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { processWebhookEvent }       from '@/lib/risque/webhook'

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rawId = req.nextUrl.searchParams.get('raw_id')
  if (!rawId) {
    return NextResponse.json({ error: 'raw_id manquant' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  // Récupérer le payload brut
  const { data: raw, error: fetchErr } = await supabase
    .from('kymia_risque_webhooks_raw')
    .select('id, payload, processed, error')
    .eq('id', rawId)
    .maybeSingle()

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  }
  if (!raw) {
    return NextResponse.json({ error: `raw_id ${rawId} introuvable` }, { status: 404 })
  }

  console.log(
    `[replay] replaying raw_id=${rawId}` +
    ` (was processed=${raw.processed}, error=${raw.error ?? 'none'})`
  )

  try {
    await processWebhookEvent(rawId, raw.payload, supabase)
    await supabase
      .from('kymia_risque_webhooks_raw')
      .update({ processed: true, processed_at: new Date().toISOString(), error: null })
      .eq('id', rawId)

    return NextResponse.json({ ok: true, raw_id: rawId })
  } catch (e: any) {
    await supabase
      .from('kymia_risque_webhooks_raw')
      .update({ error: e.message })
      .eq('id', rawId)

    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
