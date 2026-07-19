// app/api/public/proof/route.ts
// Preuve publique d'activité KYMIA — lecture seule, aucune auth requise.
// Cache 60s (Next.js revalidate) : le trafic public ne martèle pas Supabase.
//
// Sanitisation STRICTE — jamais exposés :
//   size_calculee, size_basis, quote_jupiter, episode_id, pnl_pct, price_usd,
//   mints des tokens éligibles (mints des bloqués OK).

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getTradingWalletAddress } from '@/lib/solana/wallet'

export const revalidate = 60

export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )

    // ── Core decisions ─────────────────────────────────────────────────────────

    const [decisionsRes, screensRes, statsRes] = await Promise.all([
      supabase
        .from('kymia_dryrun_decisions')
        .select('timestamp,symbol,regime,decision,reason')
        .order('timestamp', { ascending: false })
        .limit(30),
      supabase
        .from('kymia_memecoin_screens')
        .select('screened_at,symbol,name,age_hours,volume_24h,eligible,first_failed_check,fail_reason')
        .order('screened_at', { ascending: false })
        .limit(20),
      supabase.rpc('kymia_proof_stats'),
    ])

    const decisions = (decisionsRes.data ?? []).map(d => ({
      timestamp: d.timestamp,
      symbol:    d.symbol,
      regime:    d.regime,
      decision:  d.decision,
      reason:    d.reason,
    }))

    // ── Memecoin screens ───────────────────────────────────────────────────────

    const screens = (screensRes.data ?? []).map(s => ({
      screened_at:        s.screened_at,
      symbol:             s.symbol,
      name:               s.name,
      age_hours:          s.age_hours,
      volume_24h:         s.volume_24h,
      eligible:           s.eligible,
      first_failed_check: s.first_failed_check,
      fail_reason:        s.fail_reason,
      // mint intentionnellement absent
    }))

    // ── Stats agrégées (Postgres) ──────────────────────────────────────────────

    const pgStats   = (statsRes.data ?? {}) as {
      core:     { total_decisions: number; depuis: string | null; par_decision: Record<string, number> }
      memecoin: { total_analyses: number; bloques: number; eligibles: number; par_check: Record<string, number> }
    }
    const coreStats     = pgStats.core     ?? {}
    const memecoinStats = pgStats.memecoin ?? {}

    // ── Wallet ─────────────────────────────────────────────────────────────────

    const address = getTradingWalletAddress()

    return NextResponse.json({
      core: {
        decisions,
        stats: {
          total_decisions: coreStats.total_decisions ?? 0,
          par_decision:    coreStats.par_decision    ?? {},
          depuis:          coreStats.depuis          ?? null,
        },
      },
      memecoin: {
        screens,
        stats: {
          total_analyses: memecoinStats.total_analyses ?? 0,
          bloques:        memecoinStats.bloques        ?? 0,
          eligibles:      memecoinStats.eligibles      ?? 0,
          par_check:      memecoinStats.par_check      ?? {},
        },
      },
      wallet: {
        address,
        solscan: `https://solscan.io/account/${address}`,
      },
      mode: 'OBSERVATION',
    })
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
