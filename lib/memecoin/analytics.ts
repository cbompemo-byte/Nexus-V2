// lib/memecoin/analytics.ts
// Usage : npx tsx lib/memecoin/analytics.ts
//
// Phase 1 — MFE / MAE / Profit-retention sur les trades fermés
// Phase 3 — A/B/C backtest : V1 (trailing 22%) vs V2-A / V2-B / V2-C
//
// ⚠️  BACKTEST OPTIMISTE — Avertissement explicite :
//     high_since_entry est un ratchet 5min. On connaît le MFE final
//     mais PAS la trajectoire intermédiaire. Un trailing dynamique large
//     (V2-B/V2-C) peut avoir survécu des creux de 30–40% invisibles ici.
//     Ce backtest calcule l'exit DEPUIS LE HIGH FINAL = plafond théorique,
//     pas promesse de performance. Le shadow temps réel (Phase 2) est le
//     seul juge fiable de la différence V1 vs V2.
//
// Seuls les trades avec high_since_entry non-null sont inclus (58/72).
// Les 14 trades sans high_since_entry sont signalés mais exclus.

import { createClient } from '@supabase/supabase-js'
import { trailDistA, trailDistB, trailDistC } from './shadow'

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL      ?? ''
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY     ?? ''
const PAPER_SIZE        = 4      // USDC fictifs, en sync avec paper.ts
const TRAILING_V1       = 0.22   // TRAILING_PCT actuel

// TP ladder — doit rester en sync avec paper.ts
const TP1_FACTOR = 1.25
const TP2_FACTOR = 1.50
const TP3_FACTOR = 2.00

// PnL fixe des partials TP1/TP2/TP3 (indépendant du prix d'exit final)
const PNL_TP1 = (TP1_FACTOR - 1) * PAPER_SIZE * 0.25   // 0.25 USDC
const PNL_TP2 = (TP2_FACTOR - 1) * PAPER_SIZE * 0.25   // 0.50 USDC
const PNL_TP3 = (TP3_FACTOR - 1) * PAPER_SIZE * 0.25   // 1.00 USDC

// ── Types ─────────────────────────────────────────────────────────────────────

interface Trade {
  id:                    string
  symbol:                string
  entry_price:           number
  high_since_entry:      number | null
  pnl_realised:          number
  status:                string
  opened_at:             string
  closed_at:             string
  tp1_hit:               boolean
  tp2_hit:               boolean
  tp3_hit:               boolean
  qty_remaining:         number   // qty au moment de la fermeture V1
}

interface TradeMetrics {
  symbol:       string
  status:       string
  mfe_pct:      number | 'DATA_UNAVAILABLE'
  mae_pct:      number | 'DATA_UNAVAILABLE'
  retention:    number | 'DATA_UNAVAILABLE'
  pnl_v1:       number
  pnl_v2a:      number | 'NO_CHANGE'
  pnl_v2b:      number | 'NO_CHANGE'
  pnl_v2c:      number | 'NO_CHANGE'
  v2a_trail:    number | null
  v2b_trail:    number | null
  v2c_trail:    number | null
  held_days:    number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%'
}

function usdc(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(4) + ' USDC'
}

/**
 * Calcule le PnL total V2 pour une variante donnée.
 *
 * Pour les trades qui n'ont pas atteint le seuil d'activation de la variante,
 * retourne 'NO_CHANGE' (même résultat que V1 — pas de double-comptage).
 *
 * Pour les trades qui ont atteint le seuil :
 *   - TP1/TP2/TP3 partials identiques à V1
 *   - TP4 (derniers 25%) : exit au high × (1 - trail_dist)
 *   - Si la variante active avant TP3 (V2-C sur les +30–50%), on suppose
 *     que la sortie dynamique remplace TP3+TP4 (le trailing gère le reste
 *     de qty en cours au moment de l'activation).
 *
 * HYPOTHÈSE SIMPLIFIÉE pour V2-C (activation précoce, avant TP3) :
 *   Si le trailing V2-C se serait déclenché avant TP3 :
 *   On compare la sortie V2-C vs V1 sur la qty encore en main à ce stade.
 *   On ne peut pas reconstruire exactement quelle qty était restante sans
 *   la trajectoire complète → on utilise la qty fermée par V1 comme proxy.
 */
function computeV2Pnl(
  t:      Trade,
  mfe:    number,
  distFn: (r: number) => number | null,
): { pnl: number; trail: number } | 'NO_CHANGE' {
  if (!mfe) return 'NO_CHANGE'

  const entry    = t.entry_price
  const mfeRatio = mfe / entry
  const dist     = distFn(mfeRatio)

  if (dist === null) return 'NO_CHANGE'   // variante pas activée sur ce trade

  // Prix de sortie sous la variante (depuis le high final — optimiste)
  const v2ExitPrice = mfe * (1 - dist)

  // Reconstruction du PnL partials V1 (commun à toutes les variantes)
  let partialsPnl = 0
  let qtyAfterPartials = 1.0

  if (t.tp1_hit) { partialsPnl += PNL_TP1; qtyAfterPartials -= 0.25 }
  if (t.tp2_hit) { partialsPnl += PNL_TP2; qtyAfterPartials -= 0.25 }
  if (t.tp3_hit) { partialsPnl += PNL_TP3; qtyAfterPartials -= 0.25 }

  // Activation de la variante : si elle se déclenche à un stade où V1
  // n'a pas encore fait de partiels (ex V2-C à +35%), la qty restante
  // est celle avant le premier partial non encore atteint.
  //
  // Simplification : on utilise qtyAfterPartials (qty après les partials
  // de V1 réellement frappés, stockés dans tp1/tp2/tp3_hit).
  // Pour V2-C sur un trade +40% (tp1 non hit) : qty = 1.0 entière.

  const finalPnl = partialsPnl + (v2ExitPrice - entry) / entry * PAPER_SIZE * qtyAfterPartials

  return { pnl: finalPnl, trail: dist }
}

// ── Phase 1 report ────────────────────────────────────────────────────────────

function printPhase1(metrics: TradeMetrics[]): void {
  console.log('\n' + '═'.repeat(72))
  console.log('PHASE 1 — MFE / MAE / PROFIT RETENTION  (baseline V1)')
  console.log('═'.repeat(72))
  console.log(
    '⚠️  MAE = DATA_UNAVAILABLE pour la plupart des trades (low_since_entry\n' +
    '   non tracké avant ce déploiement). Exception : SL_HIT → MAE ≈ -15%.\n' +
    '   Colonne low_since_entry désormais active pour les futurs trades.\n'
  )

  const withMfe = metrics.filter(m => m.mfe_pct !== 'DATA_UNAVAILABLE') as
    (Omit<TradeMetrics, 'mfe_pct' | 'retention'> & { mfe_pct: number; retention: number | 'DATA_UNAVAILABLE' })[]

  if (!withMfe.length) {
    console.log('  Aucun trade avec high_since_entry.')
    return
  }

  // Tri par MFE décroissant
  const sorted = [...withMfe].sort((a, b) => b.mfe_pct - a.mfe_pct)

  console.log(
    'Symbol'.padEnd(10) + 'Status'.padEnd(20) +
    'MFE'.padEnd(10) + 'MAE'.padEnd(20) +
    'Retention'.padEnd(12) + 'V1 PnL'
  )
  console.log('─'.repeat(80))

  for (const m of sorted) {
    const maeStr = m.mae_pct === 'DATA_UNAVAILABLE' ? 'n/a' : pct(m.mae_pct as number)
    const retStr = m.retention === 'DATA_UNAVAILABLE' ? 'n/a' : (m.retention as number).toFixed(2)
    console.log(
      m.symbol.padEnd(10) +
      m.status.padEnd(20) +
      pct(m.mfe_pct).padEnd(10) +
      maeStr.padEnd(20) +
      retStr.padEnd(12) +
      usdc(m.pnl_v1)
    )
  }

  // Aggregates
  const mfes      = withMfe.map(m => m.mfe_pct)
  const rets      = withMfe.filter(m => m.retention !== 'DATA_UNAVAILABLE').map(m => m.retention as number)
  const avgMfe    = mfes.reduce((a, b) => a + b, 0) / mfes.length
  const medMfe    = [...mfes].sort((a, b) => a - b)[Math.floor(mfes.length / 2)]
  const avgRet    = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null

  console.log('─'.repeat(80))
  console.log(`\n  Trades analysés : ${withMfe.length}`)
  console.log(`  MFE moyen       : ${pct(avgMfe)}`)
  console.log(`  MFE médian      : ${pct(medMfe)}`)
  console.log(`  MFE max         : ${pct(Math.max(...mfes))}`)
  console.log(`  MFE min         : ${pct(Math.min(...mfes))}`)
  if (avgRet !== null) {
    console.log(`  Retention moy.  : ${(avgRet * 100).toFixed(1)}%  (PnL capturé / MFE théorique)`)
    console.log(`  Profit laissé   : ${((1 - avgRet) * 100).toFixed(1)}% du MFE en moyenne`)
  }
}

// ── Phase 3 report ────────────────────────────────────────────────────────────

function printPhase3(metrics: TradeMetrics[]): void {
  console.log('\n' + '═'.repeat(72))
  console.log('PHASE 3 — A/B/C BACKTEST  V1 vs V2-A vs V2-B vs V2-C')
  console.log('═'.repeat(72))
  console.log(
    '⚠️  RÉSULTATS OPTIMISTES — exit calculé depuis le high FINAL, pas depuis\n' +
    '   un creux intermédiaire. V2-B/V2-C larges survivent peut-être des dips\n' +
    '   de 20–35% invisibles ici. Shadow temps réel = juge définitif.\n'
  )

  // Séparation : trades affectés par au moins une variante vs non affectés
  const affected = metrics.filter(
    m => m.pnl_v2a !== 'NO_CHANGE' || m.pnl_v2b !== 'NO_CHANGE' || m.pnl_v2c !== 'NO_CHANGE'
  )
  const unchanged = metrics.length - affected.length

  console.log(
    `  Trades sans changement (variantes non activées) : ${unchanged}\n` +
    `  Trades avec au moins une variante différente     : ${affected.length}\n`
  )

  if (!affected.length) {
    console.log('  Aucun trade n\'a atteint les seuils d\'activation des variantes.')
    return
  }

  // Tableau détaillé des trades affectés
  console.log(
    'Symbol'.padEnd(10) +
    'V1'.padEnd(12) + 'V2-A'.padEnd(14) + 'V2-B'.padEnd(14) + 'V2-C'.padEnd(14) +
    'C_trail%' + '  MFE'
  )
  console.log('─'.repeat(90))

  const byMfe = [...affected].sort((a, b) => {
    const am = a.mfe_pct === 'DATA_UNAVAILABLE' ? 0 : a.mfe_pct as number
    const bm = b.mfe_pct === 'DATA_UNAVAILABLE' ? 0 : b.mfe_pct as number
    return bm - am
  })

  for (const m of byMfe) {
    const v1  = usdc(m.pnl_v1)
    const v2a = m.pnl_v2a === 'NO_CHANGE' ? '═' : delta(m.pnl_v1, m.pnl_v2a as number)
    const v2b = m.pnl_v2b === 'NO_CHANGE' ? '═' : delta(m.pnl_v1, m.pnl_v2b as number)
    const v2c = m.pnl_v2c === 'NO_CHANGE' ? '═' : delta(m.pnl_v1, m.pnl_v2c as number)
    const cTrail = m.v2c_trail !== null ? `${(m.v2c_trail * 100).toFixed(0)}%` : '—'
    const mfeStr = m.mfe_pct === 'DATA_UNAVAILABLE' ? 'n/a' : pct(m.mfe_pct as number)

    console.log(
      m.symbol.padEnd(10) +
      v1.padEnd(12) +
      v2a.padEnd(14) + v2b.padEnd(14) + v2c.padEnd(14) +
      cTrail.padEnd(10) + mfeStr
    )
  }

  // ── Totaux par variante ────────────────────────────────────────────────────

  type VariantKey = 'v2a' | 'v2b' | 'v2c'
  const variants: { key: VariantKey; label: string; distFn: (r: number) => number | null }[] = [
    { key: 'v2a', label: 'V2-A (wide ≥TP2)', distFn: trailDistA },
    { key: 'v2b', label: 'V2-B (très large ≥TP3)', distFn: trailDistB },
    { key: 'v2c', label: 'V2-C (précoce ≥+30%)', distFn: trailDistC },
  ]

  console.log('\n' + '─'.repeat(72))
  console.log('RÉSUMÉ GLOBAL (tous les 58 trades, variantes affectées + inchangées)\n')

  // Total V1
  const totalV1 = metrics.reduce((s, m) => s + m.pnl_v1, 0)
  console.log(`  V1 (référence)           : ${usdc(totalV1)}  sur ${metrics.length} trades`)

  for (const v of variants) {
    const pnlKey = `pnl_${v.key}` as keyof TradeMetrics
    const total = metrics.reduce((s, m) => {
      const p = m[pnlKey]
      return s + (p === 'NO_CHANGE' ? m.pnl_v1 : p as number)
    }, 0)
    const diff  = total - totalV1
    const nBetter = affected.filter(m => {
      const p = m[pnlKey]
      return p !== 'NO_CHANGE' && (p as number) > m.pnl_v1 + 0.0001
    }).length
    const nWorse = affected.filter(m => {
      const p = m[pnlKey]
      return p !== 'NO_CHANGE' && (p as number) < m.pnl_v1 - 0.0001
    }).length
    console.log(
      `  ${v.label.padEnd(25)}: ${usdc(total)}  (${diff >= 0 ? '+' : ''}${diff.toFixed(4)} vs V1)` +
      `  ↑${nBetter} améliorés  ↓${nWorse} dégradés`
    )
  }

  // ── Focus gros gagnants ────────────────────────────────────────────────────
  const bigWinners = metrics.filter(m =>
    m.mfe_pct !== 'DATA_UNAVAILABLE' && (m.mfe_pct as number) >= 2.0 // MFE ≥ +200%
  )
  if (bigWinners.length) {
    console.log(`\n  — Gros gagnants (MFE ≥ +200%, n=${bigWinners.length}) —`)
    console.log('  (ceux que les variantes larges ne doivent PAS couper plus tôt)\n')

    console.log(
      'Symbol'.padEnd(10) + 'MFE'.padEnd(10) +
      'V1'.padEnd(12) + 'V2-A'.padEnd(12) + 'V2-B'.padEnd(12) + 'V2-C'
    )
    console.log('  ' + '─'.repeat(64))

    for (const m of bigWinners.sort((a, b) => (b.mfe_pct as number) - (a.mfe_pct as number))) {
      const v1  = usdc(m.pnl_v1)
      const v2a = m.pnl_v2a === 'NO_CHANGE' ? '═' : usdc(m.pnl_v2a as number)
      const v2b = m.pnl_v2b === 'NO_CHANGE' ? '═' : usdc(m.pnl_v2b as number)
      const v2c = m.pnl_v2c === 'NO_CHANGE' ? '═' : usdc(m.pnl_v2c as number)
      console.log(
        `  ${m.symbol.padEnd(10)}${pct(m.mfe_pct as number).padEnd(10)}` +
        `${v1.padEnd(12)}${v2a.padEnd(12)}${v2b.padEnd(12)}${v2c}`
      )
    }
  }

  // ── Focus medium winners : les +30–100% perdus (LA question du module) ────
  const mediumWinners = metrics.filter(m =>
    m.mfe_pct !== 'DATA_UNAVAILABLE' &&
    (m.mfe_pct as number) >= 0.30 &&
    (m.mfe_pct as number) < 2.0
  )
  if (mediumWinners.length) {
    console.log(`\n  — Medium winners MFE +30–200% (n=${mediumWinners.length}) —`)
    console.log('  (V2-C cible spécifiquement cette zone)\n')

    const v1Sum  = mediumWinners.reduce((s, m) => s + m.pnl_v1, 0)
    const vcSum  = mediumWinners.reduce((s, m) =>
      s + (m.pnl_v2c === 'NO_CHANGE' ? m.pnl_v1 : m.pnl_v2c as number), 0)
    const vaSum  = mediumWinners.reduce((s, m) =>
      s + (m.pnl_v2a === 'NO_CHANGE' ? m.pnl_v1 : m.pnl_v2a as number), 0)

    console.log(`    V1 total   : ${usdc(v1Sum)}`)
    console.log(`    V2-A total : ${usdc(vaSum)}  (${(vaSum - v1Sum >= 0 ? '+' : '')}${(vaSum - v1Sum).toFixed(4)})`)
    console.log(`    V2-C total : ${usdc(vcSum)}  (${(vcSum - v1Sum >= 0 ? '+' : '')}${(vcSum - v1Sum).toFixed(4)})`)
    console.log()

    for (const m of mediumWinners.sort((a, b) => (b.mfe_pct as number) - (a.mfe_pct as number))) {
      const v1  = usdc(m.pnl_v1)
      const v2c = m.pnl_v2c === 'NO_CHANGE' ? '═ (SL)' : usdc(m.pnl_v2c as number)
      const mfeStr = pct(m.mfe_pct as number)
      console.log(`    ${m.symbol.padEnd(10)} MFE ${mfeStr.padEnd(10)} V1=${v1.padEnd(14)} V2-C=${v2c}`)
    }
  }
}

function delta(v1: number, v2: number): string {
  const diff = v2 - v1
  return usdc(v2) + (diff >= 0 ? ' ↑' : ' ↓')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants.')
    console.error('Lance : NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx lib/memecoin/analytics.ts')
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

  // Tous les trades fermés
  const { data, error } = await supabase
    .from('kymia_memecoin_paper')
    .select('id,symbol,entry_price,high_since_entry,pnl_realised,status,opened_at,closed_at,tp1_hit,tp2_hit,tp3_hit,qty_remaining')
    .not('closed_at', 'is', null)
    .order('opened_at', { ascending: true })

  if (error) { console.error('Supabase error:', error.message); process.exit(1) }
  if (!data?.length) { console.log('Aucun trade fermé en base.'); return }

  const allTrades = data as Trade[]
  const withHigh  = allTrades.filter(t => t.high_since_entry !== null)
  const noHigh    = allTrades.filter(t => t.high_since_entry === null)

  console.log(`\nTrades fermés total : ${allTrades.length}`)
  console.log(`Avec high_since_entry : ${withHigh.length}  (backtest sur ces ${withHigh.length})`)
  if (noHigh.length) {
    console.log(`Sans high_since_entry : ${noHigh.length}  (exclus — ${noHigh.map(t => t.symbol).join(', ')})`)
  }

  // ── Calcul des métriques par trade ─────────────────────────────────────────

  const metrics: TradeMetrics[] = withHigh.map(t => {
    const entry = t.entry_price
    const high  = t.high_since_entry!

    // MFE
    const mfe_pct = (high - entry) / entry

    // MAE — approximation uniquement
    let mae_pct: number | 'DATA_UNAVAILABLE' = 'DATA_UNAVAILABLE'
    if (t.status === 'SL_HIT') mae_pct = -0.15   // SL à -15%
    // TIME_STOP : on ne sait pas le min atteint avant sortie à 48h → n/a

    // Retention : pnl_realised / (mfe_pct × PAPER_SIZE)
    const theoreticalMax = mfe_pct * PAPER_SIZE
    const retention: number | 'DATA_UNAVAILABLE' =
      theoreticalMax > 0.001
        ? t.pnl_realised / theoreticalMax
        : 'DATA_UNAVAILABLE'

    // Durée
    const held_days = (new Date(t.closed_at).getTime() - new Date(t.opened_at).getTime()) / 86_400_000

    // V2 PnLs
    const v2aRes = computeV2Pnl(t, high, trailDistA)
    const v2bRes = computeV2Pnl(t, high, trailDistB)
    const v2cRes = computeV2Pnl(t, high, trailDistC)

    return {
      symbol:    t.symbol,
      status:    t.status,
      mfe_pct,
      mae_pct,
      retention,
      pnl_v1:   t.pnl_realised,
      pnl_v2a:  v2aRes === 'NO_CHANGE' ? 'NO_CHANGE' : v2aRes.pnl,
      pnl_v2b:  v2bRes === 'NO_CHANGE' ? 'NO_CHANGE' : v2bRes.pnl,
      pnl_v2c:  v2cRes === 'NO_CHANGE' ? 'NO_CHANGE' : v2cRes.pnl,
      v2a_trail: v2aRes === 'NO_CHANGE' ? null : v2aRes.trail,
      v2b_trail: v2bRes === 'NO_CHANGE' ? null : v2bRes.trail,
      v2c_trail: v2cRes === 'NO_CHANGE' ? null : v2cRes.trail,
      held_days,
    }
  })

  printPhase1(metrics)
  printPhase3(metrics)

  console.log('\n' + '═'.repeat(72))
  console.log('Shadow temps réel (Phase 2) : actif au prochain cycle.')
  console.log('Colonnes shadow_v2a/b/c_fired_at visibles dans kymia_memecoin_paper.')
  console.log('═'.repeat(72) + '\n')
}

main().catch(e => { console.error(e); process.exit(1) })
