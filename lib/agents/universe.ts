// lib/agents/universe.ts
// R21 — Universe Agent: votes on token tradability based on liquidity data
// sourced from kymia_universe (updated daily by runUniverseCheckJob).
//
// Note: the orchestrator only calls this agent for tokens with status='ACTIVE'
// (non-ACTIVE tokens are excluded from the loop entirely — that is the primary guard).
// The agent adds a confidence dimension (liquidity quality) and a safety REJECT
// for tokens whose live liquidity has dropped below the suspension threshold
// before the daily job could act.

import { AgentVerdict, CycleContext } from './types'

// Thresholds (calibrated for ~$20 position size — see SPEC-AGENTS-CONFLUENCE.md R21)
const LIQ_SUSPEND = 250_000    // $250k — below this → REJECT (exit risk too high)
const LIQ_ENTRY   = 500_000    // $500k — entry threshold → confidence 50
const LIQ_TARGET  = 25_000_000 // $25M  — full confidence 100 (linear interpolation)

export function universeAgent(
  _ctx: CycleContext,
  liquidityUsd: number | null,
): AgentVerdict {
  if (liquidityUsd == null) {
    return {
      agent:      'universe',
      vote:       'ABSTAIN',
      confidence: 0,
      reason:     'no liquidity data — ABSTAIN (score redistributed)',
    }
  }

  // Safety veto: liquidity has dropped below suspension threshold since last job run
  if (liquidityUsd < LIQ_SUSPEND) {
    return {
      agent:      'universe',
      vote:       'REJECT',
      confidence: 100,
      reason:     `liquidity $${(liquidityUsd / 1000).toFixed(0)}k < $${LIQ_SUSPEND / 1000}k suspension threshold — exit risk`,
      data:       { liquidity_usd: liquidityUsd, threshold: LIQ_SUSPEND },
    }
  }

  // Linear interpolation: $500k → 50, $25M → 100
  const confidence = Math.min(100, Math.max(50, Math.round(
    50 + (liquidityUsd - LIQ_ENTRY) / (LIQ_TARGET - LIQ_ENTRY) * 50
  )))

  return {
    agent:      'universe',
    vote:       'APPROVE',
    confidence,
    reason:     `liquidity $${(liquidityUsd / 1_000_000).toFixed(2)}M → confidence ${confidence}`,
    data: {
      liquidity_usd: liquidityUsd,
      liq_entry:     LIQ_ENTRY,
      liq_target:    LIQ_TARGET,
    },
  }
}
