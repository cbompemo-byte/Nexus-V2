// app/api/public/dashboard/universe/route.ts
// Tokens actifs surveillés par le moteur — lecture seule, publique.
//
// Sanitisation :
//   mint : adresse SPL interne (technique, non pertinente publiquement), exclu
//   price_symbol : clé interne de mapping Kraken/KuCoin, exclu
//   status_reason : message interne de transition de statut, exclu

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
      .from('kymia_universe')
      .select('symbol,status,liquidity_usd,volume_24h,last_check')
      .eq('status', 'ACTIVE')
      .order('symbol', { ascending: true })

    if (error) throw error

    return NextResponse.json({
      tokens: data ?? [],
      count:  (data ?? []).length,
      mode:   'OBSERVATION',
    })
  } catch (e: any) {
    console.error('[api/public/dashboard/universe]', e?.message)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
