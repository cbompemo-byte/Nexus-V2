// app/api/public/dashboard/positions/route.ts
// Épisodes ouverts — lecture seule, publique.
// Inclut les épisodes virtuels (wallet non financé = tout est virtuel en phase OBSERVATION).
// Le champ mode par ligne permet au front d'étiqueter 'OBSERVATION' vs 'LIVE'.
//
// Sanitisation :
//   sl_price, tp_price, sl_backfilled, high_since_entry, opened_regime : internes, exclus
//   episode_id : interne, exclu

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const revalidate = 60

export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )

    const { data, error } = await supabase
      .from('kymia_dryrun_positions')
      .select('symbol,entry_price,opened_at,virtual')
      .order('opened_at', { ascending: false })

    if (error) throw error

    const positions = (data ?? []).map(row => ({
      symbol:      row.symbol,
      entry_price: row.entry_price,
      opened_at:   row.opened_at,
      mode:        row.virtual ? 'OBSERVATION' : 'LIVE',
    }))

    return NextResponse.json({ positions, mode: 'OBSERVATION' })
  } catch (e: any) {
    console.error('[api/public/dashboard/positions]', e?.message)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
