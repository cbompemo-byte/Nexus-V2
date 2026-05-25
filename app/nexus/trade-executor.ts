// ── Trade Executor (STUB) ─────────────────────────────────────────────────────
// Abstracts DEMO vs LIVE trade execution.
// DEMO: virtual $10,000 portfolio, no real transactions.
// LIVE: routes through Phantom wallet + Jupiter swap API.
//
// Current mode is always DEMO. Set NEXT_PUBLIC_TRADING_MODE=LIVE to enable
// real execution (requires wallet-provider.tsx to be activated first).

export type TradeMode = "DEMO" | "LIVE";

export const TRADING_MODE: TradeMode =
  (process.env.NEXT_PUBLIC_TRADING_MODE as TradeMode) || "DEMO";

export interface TradeRequest {
  sym: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  conf: number;
  agent?: string;
  reason?: string;
}

export interface TradeResult {
  success: boolean;
  txId?: string;
  error?: string;
  mode: TradeMode;
}

// DEMO execution: always succeeds, no on-chain action
export async function executeTradeDEMO(req: TradeRequest): Promise<TradeResult> {
  return { success: true, mode: "DEMO", txId: `demo-${Date.now()}` };
}

// LIVE execution stub — implement with Jupiter swap SDK
// import { useWallet } from "@solana/wallet-adapter-react";
// import { Connection, PublicKey, Transaction } from "@solana/web3.js";
export async function executeTradeJupiter(_req: TradeRequest): Promise<TradeResult> {
  // TODO: implement Jupiter swap
  // 1. Fetch quote: GET https://quote-api.jup.ag/v6/quote?...
  // 2. Fetch swap tx: POST https://quote-api.jup.ag/v6/swap
  // 3. Sign + send with wallet.sendTransaction(tx, connection)
  return { success: false, error: "LIVE mode not yet active", mode: "LIVE" };
}

export async function executeTrade(req: TradeRequest): Promise<TradeResult> {
  if (TRADING_MODE === "LIVE") return executeTradeJupiter(req);
  return executeTradeDEMO(req);
}
