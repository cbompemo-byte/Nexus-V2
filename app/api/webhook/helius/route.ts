// app/api/webhook/helius/route.ts
// Réception des webhooks Helius Enhanced Transaction (type SWAP).
//
// Flux garanti contre la perte d'événements :
//   1. Valide le header Authorization (HELIUS_WEBHOOK_SECRET)
//   2. Insère le payload brut dans kymia_risque_webhooks_raw  ← AVANT le 200
//   3. Retourne 200 à Helius (< 100ms — Helius timeout = 5s)
//   4. after() → processWebhookEvent() — traitement asynchrone
//      ✓ succès : processed=true, processed_at=now()
//      ✗ échec  : error=message (payload toujours en base, rejouable)
//
// Si after() plante, Helius n'est PAS notifié et ne retentera PAS.
// Le payload reste dans kymia_risque_webhooks_raw avec processed=false.
// Rejeu manuel : POST /api/admin/risque/replay?raw_id=<uuid>

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { after }                     from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { processWebhookEvent }       from '@/lib/risque/webhook'

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.HELIUS_WEBHOOK_SECRET
  // Helius envoie le secret configuré dans le champ "authHeader" du webhook
  // comme valeur brute du header Authorization (sans "Bearer").
  return !!secret && req.headers.get('authorization') === secret
}

function makeSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars manquants')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST(req: NextRequest) {
  // ── 1. Auth ─────────────────────────────────────────────────────────────
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── 2. Parse JSON ────────────────────────────────────────────────────────
  let payload: unknown
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  // ── 3. Insert raw — avant tout traitement, avant le 200 ─────────────────
  let supabase: ReturnType<typeof makeSupabase>
  try {
    supabase = makeSupabase()
  } catch (e: any) {
    console.error('[webhook/helius] Supabase init:', e.message)
    return NextResponse.json({ error: 'server error' }, { status: 500 })
  }

  const { data: raw, error: rawErr } = await supabase
    .from('kymia_risque_webhooks_raw')
    .insert({ payload })
    .select('id')
    .single()

  if (rawErr || !raw) {
    // Si l'insert brut échoue, on refuse le 200 — Helius retentera
    console.error('[webhook/helius] raw insert failed:', rawErr?.message)
    return NextResponse.json({ error: 'raw insert failed' }, { status: 500 })
  }

  const rawId = raw.id as string

  // ── 4. Réponse immédiate → Helius est satisfait ──────────────────────────
  // after() s'exécute après l'envoi de la réponse, dans la même instance Vercel.
  after(async () => {
    try {
      const { buysInserted, sellsInserted } = await processWebhookEvent(rawId, payload, supabase)
      await supabase
        .from('kymia_risque_webhooks_raw')
        .update({
          processed:      true,
          processed_at:   new Date().toISOString(),
          buys_inserted:  buysInserted,
          sells_inserted: sellsInserted,
        })
        .eq('id', rawId)
    } catch (e: any) {
      // Payload toujours en base avec processed=false — rejouable via /api/admin/risque/replay
      console.error(`[webhook/helius] after() failed (raw_id=${rawId}):`, e.message)
      const { error: updateErr } = await supabase
        .from('kymia_risque_webhooks_raw')
        .update({ error: e.message })
        .eq('id', rawId)
      if (updateErr) {
        console.error('[webhook/helius] error update failed:', updateErr.message)
      }
    }
  })

  return NextResponse.json({ ok: true, raw_id: rawId })
}
