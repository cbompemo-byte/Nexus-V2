// app/api/smartmoney/audit/route.ts
// Cron + déclencheur manuel pour l'audit Smart Money.
// Auth : x-vercel-cron header (Vercel cron natif)
//      | header x-cron-secret = CRON_SECRET
//      | header x-admin-key   = KYMIA_ADMIN_KEY (déclenchement admin manuel)

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { runSmartMoneyAudit }        from '@/lib/smartmoney/audit'

export async function GET(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const cronSecret   = process.env.CRON_SECRET
  const adminKey     = process.env.KYMIA_ADMIN_KEY
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const hasSecret    = cronSecret && req.headers.get('x-cron-secret') === cronSecret
  const hasAdminKey  = adminKey   && req.headers.get('x-admin-key')   === adminKey

  if (!isVercelCron && !hasSecret && !hasAdminKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Supabase (service role — lecture/écriture des wallets et quota) ─────────
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase env vars missing' }, { status: 500 })
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  console.log('[smartmoney/audit] cron triggered')

  try {
    const result = await runSmartMoneyAudit(supabase)
    console.log('[smartmoney/audit] done:', JSON.stringify(result))
    return NextResponse.json({ ok: true, ...result, timestamp: new Date().toISOString() })
  } catch (e: any) {
    console.error('[smartmoney/audit] fatal:', e.message)
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
  }
}
