// lib/agents/edge.ts
// R3 — Profitability threshold: expected gain vs estimated round-trip swap cost.
// Requires ctx.quoteJupiter (fetched by orchestrator); returns ABSTAIN if absent.
// ⚠ REJECT reason is byte-identical to REJECTED_LOW_EDGE reason in runDryRunCycle.
// Confidence is graduated: 3× cost → 50, 4.5× → 75, ≥6× → 100.

import { AgentVerdict, CycleContext } from './types'

export function edgeAgent(ctx: CycleContext, tp: number): AgentVerdict {
  if (!ctx.quoteJupiter || ctx.sizeCalculee == null) {
    return {
      agent: 'edge', vote: 'ABSTAIN', confidence: 0,
      reason: 'No Jupiter quote — cannot evaluate edge',
    }
  }

  const priceImpact     = Math.abs(parseFloat(ctx.quoteJupiter.priceImpactPct))
  // Cost estimate: round-trip fee (Jupiter ~0.3% × 2) + price impact × 2
  const costEstimatePct = 2 * (0.003 + priceImpact / 100)
  const gainExpectedPct = tp > 0 ? (tp - ctx.price) / ctx.price : 0

  if (gainExpectedPct < 3 * costEstimatePct) {
    return {
      agent: 'edge', vote: 'REJECT', confidence: 0,
      // ⚠ Byte-identical to REJECTED_LOW_EDGE reason — same toFixed(2)/(2)/(3)
      reason: (
        `gain ${(gainExpectedPct * 100).toFixed(2)}% < 3×cost ${(costEstimatePct * 100).toFixed(2)}%` +
        ` (impact=${priceImpact.toFixed(3)}%)`
      ),
      data: { priceImpact, costEstimatePct, gainExpectedPct },
    }
  }

  // Graduated confidence: ratio = gain/cost. 3× → 50, 4.5× → 75, ≥6× → 100.
  const ratio      = gainExpectedPct / costEstimatePct
  const confidence = Math.min(100, Math.round(50 + (ratio - 3) / 3 * 50))

  return {
    agent: 'edge', vote: 'APPROVE', confidence,
    reason: `gain ${(gainExpectedPct * 100).toFixed(2)}% ≥ 3×cost ${(costEstimatePct * 100).toFixed(2)}% (impact=${priceImpact.toFixed(3)}%)`,
    data: { priceImpact, costEstimatePct, gainExpectedPct, ratio },
  }
}
