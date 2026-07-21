// lib/agents/regime.ts
// R1 — Regime filter: EMA50 / EMA200 on 4h candles.
// vote APPROVE = BULL, REJECT = BEAR, ABSTAIN = candles unavailable.
// ⚠ reason strings are byte-identical to what runDryRunCycle logged before refactor.
// Confidence is graduated (not binary) — see formulas below.

import { AgentVerdict, CycleContext } from './types'
import { calcEMA } from './utils'

export function regimeAgent(ctx: CycleContext): AgentVerdict {
  if (!ctx.candles4h || ctx.candles4h.length < 200) {
    return {
      agent:      'regime',
      vote:       'ABSTAIN',
      confidence: 0,
      // ⚠ Byte-identical to CANDLES_UNAVAILABLE reason in runDryRunCycle.
      reason: `4h candles: ${ctx.candles4h?.length ?? 0} < 200`,
      data: { candles_count: ctx.candles4h?.length ?? 0 },
    }
  }

  const ema50  = calcEMA(ctx.candles4h, 50)
  const ema200 = calcEMA(ctx.candles4h, 200)
  const isBull = ctx.price > ema200 && ema50 > ema200

  if (isBull) {
    // Confidence: distance above EMA200 + EMA50/200 alignment bonus.
    // 0% above → 50, ≥10% above → 95, linear. Bonus 0-10 for EMA spread.
    const pctAbove  = (ctx.price - ema200) / ema200
    const emaSpread = (ema50 - ema200) / ema200
    const base      = Math.min(95, 50 + pctAbove * 500)
    const bonus     = Math.min(10, emaSpread * 200)
    const confidence = Math.min(100, Math.round(base + bonus))

    return {
      agent:      'regime',
      vote:       'APPROVE',
      confidence,
      reason: `BULL: price ${ctx.price.toFixed(4)} > EMA200 ${ema200.toFixed(4)}, EMA50 ${ema50.toFixed(4)} > EMA200`,
      data: { ema50_4h: ema50, ema200_4h: ema200, regime: 'BULL', pct_above_ema200: pctAbove, ema_spread: emaSpread },
    }
  }

  // BEAR: confidence by depth below EMA200. 0% below → 50, ≥10% → 100.
  const pctBelow   = (ema200 - ctx.price) / ema200
  const confidence = Math.min(100, Math.round(50 + pctBelow * 500))

  return {
    agent:      'regime',
    vote:       'REJECT',
    confidence,
    // ⚠ Byte-identical to BEAR_REGIME_SKIP reason hardcoded in runDryRunCycle.
    reason: `price ${ctx.price.toFixed(4)} below EMA200 ${ema200.toFixed(4)} or EMA50 < EMA200`,
    data: { ema50_4h: ema50, ema200_4h: ema200, regime: 'BEAR', pct_below_ema200: pctBelow },
  }
}
