// app/api/admin/memecoin-backtest/route.ts
// Phase 1 (MFE/MAE/retention) + Phase 3 (V1 vs V2-A/B/C backtest)
// Protégée par KYMIA_ADMIN_KEY — passer via header x-admin-key ou ?key=
//
// ⚠️  BACKTEST OPTIMISTE — high_since_entry est un ratchet 5-min.
//     Exit calculé depuis le HIGH FINAL, pas depuis un creux intermédiaire.
//     V2-B/V2-C larges peuvent avoir survécu des dips de 20–40% invisibles.
//     Shadow temps réel (Phase 2) = seul juge fiable.

export const dynamic = 'force-dynamic'
// runtime: nodejs (défaut) — accès Supabase complet, pas edge

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { trailDistA, trailDistB, trailDistC } from '@/lib/memecoin/shadow'

// ── Constantes — en sync avec paper.ts / analytics.ts ─────────────────────────

const PAPER_SIZE   = 4
const TP1_FACTOR   = 1.25
const TP2_FACTOR   = 1.50
const TP3_FACTOR   = 2.00
const PNL_TP1      = (TP1_FACTOR - 1) * PAPER_SIZE * 0.25   // 0.25 USDC
const PNL_TP2      = (TP2_FACTOR - 1) * PAPER_SIZE * 0.25   // 0.50 USDC
const PNL_TP3      = (TP3_FACTOR - 1) * PAPER_SIZE * 0.25   // 1.00 USDC

// ── Types ─────────────────────────────────────────────────────────────────────

interface Trade {
  id:               string
  symbol:           string
  entry_price:      number
  high_since_entry: number | null
  pnl_realised:     number
  status:           string
  opened_at:        string
  closed_at:        string
  tp1_hit:          boolean
  tp2_hit:          boolean
  tp3_hit:          boolean
  qty_remaining:    number
}

interface TradeMetrics {
  symbol:    string
  status:    string
  mfe_pct:   number | null   // null = DATA_UNAVAILABLE
  mae_pct:   number | null
  retention: number | null
  pnl_v1:    number
  pnl_v2a:   number | null   // null = NO_CHANGE (variante non activée)
  pnl_v2b:   number | null
  pnl_v2c:   number | null
  v2a_trail: number | null
  v2b_trail: number | null
  v2c_trail: number | null
  held_days: number
}

// ── Helper — PnL V2 pour une variante ─────────────────────────────────────────

function computeV2Pnl(
  t:      Trade,
  mfe:    number,
  distFn: (r: number) => number | null,
): { pnl: number; trail: number } | null {
  const entry    = t.entry_price
  const mfeRatio = mfe / entry
  const dist     = distFn(mfeRatio)
  if (dist === null) return null

  const v2ExitPrice = mfe * (1 - dist)

  let partialsPnl      = 0
  let qtyAfterPartials = 1.0
  if (t.tp1_hit) { partialsPnl += PNL_TP1; qtyAfterPartials -= 0.25 }
  if (t.tp2_hit) { partialsPnl += PNL_TP2; qtyAfterPartials -= 0.25 }
  if (t.tp3_hit) { partialsPnl += PNL_TP3; qtyAfterPartials -= 0.25 }

  const finalPnl = partialsPnl + (v2ExitPrice - entry) / entry * PAPER_SIZE * qtyAfterPartials
  return { pnl: finalPnl, trail: dist }
}

// ── Phase 1 ───────────────────────────────────────────────────────────────────

function buildPhase1(metrics: TradeMetrics[]) {
  const withMfe = metrics.filter(m => m.mfe_pct !== null) as (TradeMetrics & { mfe_pct: number })[]
  if (!withMfe.length) return { warning: 'Aucun trade avec high_since_entry', trades: [] }

  const sorted = [...withMfe].sort((a, b) => b.mfe_pct - a.mfe_pct)

  const mfes   = withMfe.map(m => m.mfe_pct)
  const rets   = withMfe.filter(m => m.retention !== null).map(m => m.retention as number)
  const avgMfe = mfes.reduce((a, b) => a + b, 0) / mfes.length
  const medIdx = Math.floor(mfes.length / 2)
  const medMfe = [...mfes].sort((a, b) => a - b)[medIdx]
  const avgRet = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null

  return {
    warning: 'MAE = null pour la majorité des trades (low_since_entry non tracké avant ce déploiement). Exception : SL_HIT → MAE ≈ -15%.',
    count:   withMfe.length,
    aggregates: {
      mfe_avg:        round2(avgMfe * 100),
      mfe_median:     round2(medMfe * 100),
      mfe_max:        round2(Math.max(...mfes) * 100),
      mfe_min:        round2(Math.min(...mfes) * 100),
      retention_avg:  avgRet !== null ? round2(avgRet * 100) : null,
      profit_left_pct: avgRet !== null ? round2((1 - avgRet) * 100) : null,
    },
    trades: sorted.map(m => ({
      symbol:    m.symbol,
      status:    m.status,
      mfe_pct:   round2(m.mfe_pct * 100),
      mae_pct:   m.mae_pct !== null ? round2(m.mae_pct * 100) : null,
      retention: m.retention !== null ? round4(m.retention) : null,
      pnl_v1:    round4(m.pnl_v1),
      held_days: round2(m.held_days),
    })),
  }
}

// ── Phase 3 ───────────────────────────────────────────────────────────────────

function buildPhase3(metrics: TradeMetrics[]) {
  const affected = metrics.filter(
    m => m.pnl_v2a !== null || m.pnl_v2b !== null || m.pnl_v2c !== null
  )
  const unchanged = metrics.length - affected.length

  const totalV1 = metrics.reduce((s, m) => s + m.pnl_v1, 0)

  function variantTotal(key: 'pnl_v2a' | 'pnl_v2b' | 'pnl_v2c') {
    return metrics.reduce((s, m) => s + (m[key] !== null ? (m[key] as number) : m.pnl_v1), 0)
  }

  function countBetter(key: 'pnl_v2a' | 'pnl_v2b' | 'pnl_v2c') {
    return affected.filter(m => m[key] !== null && (m[key] as number) > m.pnl_v1 + 0.0001).length
  }
  function countWorse(key: 'pnl_v2a' | 'pnl_v2b' | 'pnl_v2c') {
    return affected.filter(m => m[key] !== null && (m[key] as number) < m.pnl_v1 - 0.0001).length
  }

  const totA = variantTotal('pnl_v2a')
  const totB = variantTotal('pnl_v2b')
  const totC = variantTotal('pnl_v2c')

  // Big winners MFE ≥ +200%
  const bigWinners = metrics
    .filter(m => m.mfe_pct !== null && m.mfe_pct >= 2.0)
    .sort((a, b) => (b.mfe_pct as number) - (a.mfe_pct as number))

  // Medium winners +30–200%
  const mediumWinners = metrics
    .filter(m => m.mfe_pct !== null && m.mfe_pct >= 0.30 && m.mfe_pct < 2.0)
    .sort((a, b) => (b.mfe_pct as number) - (a.mfe_pct as number))

  const medV1  = mediumWinners.reduce((s, m) => s + m.pnl_v1, 0)
  const medVA  = mediumWinners.reduce((s, m) => s + (m.pnl_v2a !== null ? m.pnl_v2a : m.pnl_v1), 0)
  const medVC  = mediumWinners.reduce((s, m) => s + (m.pnl_v2c !== null ? m.pnl_v2c : m.pnl_v1), 0)

  return {
    backtest_warning: 'RÉSULTATS OPTIMISTES — exit calculé depuis le high FINAL, pas depuis un creux intermédiaire. Shadow temps réel (Phase 2) = juge définitif.',
    summary: {
      total_trades:          metrics.length,
      trades_unchanged:      unchanged,
      trades_affected:       affected.length,
      v1_total_pnl:          round4(totalV1),
      v2a: {
        label:          'V2-A (wide, activation ≥ +50%)',
        total_pnl:      round4(totA),
        delta_vs_v1:    round4(totA - totalV1),
        trades_better:  countBetter('pnl_v2a'),
        trades_worse:   countWorse('pnl_v2a'),
      },
      v2b: {
        label:          'V2-B (très large, activation ≥ +100%)',
        total_pnl:      round4(totB),
        delta_vs_v1:    round4(totB - totalV1),
        trades_better:  countBetter('pnl_v2b'),
        trades_worse:   countWorse('pnl_v2b'),
      },
      v2c: {
        label:          'V2-C (précoce, activation ≥ +30%)',
        total_pnl:      round4(totC),
        delta_vs_v1:    round4(totC - totalV1),
        trades_better:  countBetter('pnl_v2c'),
        trades_worse:   countWorse('pnl_v2c'),
      },
    },
    affected_trades: affected
      .sort((a, b) => ((b.mfe_pct ?? 0) - (a.mfe_pct ?? 0)))
      .map(m => ({
        symbol:    m.symbol,
        status:    m.status,
        mfe_pct:   m.mfe_pct !== null ? round2(m.mfe_pct * 100) : null,
        pnl_v1:    round4(m.pnl_v1),
        pnl_v2a:   m.pnl_v2a !== null ? round4(m.pnl_v2a) : 'NO_CHANGE',
        pnl_v2b:   m.pnl_v2b !== null ? round4(m.pnl_v2b) : 'NO_CHANGE',
        pnl_v2c:   m.pnl_v2c !== null ? round4(m.pnl_v2c) : 'NO_CHANGE',
        v2a_trail_pct: m.v2a_trail !== null ? round2(m.v2a_trail * 100) : null,
        v2b_trail_pct: m.v2b_trail !== null ? round2(m.v2b_trail * 100) : null,
        v2c_trail_pct: m.v2c_trail !== null ? round2(m.v2c_trail * 100) : null,
        delta_v2a: m.pnl_v2a !== null ? round4(m.pnl_v2a - m.pnl_v1) : null,
        delta_v2b: m.pnl_v2b !== null ? round4(m.pnl_v2b - m.pnl_v1) : null,
        delta_v2c: m.pnl_v2c !== null ? round4(m.pnl_v2c - m.pnl_v1) : null,
      })),
    big_winners_mfe_ge_200pct: {
      count: bigWinners.length,
      note:  'Ceux que les variantes larges ne doivent PAS couper plus tôt',
      trades: bigWinners.map(m => ({
        symbol:  m.symbol,
        mfe_pct: round2((m.mfe_pct as number) * 100),
        pnl_v1:  round4(m.pnl_v1),
        pnl_v2a: m.pnl_v2a !== null ? round4(m.pnl_v2a) : 'NO_CHANGE',
        pnl_v2b: m.pnl_v2b !== null ? round4(m.pnl_v2b) : 'NO_CHANGE',
        pnl_v2c: m.pnl_v2c !== null ? round4(m.pnl_v2c) : 'NO_CHANGE',
      })),
    },
    medium_winners_mfe_30_to_200pct: {
      count:         mediumWinners.length,
      note:          'V2-C cible spécifiquement cette zone (+30–200%)',
      v1_total:      round4(medV1),
      v2a_total:     round4(medVA),
      v2a_delta:     round4(medVA - medV1),
      v2c_total:     round4(medVC),
      v2c_delta:     round4(medVC - medV1),
      trades: mediumWinners.map(m => ({
        symbol:  m.symbol,
        mfe_pct: round2((m.mfe_pct as number) * 100),
        pnl_v1:  round4(m.pnl_v1),
        pnl_v2c: m.pnl_v2c !== null ? round4(m.pnl_v2c) : 'NO_CHANGE',
        delta_v2c: m.pnl_v2c !== null ? round4(m.pnl_v2c - m.pnl_v1) : null,
      })),
    },
  }
}

// ── Rounding helpers ──────────────────────────────────────────────────────────

function round2(n: number) { return Math.round(n * 100) / 100 }
function round4(n: number) { return Math.round(n * 10000) / 10000 }

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // Auth — x-admin-key header ou ?key= query param
  const adminKey = process.env.KYMIA_ADMIN_KEY
  if (!adminKey) {
    return NextResponse.json({ error: 'KYMIA_ADMIN_KEY not configured on server' }, { status: 500 })
  }
  const provided =
    req.headers.get('x-admin-key') ??
    req.nextUrl.searchParams.get('key')
  if (provided !== adminKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Supabase — service role key obligatoire
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase env vars missing' }, { status: 500 })
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  const { data, error } = await supabase
    .from('kymia_memecoin_paper')
    .select('id,symbol,entry_price,high_since_entry,pnl_realised,status,opened_at,closed_at,tp1_hit,tp2_hit,tp3_hit,qty_remaining')
    .not('closed_at', 'is', null)
    .order('opened_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: 'Supabase query failed', detail: error.message }, { status: 500 })
  }

  if (!data?.length) {
    return NextResponse.json({ message: 'Aucun trade fermé en base.' })
  }

  const allTrades  = data as Trade[]
  const withHigh   = allTrades.filter(t => t.high_since_entry !== null)
  const noHighList = allTrades.filter(t => t.high_since_entry === null).map(t => t.symbol)

  // ── Calcul des métriques ───────────────────────────────────────────────────

  const metrics: TradeMetrics[] = withHigh.map(t => {
    const entry = t.entry_price
    const high  = t.high_since_entry!
    const mfe_pct = (high - entry) / entry

    const mae_pct: number | null = t.status === 'SL_HIT' ? -0.15 : null

    const theoreticalMax = mfe_pct * PAPER_SIZE
    const retention: number | null =
      theoreticalMax > 0.001 ? t.pnl_realised / theoreticalMax : null

    const held_days = (new Date(t.closed_at).getTime() - new Date(t.opened_at).getTime()) / 86_400_000

    const v2aRes = computeV2Pnl(t, high, trailDistA)
    const v2bRes = computeV2Pnl(t, high, trailDistB)
    const v2cRes = computeV2Pnl(t, high, trailDistC)

    return {
      symbol:    t.symbol,
      status:    t.status,
      mfe_pct,
      mae_pct,
      retention,
      pnl_v1:    t.pnl_realised,
      pnl_v2a:   v2aRes ? v2aRes.pnl  : null,
      pnl_v2b:   v2bRes ? v2bRes.pnl  : null,
      pnl_v2c:   v2cRes ? v2cRes.pnl  : null,
      v2a_trail: v2aRes ? v2aRes.trail : null,
      v2b_trail: v2bRes ? v2bRes.trail : null,
      v2c_trail: v2cRes ? v2cRes.trail : null,
      held_days,
    }
  })

  return NextResponse.json({
    generated_at:   new Date().toISOString(),
    trades_total:   allTrades.length,
    trades_with_mfe: withHigh.length,
    trades_excluded: noHighList.length,
    excluded_symbols: noHighList,
    phase1_mfe_mae_retention: buildPhase1(metrics),
    phase3_v1_vs_v2_backtest: buildPhase3(metrics),
  })
}
