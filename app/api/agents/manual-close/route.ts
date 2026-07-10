import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 })
  }

  try {
    const { userId, sym } = await req.json()
    if (!userId || !sym) {
      return NextResponse.json({ error: 'Missing userId or sym' }, { status: 400 })
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )

    // Load current state
    const { data: state, error: stateError } = await supabase
      .from('kymia_agent_state')
      .select('*')
      .eq('user_id', userId)
      .single()

    if (stateError || !state) {
      return NextResponse.json({ error: 'State not found' }, { status: 404 })
    }

    const positions = state.positions || {}
    const pos = positions[sym]
    if (!pos) {
      return NextResponse.json({ error: `No open position for ${sym}` }, { status: 404 })
    }

    // Fetch current real price (Kraken → KuCoin fallback)
    const KRAKEN_PAIRS: Record<string, string> = {
      SOL: 'SOLUSD', BTC: 'XBTUSD', ETH: 'ETHUSD', BNB: 'BNBUSD',
      XRP: 'XRPUSD', AVAX: 'AVAXUSD', LINK: 'LINKUSD',
    }
    const KUCOIN_PAIRS: Record<string, string> = {
      JUP: 'JUP-USDT', WIF: 'WIF-USDT', BONK: 'BONK-USDT',
      JTO: 'JTO-USDT', PYTH: 'PYTH-USDT', RAY: 'RAY-USDT',
    }

    let currentPrice: number | null = null

    if (KRAKEN_PAIRS[sym]) {
      try {
        const res = await fetch(
          `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS[sym]}`,
          { signal: AbortSignal.timeout(6000) }
        )
        if (res.ok) {
          const data = await res.json()
          const key = Object.keys(data.result || {})[0]
          if (key) currentPrice = parseFloat(data.result[key].c[0])
        }
      } catch {}
    }

    if (!currentPrice && KUCOIN_PAIRS[sym]) {
      try {
        const res = await fetch(
          `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${KUCOIN_PAIRS[sym]}`,
          { signal: AbortSignal.timeout(6000) }
        )
        if (res.ok) {
          const data = await res.json()
          if (data.data?.price) currentPrice = parseFloat(data.data.price)
        }
      } catch {}
    }

    if (!currentPrice) {
      return NextResponse.json({ error: 'Could not fetch current price' }, { status: 500 })
    }

    // Calculate P&L
    const isLong = pos.side === 'LONG'
    const pnl = isLong
      ? (currentPrice - pos.avg) * pos.qty
      : (pos.avg - currentPrice) * pos.qty
    const pct = (pnl / pos.size) * 100

    // Remove position, update cash/equity
    const newPositions = { ...positions }
    delete newPositions[sym]

    const closeValue = isLong
      ? currentPrice * pos.qty
      : pos.size + pnl // return collateral + pnl for short

    const newCash = (state.cash || 0) + closeValue
    const newEquity = newCash +
      Object.entries(newPositions).reduce((sum: number, [, p]: [string, any]) => {
        return sum + (p.qty * p.avg) // approximate
      }, 0)

    await supabase
      .from('kymia_agent_state')
      .update({
        positions: newPositions,
        cash:      parseFloat(newCash.toFixed(2)),
        equity:    parseFloat(newEquity.toFixed(2)),
      })
      .eq('user_id', userId)

    // Record the trade
    await supabase.from('kymia_trades').insert({
      user_id:   userId,
      sym,
      side:      pos.side,
      entry:     pos.avg,
      exit:      currentPrice,
      pnl:       parseFloat(pnl.toFixed(2)),
      pct:       parseFloat(pct.toFixed(2)),
      agent:     pos.agent || 'HYBRID',
      opened_at: pos.openedAt,
      closed_at: new Date().toISOString(),
    })

    console.log(`[MANUAL CLOSE] ${sym} ${pos.side} @ $${currentPrice} | PnL: $${pnl.toFixed(2)} (${pct.toFixed(2)}%) — user requested`)

    return NextResponse.json({
      ok:        true,
      sym,
      exitPrice: currentPrice,
      pnl:       parseFloat(pnl.toFixed(2)),
      pct:       parseFloat(pct.toFixed(2)),
    })

  } catch (e: any) {
    console.error('[manual-close] Error:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
