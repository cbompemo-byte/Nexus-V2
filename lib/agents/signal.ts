// lib/agents/signal.ts
// EMA/RSI hybrid strategy — extracted from findTradingOpportunity (route.ts).
//
// Two exports:
//   computeSignal(closes, price, change24h, symbol)
//     Pure computation: same logic, same thresholds, same reason strings as
//     the original findTradingOpportunity. Used by signalAgent AND by the
//     findTradingOpportunity wrapper in route.ts (for runUserCycle).
//
//   signalAgent(ctx) → AgentVerdict
//     Thin wrapper: receives ctx.candles1h pre-fetched, calls computeSignal,
//     maps BUY → APPROVE, SELL → REJECT, NONE → ABSTAIN.
//
// ⚠ reason strings are byte-identical to the original findTradingOpportunity.
//   Do NOT change toFixed precision without updating the comparison queries.

import { AgentVerdict, CycleContext } from './types'
import { calcEMA, calcRSI } from './utils'

// ── Return type mirrors findTradingOpportunity's original return ───────────────
export interface SignalResult {
  signal:     'BUY' | 'SELL' | 'NONE'
  confidence: number
  reason:     string
  entry:      number
  sl:         number
  tp:         number
  size_pct:   number
}

// ── computeSignal — pure, no I/O ──────────────────────────────────────────────
export function computeSignal(
  closes:    number[],
  price:     number,
  change24h: number,
  symbol:    string,   // for console.log only — no logic dependency
): SignalResult {
  const NONE: SignalResult = { signal: 'NONE', confidence: 0, reason: '', entry: price, sl: 0, tp: 0, size_pct: 0 }

  const ema9  = calcEMA(closes, 9)
  const ema21 = calcEMA(closes, 21)
  const ema50 = calcEMA(closes, 50)
  const rsi   = calcRSI(closes.slice(-15))
  const last3 = closes.slice(-3)
  const momentum = (last3[2] - last3[0]) / last3[0] * 100

  // ATR — inline, identical to original findTradingOpportunity
  const trs = closes.slice(1).map((c, i) => Math.abs(c - closes[i]))
  const atr  = trs.slice(-14).reduce((a: number, b: number) => a + b, 0) / 14

  // Trend strength (% of candles closing in dominant direction)
  let trend = 0
  for (let i = 1; i < closes.length; i++) {
    trend += closes[i] > closes[i - 1] ? 1 : -1
  }
  const adx = Math.abs(trend) / closes.length * 100

  const isTrending = adx > 55
  const isRanging  = adx < 40

  const slDist = Math.max(atr * 2, price * 0.012)
  const tpDist = Math.max(slDist * 2.5, price * 0.03)

  // ⚠ Floor constants — byte-identical to original
  const MIN_SL_PCT = 0.008
  const MIN_TP_PCT = 0.020
  const floorSl = (sl: number, isBuy: boolean) =>
    isBuy ? Math.min(sl, price * (1 - MIN_SL_PCT)) : Math.max(sl, price * (1 + MIN_SL_PCT))
  const floorTp = (tp: number, isBuy: boolean) =>
    isBuy ? Math.max(tp, price * (1 + MIN_TP_PCT)) : Math.min(tp, price * (1 - MIN_TP_PCT))

  console.log(
    `[${symbol}] price=${price.toFixed(4)}` +
    ` ema9=${ema9.toFixed(4)} ema21=${ema21.toFixed(4)}` +
    ` rsi=${rsi.toFixed(1)} mom=${momentum.toFixed(2)}%` +
    ` trend=${adx.toFixed(0)}% regime=${isTrending ? 'TREND' : isRanging ? 'RANGE' : 'MIXED'}`
  )

  // ── TRENDING → EMA trend following ────────────────────────────────────────
  if (isTrending) {
    const bullTrend = ema9 > ema21 && ema21 > ema50
    const bearTrend = ema9 < ema21 && ema21 < ema50

    if (bullTrend && price > ema9 && rsi > 45 && rsi < 72 && momentum > 0.1 && change24h > -1) {
      const sl   = price - slDist
      const tp   = price + tpDist
      const conf = Math.min(95,
        65 + (adx > 70 ? 20 : 10) +
        (momentum > 0.3 ? 8 : 3) +
        (change24h > 2  ? 7 : 0)
      )
      const fsl = floorSl(sl, true), ftp = floorTp(tp, true)
      console.log(`[${symbol}] TREND BUY: sl=${fsl.toFixed(4)} tp=${ftp.toFixed(4)} conf=${conf}`)
      return {
        signal: 'BUY', confidence: conf,
        // ⚠ Byte-identical reason
        reason: `TREND Bull EMA trend=${adx.toFixed(0)}% RSI:${rsi.toFixed(0)}`,
        entry: price, sl: fsl, tp: ftp,
        size_pct: conf >= 85 ? 0.10 : 0.07,
      }
    }

    if (bearTrend && price < ema9 && rsi > 28 && rsi < 55 && momentum < -0.1 && change24h < 1) {
      const sl   = price + slDist
      const tp   = price - tpDist
      const conf = Math.min(95,
        65 + (adx > 70 ? 20 : 10) +
        (momentum < -0.3 ? 8 : 3) +
        (change24h < -2  ? 7 : 0)
      )
      const fsl = floorSl(sl, false), ftp = floorTp(tp, false)
      console.log(`[${symbol}] TREND SELL: sl=${fsl.toFixed(4)} tp=${ftp.toFixed(4)} conf=${conf}`)
      return {
        signal: 'SELL', confidence: conf,
        reason: `TREND Bear EMA trend=${adx.toFixed(0)}% RSI:${rsi.toFixed(0)}`,
        entry: price, sl: fsl, tp: ftp,
        size_pct: conf >= 85 ? 0.10 : 0.07,
      }
    }
  }

  // ── RANGING → RSI mean reversion ──────────────────────────────────────────
  if (isRanging) {
    if (rsi < 32 && momentum > -0.5) {
      const sl   = price - Math.max(price * 0.015, slDist)
      const tp   = price + Math.max(price * 0.035, tpDist)
      const conf = Math.min(90, 60 + (rsi < 25 ? 20 : 10) + (momentum > 0 ? 5 : 0))
      const fsl = floorSl(sl, true), ftp = floorTp(tp, true)
      console.log(`[${symbol}] RANGE BUY: rsi=${rsi.toFixed(1)} sl=${fsl.toFixed(4)} tp=${ftp.toFixed(4)} conf=${conf}`)
      return {
        signal: 'BUY', confidence: conf,
        reason: `RANGE Oversold RSI:${rsi.toFixed(0)} trend=${adx.toFixed(0)}%`,
        entry: price, sl: fsl, tp: ftp,
        size_pct: 0.06,
      }
    }

    if (rsi > 68 && momentum < 0.5) {
      const sl   = price + Math.max(price * 0.015, slDist)
      const tp   = price - Math.max(price * 0.035, tpDist)
      const conf = Math.min(90, 60 + (rsi > 75 ? 20 : 10) + (momentum < 0 ? 5 : 0))
      const fsl = floorSl(sl, false), ftp = floorTp(tp, false)
      console.log(`[${symbol}] RANGE SELL: rsi=${rsi.toFixed(1)} sl=${fsl.toFixed(4)} tp=${ftp.toFixed(4)} conf=${conf}`)
      return {
        signal: 'SELL', confidence: conf,
        reason: `RANGE Overbought RSI:${rsi.toFixed(0)} trend=${adx.toFixed(0)}%`,
        entry: price, sl: fsl, tp: ftp,
        size_pct: 0.06,
      }
    }
  }

  // ── MIXED → only very strong setups ───────────────────────────────────────
  const veryBull = ema9 > ema21 && rsi > 50 && momentum > 0.2
  const veryBear = ema9 < ema21 && rsi < 50 && momentum < -0.2

  if (veryBull && change24h > 2) {
    return {
      signal: 'BUY', confidence: 72,
      reason: `MIXED Bull RSI:${rsi.toFixed(0)} mom:${momentum.toFixed(2)}%`,
      entry: price,
      sl: floorSl(price - Math.max(price * 0.018, slDist), true),
      tp: floorTp(price + Math.max(price * 0.045, tpDist), true),
      size_pct: 0.05,
    }
  }

  if (veryBear && change24h < -2) {
    return {
      signal: 'SELL', confidence: 72,
      reason: `MIXED Bear RSI:${rsi.toFixed(0)} mom:${momentum.toFixed(2)}%`,
      entry: price,
      sl: floorSl(price + Math.max(price * 0.018, slDist), false),
      tp: floorTp(price - Math.max(price * 0.045, tpDist), false),
      size_pct: 0.05,
    }
  }

  console.log(`[${symbol}] NO SIGNAL:`, {
    bullTrend:  ema9 > ema21 && ema21 > ema50,
    bearTrend:  ema9 < ema21 && ema21 < ema50,
    rsi:        rsi.toFixed(1),
    momentum:   momentum.toFixed(3),
    change24h:  change24h.toFixed(2),
    trend:      adx.toFixed(1) + '%',
  })
  return {
    ...NONE,
    // ⚠ Byte-identical — toFixed(1) for ema9, toFixed(0) for rsi and trend
    reason: `No signal: ema9=${ema9.toFixed(1)} rsi=${rsi.toFixed(0)} trend=${adx.toFixed(0)}%`,
  }
}

// ── signalAgent — wraps computeSignal ─────────────────────────────────────────
export function signalAgent(ctx: CycleContext): AgentVerdict {
  if (!ctx.candles1h) {
    return {
      agent: 'signal', vote: 'ABSTAIN', confidence: 0,
      reason: 'no candle data',
      data: { signal: 'NONE', tp: 0, sl: 0 },
    }
  }

  try {
    const change24h = (ctx.priceData[ctx.symbol]?.change as number) || 0
    const result = computeSignal(ctx.candles1h, ctx.price, change24h, ctx.symbol)

    const vote: 'APPROVE' | 'REJECT' | 'ABSTAIN' =
      result.signal === 'BUY'  ? 'APPROVE' :
      result.signal === 'SELL' ? 'REJECT'  : 'ABSTAIN'

    return {
      agent:      'signal',
      vote,
      confidence: result.confidence,
      reason:     result.reason,
      data: {
        signal:   result.signal,
        tp:       result.tp,
        sl:       result.sl,
        size_pct: result.size_pct,
      },
    }
  } catch (e: any) {
    console.log(`[strategy] ${ctx.symbol} error: ${e.message}`)
    return {
      agent: 'signal', vote: 'ABSTAIN', confidence: 0,
      reason: e.message,
      data: { signal: 'NONE', tp: 0, sl: 0 },
    }
  }
}
