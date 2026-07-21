// lib/agents/sizing.ts
// R4 — ATR-based position sizing. Always APPROVE — returns size in data.
// sizeCalculee is consumed by the orchestrator before calling edge + risk agents.

import { AgentVerdict, CycleContext } from './types'
import { calcATR } from './utils'

// Must match REFERENCE_CAPITAL_USDC in route.ts (200 USDC).
// NOTE: if the reference capital changes, update here too.
const REFERENCE_CAPITAL = 200

export function sizingAgent(ctx: CycleContext): AgentVerdict {
  const atr14 = ctx.candles1h
    ? calcATR(ctx.candles1h, 14)
    : ctx.price * 0.02   // fallback identical to original runDryRunCycle

  const sizeRaw      = (REFERENCE_CAPITAL * 0.01) / (atr14 / ctx.price)
  const sizeCalculee = parseFloat(
    Math.min(sizeRaw, REFERENCE_CAPITAL * 0.10).toFixed(2)
  )

  return {
    agent:      'sizing',
    vote:       'APPROVE',
    confidence: 100,
    reason:     `ATR-sized $${sizeCalculee} (ATR=${atr14.toFixed(4)}, cap 10%)`,
    data: { atr14, sizeCalculee },
  }
}
