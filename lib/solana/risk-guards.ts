// lib/solana/risk-guards.ts
// ------------------------------------------------------------------
// KYMIA Phase 1 — Garde-fous OBLIGATOIRES avant chaque trade réel
//
// À appeler dans le cycle AVANT executeSwap(). Si un guard échoue,
// le trade est refusé et loggé — jamais d'exception silencieuse.
//
// Table Supabase requise (SQL en bas de ce fichier).
// ------------------------------------------------------------------

import { getSolBalance, getTokenBalance, MINTS } from "./wallet";

// ⚙️ Config des limites — ajuste selon ton capital de départ
export const RISK_CONFIG = {
  MAX_POSITION_PCT: 0.10,        // max 10% du capital par trade
  DAILY_LOSS_LIMIT_PCT: 0.05,    // kill switch à -5% sur la journée
  MIN_SOL_FOR_FEES: 0.02,        // toujours garder 0.02 SOL pour les frais
  MAX_PRICE_IMPACT_PCT: 1.0,     // refuse un swap si price impact > 1%
} as const;

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Guard 1 — Position sizing : le montant du trade ne dépasse pas
 * MAX_POSITION_PCT du capital total (mesuré en USDC réel on-chain,
 * pas le cash simulé en base).
 */
export async function checkPositionSize(tradeAmountUsdc: number): Promise<GuardResult> {
  const usdcBalance = await getTokenBalance(MINTS.USDC);
  const maxAllowed = usdcBalance * RISK_CONFIG.MAX_POSITION_PCT;

  if (tradeAmountUsdc > maxAllowed) {
    return {
      allowed: false,
      reason: `Position ${tradeAmountUsdc.toFixed(2)} USDC > max autorisé ${maxAllowed.toFixed(2)} USDC (${RISK_CONFIG.MAX_POSITION_PCT * 100}% de ${usdcBalance.toFixed(2)})`,
    };
  }

  if (tradeAmountUsdc > usdcBalance) {
    return { allowed: false, reason: `Solde USDC insuffisant: ${usdcBalance.toFixed(2)}` };
  }

  return { allowed: true };
}

/**
 * Guard 2 — SOL pour les frais : sans SOL, aucune transaction ne part.
 */
export async function checkSolForFees(): Promise<GuardResult> {
  const sol = await getSolBalance();
  if (sol < RISK_CONFIG.MIN_SOL_FOR_FEES) {
    return {
      allowed: false,
      reason: `SOL insuffisant pour les frais: ${sol.toFixed(4)} < ${RISK_CONFIG.MIN_SOL_FOR_FEES}`,
    };
  }
  return { allowed: true };
}

/**
 * Guard 3 — Price impact : refuse les swaps qui bougent trop le marché
 * (signe d'une liquidité trop faible pour la taille du trade).
 */
export function checkPriceImpact(priceImpactPct: string): GuardResult {
  const impact = Math.abs(parseFloat(priceImpactPct));
  if (impact > RISK_CONFIG.MAX_PRICE_IMPACT_PCT) {
    return {
      allowed: false,
      reason: `Price impact ${impact.toFixed(2)}% > max ${RISK_CONFIG.MAX_PRICE_IMPACT_PCT}%`,
    };
  }
  return { allowed: true };
}

/**
 * Guard 4 — Kill switch journalier.
 * `supabase` = ton client server-side existant.
 * Compare l'equity actuelle à l'equity de début de journée (UTC) stockée
 * dans kymia_live_risk. Si la perte dépasse DAILY_LOSS_LIMIT_PCT,
 * l'agent est coupé jusqu'au lendemain.
 */
export async function checkDailyKillSwitch(
  supabase: any,
  currentEquityUsdc: number
): Promise<GuardResult> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  const { data: row } = await supabase
    .from("kymia_live_risk")
    .select("*")
    .eq("day", today)
    .maybeSingle();

  if (!row) {
    // Premier trade de la journée → on enregistre l'equity de référence
    await supabase.from("kymia_live_risk").insert({
      day: today,
      opening_equity: currentEquityUsdc,
      killed: false,
    });
    return { allowed: true };
  }

  if (row.killed) {
    return { allowed: false, reason: `Kill switch actif depuis aujourd'hui (${today})` };
  }

  const lossPct = (row.opening_equity - currentEquityUsdc) / row.opening_equity;

  if (lossPct >= RISK_CONFIG.DAILY_LOSS_LIMIT_PCT) {
    await supabase
      .from("kymia_live_risk")
      .update({ killed: true, killed_at: new Date().toISOString() })
      .eq("day", today);

    return {
      allowed: false,
      reason: `KILL SWITCH: perte journalière ${(lossPct * 100).toFixed(1)}% >= ${RISK_CONFIG.DAILY_LOSS_LIMIT_PCT * 100}%`,
    };
  }

  return { allowed: true };
}

/**
 * Exécute tous les guards dans l'ordre. Premier échec = trade refusé.
 */
export async function runAllGuards(
  supabase: any,
  tradeAmountUsdc: number,
  priceImpactPct: string,
  currentEquityUsdc: number
): Promise<GuardResult> {
  const guards = [
    await checkDailyKillSwitch(supabase, currentEquityUsdc),
    await checkSolForFees(),
    await checkPositionSize(tradeAmountUsdc),
    checkPriceImpact(priceImpactPct),
  ];

  for (const g of guards) {
    if (!g.allowed) return g;
  }
  return { allowed: true };
}

/* ------------------------------------------------------------------
SQL à exécuter dans Supabase SQL Editor :

CREATE TABLE IF NOT EXISTS kymia_live_risk (
  day date PRIMARY KEY,
  opening_equity numeric NOT NULL,
  killed boolean NOT NULL DEFAULT false,
  killed_at timestamptz
);
------------------------------------------------------------------ */
