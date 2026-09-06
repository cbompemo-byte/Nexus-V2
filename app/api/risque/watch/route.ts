// app/api/risque/watch/route.ts
// Point d'entrée HTTP pour le job Risque (cycle 30 min).
// Auth : x-cron-secret (cron-job.org), x-admin-key, ou x-vercel-cron.
//
// AUCUN trade automatique. Observation uniquement.

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse }  from 'next/server'
import { createClient }               from '@supabase/supabase-js'
import { runRisqueWatch }             from '@/lib/risque/watch'

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  const adminKey   = process.env.KYMIA_ADMIN_KEY
  const incoming   = req.headers.get('x-cron-secret') ?? req.headers.get('x-admin-key')
  if (cronSecret && incoming === cronSecret) return true
  if (adminKey   && incoming === adminKey)   return true
  if (req.headers.get('x-vercel-cron') === '1') return true
  return false
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Supabase env vars missing' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })

  console.log('[risque/watch] run triggered')
  try {
    const result = await runRisqueWatch(supabase)
    return NextResponse.json({ ok: true, ...result, timestamp: new Date().toISOString() })
  } catch (e: any) {
    console.error('[risque/watch] erreur:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
