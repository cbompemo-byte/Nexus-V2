// lib/agents/regime-shadow.ts
// R-shadow — Évaluation SHADOW de variantes du filtre de régime.
// OBSERVATION PURE : zéro impact sur les décisions, zéro appel API supplémentaire.
// Les candles 4h et 1h proviennent du contexte déjà calculé par runDryRunCycle.
//
// Variantes :
//   V1_current  — référence : price > EMA200(4h) AND EMA50(4h) > EMA200(4h)
//   V2_fast4h   — même logique, horizons plus courts : price > EMA50(4h) AND EMA20(4h) > EMA50(4h)
//   V3_cross    — composante croisement seule : EMA50(4h) > EMA200(4h)
//   V4_price    — composante prix seule : price > EMA200(4h)
//   V5_momentum — très réactif (1h) : EMA20(1h) > EMA50(1h) AND gap > 0.1%
//                 NOTE : pente EMA50(1h) rejetée — avec 52 bougies 1h disponibles, EMA50
//                 n'a que ~3 points fiables → bruit. Remplacé par gap > 0.1% pour filtrer
//                 les faux croisements. Même esprit (momentum confirmé), plus robuste.
//
// Volume estimé : 5 variantes × 7 symboles × 288 cycles/jour ≈ 10 000 lignes/jour.
// Purge recommandée : conserver ~60 jours (~600 000 lignes), supprimer au-delà.
// Fonction de purge SQL à créer et appeler 1×/semaine (comme kymia_agent_verdicts).

import { calcEMA } from './utils'

export interface ShadowResult {
  variant: string
  regime:  'BULL' | 'BEAR' | 'UNKNOWN'   // UNKNOWN = données insuffisantes
  data:    Record<string, number | string>
}

interface ShadowInput {
  price:     number
  candles4h: number[] | null
  candles1h: number[] | null
}

// ── V1_current — référence exacte du regimeAgent en production ────────────────
function v1Current({ price, candles4h }: ShadowInput): ShadowResult {
  if (!candles4h || candles4h.length < 200) {
    return { variant: 'V1_current', regime: 'UNKNOWN', data: { candles4h: candles4h?.length ?? 0 } }
  }
  const ema50  = calcEMA(candles4h, 50)
  const ema200 = calcEMA(candles4h, 200)
  return {
    variant: 'V1_current',
    regime:  price > ema200 && ema50 > ema200 ? 'BULL' : 'BEAR',
    data:    { ema50_4h: ema50, ema200_4h: ema200 },
  }
}

// ── V2_fast4h — version rapide de V1 sur le même timeframe 4h ────────────────
function v2Fast4h({ price, candles4h }: ShadowInput): ShadowResult {
  if (!candles4h || candles4h.length < 50) {
    return { variant: 'V2_fast4h', regime: 'UNKNOWN', data: { candles4h: candles4h?.length ?? 0 } }
  }
  const ema20 = calcEMA(candles4h, 20)
  const ema50 = calcEMA(candles4h, 50)
  return {
    variant: 'V2_fast4h',
    regime:  price > ema50 && ema20 > ema50 ? 'BULL' : 'BEAR',
    data:    { ema20_4h: ema20, ema50_4h: ema50 },
  }
}

// ── V3_cross — croisement EMA50/200 (4h) sans condition sur le prix ───────────
function v3Cross({ candles4h }: ShadowInput): ShadowResult {
  if (!candles4h || candles4h.length < 200) {
    return { variant: 'V3_cross', regime: 'UNKNOWN', data: { candles4h: candles4h?.length ?? 0 } }
  }
  const ema50  = calcEMA(candles4h, 50)
  const ema200 = calcEMA(candles4h, 200)
  return {
    variant: 'V3_cross',
    regime:  ema50 > ema200 ? 'BULL' : 'BEAR',
    data:    { ema50_4h: ema50, ema200_4h: ema200 },
  }
}

// ── V4_price — prix > EMA200 (4h) sans condition de croisement ───────────────
function v4Price({ price, candles4h }: ShadowInput): ShadowResult {
  if (!candles4h || candles4h.length < 200) {
    return { variant: 'V4_price', regime: 'UNKNOWN', data: { candles4h: candles4h?.length ?? 0 } }
  }
  const ema200 = calcEMA(candles4h, 200)
  return {
    variant: 'V4_price',
    regime:  price > ema200 ? 'BULL' : 'BEAR',
    data:    { ema200_4h: ema200 },
  }
}

// ── V5_momentum — EMA20(1h) > EMA50(1h) avec gap > 0.1% ─────────────────────
// Utilise les bougies 1h (52 disponibles). Pente rejetée (voir note en tête de fichier).
function v5Momentum({ candles1h }: ShadowInput): ShadowResult {
  if (!candles1h || candles1h.length < 50) {
    return { variant: 'V5_momentum', regime: 'UNKNOWN', data: { candles1h: candles1h?.length ?? 0 } }
  }
  const ema20   = calcEMA(candles1h, 20)
  const ema50   = calcEMA(candles1h, 50)
  const gapPct  = (ema20 - ema50) / ema50   // positif = fast au-dessus de slow
  return {
    variant: 'V5_momentum',
    regime:  gapPct > 0.001 ? 'BULL' : 'BEAR',   // seuil 0.1% : filtre les faux croisements
    data:    { ema20_1h: ema20, ema50_1h: ema50, gap_pct: parseFloat((gapPct * 100).toFixed(4)) },
  }
}

// ── Point d'entrée ────────────────────────────────────────────────────────────
export function computeAllShadowVariants(input: ShadowInput): ShadowResult[] {
  return [
    v1Current(input),
    v2Fast4h(input),
    v3Cross(input),
    v4Price(input),
    v5Momentum(input),
  ]
}
