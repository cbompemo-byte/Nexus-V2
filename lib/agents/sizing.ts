// lib/agents/sizing.ts
// R4 — ATR-based position sizing. Always APPROVE — returns size in data.
// sizeCalculee is consumed by the orchestrator before calling edge + risk agents.
// Confidence: 100 if size is free (sizeRaw ≤ cap), lower if cap is biting
// (biting cap = ATR/price too low for the rule → meaningful signal for R20).

import { AgentVerdict, CycleContext } from './types'
import { calcATR } from './utils'

// Must match REFERENCE_CAPITAL_USDC in route.ts (200 USDC).
// NOTE: if the reference capital changes, update here too.
const REFERENCE_CAPITAL = 200

// Cap aligned with RISK_CONFIG.MAX_POSITION_PCT (10%) in risk-guards.ts.
// If MAX_POSITION_PCT changes, update here too.
const MAX_SIZE_USD = REFERENCE_CAPITAL * 0.10  // $20

// Scaling coefficient: NOT a true risk-per-trade in the Kelly sense.
// The real loss per trade depends on the stop-loss distance set by signalAgent
// (max(2×ATR, 1.2% floor)), which is NOT used here.
// Calibrated empirically so the least volatile major (SOL, ~0.25% ATR/price)
// lands at the $20 cap. Derived from observed ATRs — re-validate after
// significant market regime changes.
const SIZING_RISK_COEFF = 0.00025  // (was 0.01)

export function sizingAgent(ctx: CycleContext): AgentVerdict {
  const atr14 = ctx.candles1h
    ? calcATR(ctx.candles1h, 14)
    : ctx.price * 0.02   // fallback identical to original runDryRunCycle

  const volRatio   = atr14 / ctx.price   // unrounded — used in data for calibration
  const sizeRaw    = (REFERENCE_CAPITAL * SIZING_RISK_COEFF) / volRatio
  const sizeCalculee = parseFloat(Math.min(sizeRaw, MAX_SIZE_USD).toFixed(2))

  // Confidence: 100 if ATR rule has room (free sizing), degraded if cap bites.
  // A biting cap signals "volatility too low for the sizing rule" → informs R20.
  const confidence = sizeRaw <= MAX_SIZE_USD
    ? 100
    : Math.round(100 * MAX_SIZE_USD / sizeRaw)

  return {
    agent:      'sizing',
    vote:       'APPROVE',
    confidence,
    reason:     `ATR-sized $${sizeCalculee} (ATR=${atr14.toFixed(4)}, cap 10%)`,
    data: {
      atr14,              // unrounded — use this for calibration, not the reason string
      vol_ratio: volRatio, // atr14/price, unrounded
      sizeRaw,
      sizeCalculee,
    },
  }
}
