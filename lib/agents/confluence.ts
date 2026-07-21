// lib/agents/confluence.ts
// R20 — Score de confluence : agrège les votes d'agents pondérés en un score 0-100.
//
// RÈGLE FONDAMENTALE :
//   - APPROVE → confidence × poids (contribution positive)
//   - REJECT  → 0 (la confidence mesure la FORCE DU VETO, pas une contribution positive)
//   - ABSTAIN → poids redistribué au prorata des agents actifs (score reste 0-100)
//
// Seule fonction à modifier quand de nouveaux agents (smart_money, universe…) arrivent.

import { AgentVerdict } from './types'

// Pondérations R20 — total = 1.0.
// Commentaire source : SPEC-AGENTS-CONFLUENCE.md § R20
const WEIGHTS: Record<string, number> = {
  regime:      0.25,
  signal:      0.30,
  edge:        0.20,
  universe:    0.10,   // ABSTAIN jusqu'à R21 (Universe Agent)
  sol_context: 0.15,   // regime de SOL du même cycle (vent porteur)
}

export interface ConfluenceResult {
  score:         number              // 0-100, arrondi
  score_type:    'DECISION' | 'AMBIENT'
  //   DECISION : signal a voté APPROVE ou REJECT (setup évalué — score actionnable)
  //   AMBIENT  : signal ABSTAIN (NO_SIGNAL — mesure la météo du marché, pas un trade)
  //   Seuls les scores DECISION entrent dans l'auto-audit R23.
  partial_score: boolean             // true si ≥1 agent ABSTAIN (score normalisé)
  active_weight: number              // somme des poids des agents non-ABSTAIN (pour audit)
  breakdown:     Record<string, number>  // contribution brute par agent (pour audit)
}

/**
 * @param verdicts   - Liste des verdicts du cycle (regime, signal, edge, risk, sizing…)
 *                     Les agents hors WEIGHTS (sizing, risk) sont ignorés ici.
 * @param solContext - Verdict regime de SOL du même cycle.
 *                     Passer null pour SOL lui-même (évite le double-comptage :
 *                     son regime est déjà capturé par le composant regime 0.25).
 */
export function computeConfluence(
  verdicts:   AgentVerdict[],
  solContext: AgentVerdict | null,
): ConfluenceResult {
  // Index les verdicts par agent (dernier verdict gagne si duplicat)
  const map: Record<string, { vote: string; confidence: number }> = {}
  for (const v of verdicts) {
    if (v.agent in WEIGHTS) {
      map[v.agent] = { vote: v.vote, confidence: v.confidence }
    }
  }

  // sol_context : verdict regime de SOL ; null → ABSTAIN (SOL lui-même ou pas encore calculé)
  map['sol_context'] = solContext
    ? { vote: solContext.vote, confidence: solContext.confidence }
    : { vote: 'ABSTAIN', confidence: 0 }

  // universe : ABSTAIN jusqu'à R21
  if (!('universe' in map)) {
    map['universe'] = { vote: 'ABSTAIN', confidence: 0 }
  }

  let rawScore     = 0
  let activeWeight = 0
  let partial      = false
  const breakdown: Record<string, number> = {}

  for (const [agent, weight] of Object.entries(WEIGHTS)) {
    const v = map[agent]

    if (!v || v.vote === 'ABSTAIN') {
      partial = true
      breakdown[agent] = 0
      // poids non comptabilisé → redistribué implicitement par la normalisation
    } else {
      activeWeight += weight
      // APPROVE → confidence contribue ; REJECT → force du veto ≠ score positif
      const contrib = v.vote === 'APPROVE' ? v.confidence * weight : 0
      rawScore     += contrib
      breakdown[agent] = parseFloat(contrib.toFixed(2))
    }
  }

  // Normalisation : redistribue les poids ABSTAIN (score reste 0-100 quel que soit
  // le nombre d'abstentions). Si tous ABSTAIN → 0.
  const score = activeWeight > 0
    ? Math.round(rawScore / activeWeight)
    : 0

  // score_type : DECISION si signal a voté (setup évalué), AMBIENT sinon (météo du marché).
  // map['signal'] est renseigné par la boucle ci-dessus depuis les verdicts.
  const signalVote = map['signal']?.vote
  const score_type: 'DECISION' | 'AMBIENT' =
    (signalVote === 'APPROVE' || signalVote === 'REJECT') ? 'DECISION' : 'AMBIENT'

  return { score, score_type, partial_score: partial, active_weight: activeWeight, breakdown }
}
