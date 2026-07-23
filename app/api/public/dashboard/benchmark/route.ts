// app/api/public/dashboard/benchmark/route.ts
// Comparaison agent vs buy-and-hold — lecture seule, publique.
// Appelle kymia_benchmark_stats(true) — le paramètre `true` inclut les épisodes
// virtuels (wallet non financé), cohérent avec /positions qui les expose aussi.

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

    const { data, error } = await supabase.rpc('kymia_benchmark_stats', { include_virtual: true })

    if (error) throw error

    return NextResponse.json({
      stats: data ?? [],
      mode:  'OBSERVATION',
      note:  'agent_pct and hold_pct share the same baseline date — alpha is comparable',
    })
  } catch (e: any) {
    console.error('[api/public/dashboard/benchmark]', e?.message)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
