// lib/agents/risk.ts
// Hard veto: risk guards (kill-switch, position size, price impact).
// Async — calls runAllGuards which reads DB state (hence supabase param).
// ⚠ REJECT reason passes through guard.reason unchanged — byte-identical.

import { SupabaseClient } from '@supabase/supabase-js'
import { runAllGuards } from '@/lib/solana/risk-guards'
import { AgentVerdict, CycleContext } from './types'

export async function riskAgent(
  ctx:      CycleContext,
  supabase: SupabaseClient,
): Promise<AgentVerdict> {
  if (!ctx.quoteJupiter || ctx.sizeCalculee == null) {
    return {
      agent: 'risk', vote: 'ABSTAIN', confidence: 0,
      reason: 'No quote or size — cannot evaluate guards',
    }
  }

  const guard = await runAllGuards(
    supabase,
    ctx.sizeCalculee,
    ctx.quoteJupiter.priceImpactPct,
    ctx.onchainEquity ?? 0,
  )

  if (!guard.allowed) {
    return {
      agent: 'risk', vote: 'REJECT', confidence: 0,
      // ⚠ Byte-identical to GUARD_REFUSED reason: guard.reason ?? 'guard failed'
      reason: guard.reason ?? 'guard failed',
      data: { guard_reason: guard.reason },
    }
  }

  return {
    agent: 'risk', vote: 'APPROVE', confidence: 100,
    reason: 'All risk guards passed',
    data: { equity: ctx.onchainEquity ?? 0, sizeCalculee: ctx.sizeCalculee },
  }
}
