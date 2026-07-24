// app/api/public/dashboard/decisions/route.ts
// Toutes les décisions récentes de kymia_dryrun_decisions — lecture seule, publique.
// Couvre deux besoins côté front :
//   · HISTORY tab  → decision IN ('EPISODE_CLOSED','EPISODE_CLOSED_SL','EPISODE_CLOSED_TP')
//   · REJECTED tab → codes de rejet (BEAR_REGIME_SKIP, GUARD_REFUSED, …)
//
// Champs exposés : timestamp, symbol, decision, reason, pnl_pct, price_usd,
//                  regime, score_total, episode_virtual
// Exclus (internes) : quote_jupiter, size_calculee, size_basis, episode_id, signal, size_basis

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
      .from('kymia_dryrun_decisions')
      .select('timestamp,symbol,decision,reason,pnl_pct,price_usd,regime,score_total,episode_virtual')
      .order('timestamp', { ascending: false })
      .limit(500)

    if (error) throw error

    return NextResponse.json({
      decisions: data ?? [],
      mode: 'OBSERVATION',
    })
  } catch (e: any) {
    console.error('[api/public/dashboard/decisions]', e?.message)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
