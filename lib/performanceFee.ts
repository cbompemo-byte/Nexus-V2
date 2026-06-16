/**
 * KYMIA Performance Fee System
 *
 * Non-custodial: fees are taken inside the same Jupiter swap transaction
 * the user already signs to close the trade. Funds never leave the wallet
 * without an explicit user signature.
 *
 * Fee model: percentage of PROFIT ONLY, enforced by high-water mark so we
 * never charge twice on gains that merely recover a prior loss.
 */

export interface FeeCalc {
  /** Basis points to pass as platformFeeBps to Jupiter quote API */
  platformFeeBps: number;
  /** Dollar value of the fee */
  feeAmountUsd: number;
  /** What the user keeps after the fee */
  userProfitAfterFee: number;
  /** False → no fee charged (losing/flat trade) */
  isProfit: boolean;
}

/**
 * Convert "X% of profit" into the Jupiter platformFeeBps that achieves it.
 *
 * Jupiter takes platformFeeBps out of the OUTPUT mint of the swap (USDC when
 * closing a long). The bps are applied to the total swap output, not just the
 * profit. We calculate what fraction of the total output equals our target
 * profit-fee, then express that as bps.
 *
 * @param entryValueUsd  - USD value of capital that entered (cost basis)
 * @param exitValueUsd   - Current USD value at close
 * @param feePercent     - Percentage of profit to charge (e.g. 10 = 10%)
 */
export function calculatePerformanceFee(
  entryValueUsd: number,
  exitValueUsd: number,
  feePercent: number,
): FeeCalc {
  const profit = exitValueUsd - entryValueUsd;

  if (profit <= 0) {
    return { platformFeeBps: 0, feeAmountUsd: 0, userProfitAfterFee: profit, isProfit: false };
  }

  const feeAmountUsd = profit * (feePercent / 100);

  // Express fee as fraction of the FULL swap output (exitValueUsd), then to bps.
  // e.g. profit=$100 on exit=$1100, fee=10% → $10 fee → 10/1100 → ~90.9 bps
  const rawBps = (feeAmountUsd / exitValueUsd) * 10_000;

  // Jupiter caps platformFeeBps at 255 bps (2.55%) as of v6.
  // Clamping protects against very large profit percentages exceeding the cap.
  // Note: verify current cap at https://station.jup.ag/docs/apis/swap-api
  const platformFeeBps = Math.min(Math.round(rawBps), 255);

  return {
    platformFeeBps,
    feeAmountUsd,
    userProfitAfterFee: profit - feeAmountUsd,
    isProfit: true,
  };
}

// ── High-Water Mark ──────────────────────────────────────────────────────────
// Prevents charging fees on gains that only recover prior losses.
// Storage: localStorage keyed by wallet address (browser-only, per-device).
// For production scale, replace with a server-side DB keyed by wallet.

export interface WalletFeeState {
  highWaterMark: number; // highest equity ever reached for this wallet
  totalFeesPaid: number; // lifetime fees paid (informational)
  feePercent: number;    // chosen fee tier
}

const HWM_KEY = (wallet: string) => `kymia_hwm_${wallet}`;
const FEE_STATE_KEY = (wallet: string) => `kymia_fee_${wallet}`;

export function getHighWaterMark(wallet: string): number {
  if (typeof window === "undefined") return 0;
  const v = localStorage.getItem(HWM_KEY(wallet));
  return v ? parseFloat(v) : 0;
}

export function updateHighWaterMark(wallet: string, equity: number): void {
  if (typeof window === "undefined") return;
  const current = getHighWaterMark(wallet);
  if (equity > current) localStorage.setItem(HWM_KEY(wallet), equity.toString());
}

export function getWalletFeeState(wallet: string): WalletFeeState {
  if (typeof window === "undefined") return { highWaterMark: 0, totalFeesPaid: 0, feePercent: 10 };
  const stored = localStorage.getItem(FEE_STATE_KEY(wallet));
  if (stored) return JSON.parse(stored) as WalletFeeState;
  return { highWaterMark: 0, totalFeesPaid: 0, feePercent: 10 };
}

export function recordFeePaid(wallet: string, feeUsd: number, equity: number): void {
  if (typeof window === "undefined") return;
  const state = getWalletFeeState(wallet);
  state.totalFeesPaid += feeUsd;
  state.highWaterMark = Math.max(state.highWaterMark, equity);
  localStorage.setItem(FEE_STATE_KEY(wallet), JSON.stringify(state));
  updateHighWaterMark(wallet, equity);
}

/**
 * Returns the portion of tradeProfit that is ABOVE the high-water mark.
 * Only this portion is subject to the performance fee.
 *
 * Example: HWM = $10,500, current equity = $10,800, trade profit = $400
 *   → $300 above HWM is taxable, $100 was recovering a prior loss → no fee
 */
export function getTaxableProfit(
  wallet: string,
  newEquity: number,
  tradeProfit: number,
): number {
  const hwm = getHighWaterMark(wallet);
  if (newEquity <= hwm) return 0;
  // Only the portion of the profit that pushed us above the previous peak
  return Math.min(tradeProfit, newEquity - hwm);
}
