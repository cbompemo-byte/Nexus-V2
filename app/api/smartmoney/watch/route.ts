// app/api/smartmoney/watch/route.ts
// Endpoint du job de surveillance Smart Money (cycle 60 min — cron-job.org).
// Séparé du cycle core /api/agents/cycle pour ne jamais l'impacter.
//
// Auth : x-vercel-cron === '1'  (Vercel cron natif)
//      | x-cron-secret = CRON_SECRET  (cron-job.org)
//      | x-admin-key   = KYMIA_ADMIN_KEY  (déclenchement manuel)

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'
import { runSmartMoneyWatch }        from '@/lib/smartmoney/watch'

export async function GET(req: NextRequest) {
  const cronSecret   = process.env.CRON_SECRET
  const adminKey     = process.env.KYMIA_ADMIN_KEY
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const hasSecret    = cronSecret && req.headers.get('x-cron-secret') === cronSecret
  const hasAdminKey  = adminKey   && req.headers.get('x-admin-key')   === adminKey

  if (!isVercelCron && !hasSecret && !hasAdminKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase env vars missing' }, { status: 500 })
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })
  console.log('[smartmoney/watch] triggered')

  try {
    const result = await runSmartMoneyWatch(supabase)
    return NextResponse.json({ ok: true, ...result, timestamp: new Date().toISOString() })
  } catch (e: any) {
    console.error('[smartmoney/watch] fatal:', e.message)
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
  }
}
