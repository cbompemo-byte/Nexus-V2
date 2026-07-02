import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  try {
    const { data: activeUsers } = await supabase
      .from('kymia_agent_state')
      .select('*')
      .eq('running', true)

    if (!activeUsers?.length) {
      return NextResponse.json({ ok: true, active: 0 })
    }

    const results = await Promise.allSettled(
      activeUsers.map(state => runUserCycle(state))
    )

    return NextResponse.json({
      ok: true,
      active: activeUsers.length,
      results: results.length,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

async function runUserCycle(state: any) {
  const userId = state.user_id
  const config = state.swarm_config || { profile: 'balanced', leverage: 3 }

  const prices = await fetchRealPrices()
  const signals = await runAllAgents(prices)

  if (signals.length) {
    await supabase.from('kymia_signals').insert(
      signals.map(s => ({
        user_id: userId,
        agent_id: s.id,
        sym: s.sym,
        signal: s.sig,
        confidence: s.conf,
        reasoning: s.th,
      }))
    )
  }

  const consensus = calcConsensus(signals)

  await checkPositions(userId, state, prices)

  if (consensus.sig !== 'HOLD' && consensus.conf >= 76 && consensus.aligned) {
    await openServerTrade(userId, state, consensus, prices)
  }

  await supabase
    .from('kymia_agent_state')
    .update({
      last_cycle: new Date().toISOString(),
      cycle_count: (state.cycle_count || 0) + 1,
      regime: consensus.regime || 'NEUTRAL',
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
}

async function fetchRealPrices() {
  try {
    const [krakenRes, cgRes] = await Promise.all([
      fetch('https://api.kraken.com/0/public/Ticker?pair=SOLUSD,BTCUSD,ETHUSD'),
      fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=jupiter,bonk,jito-governance-token&vs_currencies=usd&include_24hr_change=true'
      ),
    ])
    const kraken = await krakenRes.json()
    const cg = await cgRes.json()

    const result: Record<string, any> = {}

    if (kraken.result) {
      const r = kraken.result
      if (r.SOLUSD) result['SOL'] = { price: parseFloat(r.SOLUSD.c[0]), change: parseFloat(r.SOLUSD.P[1]) }
      if (r.XXBTZUSD) result['BTC'] = { price: parseFloat(r.XXBTZUSD.c[0]), change: parseFloat(r.XXBTZUSD.P[1]) }
      if (r.XETHZUSD) result['ETH'] = { price: parseFloat(r.XETHZUSD.c[0]), change: parseFloat(r.XETHZUSD.P[1]) }
    }

    if (cg.jupiter) result['JUP'] = { price: cg.jupiter.usd, change: cg['jupiter']?.usd_24h_change || 0 }

    return result
  } catch {
    return {}
  }
}

async function runAllAgents(prices: Record<string, any>) {
  const signals: any[] = []
  const syms = ['SOL', 'BTC', 'ETH', 'JUP']

  for (const sym of syms) {
    const price = prices[sym]?.price
    if (!price) continue

    try {
      // RSI Agent (LENS)
      const rsiRes = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=5m&limit=15`
      )
      const rsiData = await rsiRes.json()
      if (Array.isArray(rsiData)) {
        const closes = rsiData.map((c: any) => parseFloat(c[4]))
        const rsi = calcRSI(closes)

        let sig = 'HOLD'
        let conf = 50
        if (rsi < 35) { sig = 'BUY'; conf = 72 + (35 - rsi) }
        if (rsi > 68) { sig = 'SELL'; conf = 72 + (rsi - 68) }

        signals.push({ id: 'lens', sym, sig, conf: Math.min(conf, 95), th: `RSI ${rsi.toFixed(1)} on 5m` })
      }

      // EMA Agent (RADAR)
      const emaRes = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1h&limit=22`
      )
      const emaData = await emaRes.json()
      if (Array.isArray(emaData)) {
        const closes = emaData.map((c: any) => parseFloat(c[4]))
        const ema9 = calcEMA(closes, 9)
        const ema21 = calcEMA(closes, 21)
        const last = closes[closes.length - 1]

        let sig = 'HOLD'
        let conf = 50
        if (ema9 > ema21 && last > ema9) { sig = 'BUY'; conf = 76 }
        if (ema9 < ema21 && last < ema9) { sig = 'SELL'; conf = 76 }

        signals.push({ id: 'radar', sym, sig, conf, th: `EMA9 ${ema9 > ema21 ? '>' : '<'} EMA21 on 1h` })
      }

      // Volume Agent (SURGE)
      const volRes = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}USDT`)
      const volData = await volRes.json()
      if (volData.quoteVolume) {
        const change = parseFloat(volData.priceChangePercent || '0')
        let sig = 'HOLD'
        let conf = 55
        if (change > 3) { sig = 'BUY'; conf = 70 }
        if (change < -3) { sig = 'SELL'; conf = 70 }
        signals.push({ id: 'surge', sym, sig, conf, th: `24h change ${change.toFixed(1)}%` })
      }
    } catch {
      // API failed for this symbol, skip
    }
  }

  return signals
}

function calcConsensus(signals: any[]) {
  if (!signals.length) return { sig: 'HOLD', conf: 0, aligned: false, regime: 'NEUTRAL' }

  const bySymbol: Record<string, any[]> = {}
  signals.forEach(s => {
    if (!bySymbol[s.sym]) bySymbol[s.sym] = []
    bySymbol[s.sym].push(s)
  })

  let bestSignal = { sig: 'HOLD', conf: 0, sym: '', aligned: false, regime: 'NEUTRAL' }

  Object.entries(bySymbol).forEach(([sym, sigs]) => {
    const buys = sigs.filter(s => s.sig === 'BUY')
    const sells = sigs.filter(s => s.sig === 'SELL')
    const total = sigs.length

    if (buys.length / total >= 0.66) {
      const avgConf = buys.reduce((s: number, a: any) => s + a.conf, 0) / buys.length
      if (avgConf > bestSignal.conf) {
        bestSignal = { sig: 'BUY', conf: avgConf, sym, aligned: buys.length >= 2, regime: 'BULL' }
      }
    }
    if (sells.length / total >= 0.66) {
      const avgConf = sells.reduce((s: number, a: any) => s + a.conf, 0) / sells.length
      if (avgConf > bestSignal.conf) {
        bestSignal = { sig: 'SELL', conf: avgConf, sym, aligned: sells.length >= 2, regime: 'BEAR' }
      }
    }
  })

  return bestSignal
}

function calcRSI(closes: number[], period = 14) {
  const gains: number[] = []
  const losses: number[] = []
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    gains.push(Math.max(0, diff))
    losses.push(Math.max(0, -diff))
  }
  const ag = gains.slice(-period).reduce((a, b) => a + b, 0) / period
  const al = losses.slice(-period).reduce((a, b) => a + b, 0) / period
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al)
}

function calcEMA(closes: number[], period: number) {
  const k = 2 / (period + 1)
  let ema = closes[0]
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k)
  }
  return ema
}

async function checkPositions(userId: string, state: any, prices: Record<string, any>) {
  const positions = state.positions || {}
  const updates: any = { ...positions }
  let equity = state.equity || 10000
  let cash = state.cash || 10000

  for (const [sym, pos] of Object.entries(positions) as any) {
    const cur = prices[sym]?.price
    if (!cur) continue

    const isLong = pos.side === 'BUY' || pos.side === 'LONG'
    const pnl = isLong ? (cur - pos.avg) * pos.qty : (pos.avg - cur) * pos.qty
    const pct = (pnl / (pos.avg * pos.qty)) * 100

    const sl = isLong ? pos.avg * 0.982 : pos.avg * 1.018
    const tp = isLong ? pos.avg * 1.055 : pos.avg * 0.945

    const slHit = isLong ? cur <= sl : cur >= sl
    const tpHit = isLong ? cur >= tp : cur <= tp

    if (slHit || tpHit) {
      const closeValue = pos.qty * cur
      cash += closeValue
      equity =
        cash +
        Object.entries(updates)
          .filter(([s]) => s !== sym)
          .reduce((sum: number, [s, p]: any) => {
            const price = prices[s]?.price || p.avg
            return sum + p.qty * price
          }, 0)

      delete updates[sym]

      await supabase.from('kymia_trades').insert({
        user_id: userId,
        sym,
        side: pos.side,
        entry: pos.avg,
        exit: cur,
        pnl: parseFloat(pnl.toFixed(2)),
        pct: parseFloat(pct.toFixed(2)),
        agent: 'AEGIS',
        opened_at: pos.openedAt,
        closed_at: new Date().toISOString(),
      })
    }
  }

  await supabase
    .from('kymia_agent_state')
    .update({
      positions: updates,
      equity: parseFloat(equity.toFixed(2)),
      cash: parseFloat(cash.toFixed(2)),
    })
    .eq('user_id', userId)
}

async function openServerTrade(
  userId: string,
  state: any,
  consensus: any,
  prices: Record<string, any>
) {
  const { sym, sig, conf } = consensus
  const price = prices[sym]?.price
  if (!price) return

  const positions = state.positions || {}
  if (positions[sym]) return

  const equity = state.equity || 10000
  const config = state.swarm_config || { profile: 'balanced', leverage: 3 }

  const BASE_PCT: Record<string, number> = { safe: 0.04, balanced: 0.06, aggressive: 0.10 }
  const basePct = BASE_PCT[config.profile as string] || 0.06

  const multiplier = conf >= 90 ? 3.0 : conf >= 83 ? 2.0 : conf >= 76 ? 1.5 : 1.0
  const rawSize = equity * basePct * multiplier * (config.leverage || 1)
  const size = Math.min(rawSize, equity * 0.25)
  const qty = size / price

  const newPositions = {
    ...positions,
    [sym]: {
      avg: price,
      qty: parseFloat(qty.toFixed(6)),
      side: sig === 'BUY' ? 'LONG' : 'SHORT',
      size: parseFloat(size.toFixed(2)),
      openedAt: new Date().toISOString(),
      conf,
    },
  }

  const newCash = (state.cash || 10000) - size

  await supabase
    .from('kymia_agent_state')
    .update({
      positions: newPositions,
      cash: parseFloat(newCash.toFixed(2)),
    })
    .eq('user_id', userId)
}
