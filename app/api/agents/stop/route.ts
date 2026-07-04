import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  const { userId } = await req.json()
  if (!userId) return NextResponse.json({ error: 'No userId' }, { status: 400 })

  await supabase
    .from('kymia_agent_state')
    .update({ running: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId)

  return NextResponse.json({ ok: true, running: false })
}
