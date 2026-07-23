// app/api/public/dashboard/agents/route.ts
// Derniers verdicts des 6 agents (+ agrégateur confluence) — lecture seule, publique.
// Renvoie le verdict le plus récent par (symbol, agent) en déduisant le dernier cycle.
//
// Sanitisation :
//   data (EMA/ATR bruts) : exclu pour la légèreté du payload — non pour confidentialité
//   (reason contient déjà les valeurs clés ; la transparence est le positionnement).
//   episode_id : interne, exclu.

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const revalidate = 60

const KNOWN_AGENTS = ['universe', 'regime', 'signal', 'sizing', 'edge', 'risk', 'confluence']

export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )

    // Récupère les N derniers verdicts et déduplique côté JS (plus simple que
    // DISTINCT ON en Supabase JS client). 200 lignes couvrent ~7 symboles × 6 agents
    // avec plusieurs cycles de marge.
    const { data, error } = await supabase
      .from('kymia_agent_verdicts')
      .select('cycle_ts,symbol,agent,vote,confidence,reason,score_total,decision')
      .in('agent', KNOWN_AGENTS)
      .order('cycle_ts', { ascending: false })
      .limit(200)

    if (error) throw error

    // Garder uniquement le verdict le plus récent par (symbol, agent)
    const seen  = new Set<string>()
    const dedup = (data ?? []).filter(row => {
      const key = `${row.symbol}|${row.agent}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // Grouper par symbole pour faciliter la consommation côté client
    const bySymbol: Record<string, {
      cycle_ts:    string
      agents:      Array<{ agent: string; vote: string; confidence: number; reason: string; score_total: number | null; decision: string }>
    }> = {}

    for (const row of dedup) {
      if (!bySymbol[row.symbol]) {
        bySymbol[row.symbol] = { cycle_ts: row.cycle_ts, agents: [] }
      }
      bySymbol[row.symbol].agents.push({
        agent:       row.agent,
        vote:        row.vote,
        confidence:  row.confidence,
        reason:      row.reason,
        score_total: row.score_total,
        decision:    row.decision,
      })
    }

    return NextResponse.json({
      by_symbol: bySymbol,
      agent_count: 6,    // fact — confluence n'est pas un agent, c'est l'agrégateur
      mode: 'OBSERVATION',
    })
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
