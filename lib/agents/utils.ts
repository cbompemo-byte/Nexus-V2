// lib/agents/utils.ts
// Pure indicator functions — extracted verbatim from app/api/agents/cycle/route.ts.
// Do NOT change these without updating the parallel definitions that were there.
// Imported by agent files and used via wrapper in findTradingOpportunity (route.ts).

export function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0
  const k = 2 / (period + 1)
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k)
  }
  return ema
}

export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff
    else losses += Math.abs(diff)
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

export function calcATR(closes: number[], period = 14): number {
  if (closes.length < period + 1) return closes[closes.length - 1] * 0.02
  const trs = closes.slice(1).map((c, i) => Math.abs(c - closes[i]))
  return trs.slice(-period).reduce((a: number, b: number) => a + b, 0) / period
}
