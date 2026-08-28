// lib/memecoin/shadow.ts
// Shadows comparatifs — appelé à chaque cycle depuis runMemecoinsModule().
//
// ACTIF depuis 2026-08-29 :
//   V2-C est devenu la logique RÉELLE dans paper.ts — il n'est plus ici.
//   V1 est passé en SHADOW pour mesurer ce qu'aurait donné l'ancien trailing.
//   V2-A et V2-B restent en shadow (observation, zéro coût supplémentaire).
//
// Objectif dans 3 semaines : comparer V2-C réel (V2C_TRAIL_HIT) vs V1 shadow
// pour valider que le backtest ne mentait pas.
//
// ⚠️  LIMITE DE MODÈLE : shadow opère sur prix spot courant + trailing_high
//     ratcheté — pas de creux intermédiaires. Premier trigger = premier
//     cycle où la condition est vraie.

import { SupabaseClient } from '@supabase/supabase-js'

const PAPER_SIZE     = 4      // doit rester en sync avec paper.ts
const V1_TRAIL_DIST  = 0.22   // V1 legacy : trailing 22% après TP3

// ── Fonctions de distance trailing par variante ────────────────────────────────
// Exportées pour paper.ts (trailDistC est la logique ACTIVE) et analytics.ts.

/** V2-A  —  wide/patient : optimise les grands mouvements (≥ TP3) */
export function trailDistA(mfeRatio: number): number | null {
  if (mfeRatio < 1.50) return null   // < +50% : SL ladder inchangé
  if (mfeRatio < 2.00) return 0.15   // +50–100%  : 15%
  if (mfeRatio < 3.00) return 0.20   // +100–200% : 20%
  if (mfeRatio < 5.00) return 0.25   // +200–400% : 25%
  return 0.30                         // ≥ +400%   : 30%
}

/** V2-B  —  très large : laisse courir les CAGE/SAME, donne back plus sur median */
export function trailDistB(mfeRatio: number): number | null {
  if (mfeRatio < 2.00) return null   // < +100% : SL ladder inchangé
  if (mfeRatio < 3.00) return 0.22   // +100–200% : = V1
  if (mfeRatio < 5.00) return 0.30   // +200–400% : 30%
  return 0.40                         // ≥ +400%   : 40%
}

/** V2-C  —  activation précoce : ACTIF dans paper.ts depuis 2026-08-29.
 *  Exporté pour paper.ts et analytics.ts — plus calculé dans ce fichier. */
export function trailDistC(mfeRatio: number): number | null {
  if (mfeRatio < 1.30) return null   // < +30% : SL ladder inchangé
  if (mfeRatio < 1.60) return 0.18   // +30–60%  : 18%
  if (mfeRatio < 2.00) return 0.20   // +60–100% : 20%
  if (mfeRatio < 3.00) return 0.25   // +100–200% : 25%
  return 0.35                         // ≥ +200%  : 35%
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpenTrade {
  id:             string
  symbol:         string
  entry_price:    number
  trailing_high:  number
  qty_remaining:  number
  pnl_realised:   number
  tp3_hit:        boolean
  shadow_v1_fired_at:  string | null
  shadow_v2a_fired_at: string | null
  shadow_v2b_fired_at: string | null
  // shadow_v2c_fired_at : V2-C est maintenant actif dans paper.ts
}

interface ShadowResult {
  fired:     boolean
  exitPrice: number
  pnlUsdc:   number
  mfeRatio:  number
  trailDist: number
}

// ── computeShadow — shadow générique pour V2-A et V2-B ───────────────────────

function computeShadow(
  cur:      number,
  high:     number,
  entry:    number,
  qty:      number,
  pnlSoFar: number,
  distFn:   (r: number) => number | null,
): ShadowResult | null {
  const mfeRatio = high / entry
  const dist     = distFn(mfeRatio)
  if (dist === null) return null

  const shadowSl = high * (1 - dist)
  if (cur > shadowSl) return null

  const exitPrice = shadowSl
  const pnlUsdc   = pnlSoFar + (exitPrice - entry) / entry * PAPER_SIZE * qty
  return { fired: true, exitPrice, pnlUsdc, mfeRatio, trailDist: dist }
}

// ── computeV1Shadow — V1 legacy : trailing 22% après TP3 uniquement ──────────

function computeV1Shadow(
  cur:      number,
  high:     number,
  entry:    number,
  qty:      number,
  pnlSoFar: number,
  tp3Hit:   boolean,
): ShadowResult | null {
  if (!tp3Hit) return null            // V1 n'activait le trailing qu'après TP3

  const mfeRatio = high / entry
  const shadowSl = high * (1 - V1_TRAIL_DIST)
  if (cur > shadowSl) return null

  const exitPrice = shadowSl
  const pnlUsdc   = pnlSoFar + (exitPrice - entry) / entry * PAPER_SIZE * qty
  return { fired: true, exitPrice, pnlUsdc, mfeRatio, trailDist: V1_TRAIL_DIST }
}

// ── updateShadowTrailing — appelé à chaque cycle ──────────────────────────────

export async function updateShadowTrailing(supabase: SupabaseClient): Promise<void> {
  const cols = [
    'id', 'symbol', 'entry_price', 'trailing_high', 'qty_remaining',
    'pnl_realised', 'tp3_hit',
    'shadow_v1_fired_at', 'shadow_v2a_fired_at', 'shadow_v2b_fired_at',
  ].join(',')

  const { data: trades, error } = await supabase
    .from('kymia_memecoin_paper')
    .select(cols)
    .is('closed_at', null)

  if (error) {
    console.error('[shadow] query error:', error.message)
    return
  }
  if (!trades?.length) {
    console.log('[shadow] no open positions — skipping')
    return
  }

  console.log(`[shadow] evaluating ${trades.length} open position(s)`)

  for (const raw of trades as any[]) {
    const t: OpenTrade = {
      id:             raw.id,
      symbol:         raw.symbol,
      entry_price:    Number(raw.entry_price),
      trailing_high:  Number(raw.trailing_high ?? raw.entry_price),
      qty_remaining:  Number(raw.qty_remaining),
      pnl_realised:   Number(raw.pnl_realised),
      tp3_hit:        Boolean(raw.tp3_hit),
      shadow_v1_fired_at:  raw.shadow_v1_fired_at  ?? null,
      shadow_v2a_fired_at: raw.shadow_v2a_fired_at ?? null,
      shadow_v2b_fired_at: raw.shadow_v2b_fired_at ?? null,
    }

    // Prix courant depuis DB (mis à jour par updatePaperTrades chaque cycle)
    const { data: priceRow } = await supabase
      .from('kymia_memecoin_paper')
      .select('current_price')
      .eq('id', t.id)
      .maybeSingle()

    const high  = t.trailing_high
    const entry = t.entry_price
    const qty   = t.qty_remaining
    const pnl   = t.pnl_realised
    const cur   = priceRow ? Number((priceRow as any).current_price ?? high) : high
    if (cur <= 0) {
      console.log(`[shadow] ${t.symbol} cur=0 — skip`)
      continue
    }

    // ── Observabilité par position ─────────────────────────────────────────
    const mfeRatio = high / entry
    const mfePct   = ((mfeRatio - 1) * 100).toFixed(1)
    const dropPct  = high > 0 ? ((high - cur) / high * 100).toFixed(1) : '0.0'

    // Statuts pour le log
    const v1Status = (): string => {
      if (t.shadow_v1_fired_at)  return 'ALREADY_FIRED'
      if (!t.tp3_hit)            return 'NOT_ACTIVE(tp3=false)'
      const sl = high * (1 - V1_TRAIL_DIST)
      return cur <= sl
        ? `FIRE(cur=$${cur.toFixed(6)},SL=$${sl.toFixed(6)})`
        : `ACTIVE/NO_FIRE(dist=22%,drop=${dropPct}%,SL=$${sl.toFixed(6)})`
    }
    const variantStatus = (
      alreadyFired: boolean,
      distFn: (r: number) => number | null,
      label: string,
      minPct: string,
    ): string => {
      if (alreadyFired) return 'ALREADY_FIRED'
      const dist = distFn(mfeRatio)
      if (dist === null) return `NOT_ACTIVE(mfe<${minPct})`
      const sl = high * (1 - dist)
      return cur <= sl
        ? `FIRE(dist=${(dist*100).toFixed(0)}%,cur=$${cur.toFixed(6)},SL=$${sl.toFixed(6)})`
        : `ACTIVE/NO_FIRE(dist=${(dist*100).toFixed(0)}%,drop=${dropPct}%,SL=$${sl.toFixed(6)})`
    }

    console.log(
      `[shadow] ${t.symbol.padEnd(10)} mfe=+${mfePct}% cur=$${cur.toFixed(6)} high=$${high.toFixed(6)} drop=${dropPct}%` +
      ` | V1=${v1Status()}` +
      ` | V2-A=${variantStatus(!!t.shadow_v2a_fired_at, trailDistA, 'V2-A', '+50%')}` +
      ` | V2-B=${variantStatus(!!t.shadow_v2b_fired_at, trailDistB, 'V2-B', '+100%')}`
    )

    const now     = new Date().toISOString()
    const updates: Record<string, unknown> = {}

    // ── V1 shadow ─────────────────────────────────────────────────────────
    if (!t.shadow_v1_fired_at) {
      const res = computeV1Shadow(cur, high, entry, qty, pnl, t.tp3_hit)
      if (res) {
        updates.shadow_v1_fired_at   = now
        updates.shadow_v1_exit_price = parseFloat(res.exitPrice.toFixed(8))
        updates.shadow_v1_pnl_usdc   = parseFloat(res.pnlUsdc.toFixed(6))
        console.log(
          `[shadow] V1 FIRED ${t.symbol}` +
          ` | mfe=+${((res.mfeRatio - 1) * 100).toFixed(0)}%` +
          ` | trail=22%` +
          ` | exit=$${res.exitPrice.toFixed(6)}` +
          ` | pnl=${res.pnlUsdc >= 0 ? '+' : ''}${res.pnlUsdc.toFixed(4)} USDC`
        )
      }
    }

    // ── V2-A shadow ───────────────────────────────────────────────────────
    if (!t.shadow_v2a_fired_at) {
      const res = computeShadow(cur, high, entry, qty, pnl, trailDistA)
      if (res) {
        updates.shadow_v2a_fired_at  = now
        updates.shadow_v2a_exit_price = parseFloat(res.exitPrice.toFixed(8))
        updates.shadow_v2a_pnl_usdc  = parseFloat(res.pnlUsdc.toFixed(6))
        console.log(
          `[shadow] V2-A FIRED ${t.symbol}` +
          ` | mfe=+${((res.mfeRatio - 1) * 100).toFixed(0)}%` +
          ` | trail=${(res.trailDist * 100).toFixed(0)}%` +
          ` | exit=$${res.exitPrice.toFixed(6)}` +
          ` | pnl=${res.pnlUsdc >= 0 ? '+' : ''}${res.pnlUsdc.toFixed(4)} USDC`
        )
      }
    }

    // ── V2-B shadow ───────────────────────────────────────────────────────
    if (!t.shadow_v2b_fired_at) {
      const res = computeShadow(cur, high, entry, qty, pnl, trailDistB)
      if (res) {
        updates.shadow_v2b_fired_at  = now
        updates.shadow_v2b_exit_price = parseFloat(res.exitPrice.toFixed(8))
        updates.shadow_v2b_pnl_usdc  = parseFloat(res.pnlUsdc.toFixed(6))
        console.log(
          `[shadow] V2-B FIRED ${t.symbol}` +
          ` | mfe=+${((res.mfeRatio - 1) * 100).toFixed(0)}%` +
          ` | trail=${(res.trailDist * 100).toFixed(0)}%` +
          ` | exit=$${res.exitPrice.toFixed(6)}` +
          ` | pnl=${res.pnlUsdc >= 0 ? '+' : ''}${res.pnlUsdc.toFixed(4)} USDC`
        )
      }
    }

    if (Object.keys(updates).length > 0) {
      const { error: upErr } = await supabase
        .from('kymia_memecoin_paper')
        .update(updates)
        .eq('id', t.id)
      if (upErr) console.error(`[shadow] update ${t.symbol}:`, upErr.message)
    }
  }
}
