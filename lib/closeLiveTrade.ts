/**
 * KYMIA — Close a live (SPOT) trade via Jupiter with embedded performance fee.
 *
 * ⚠  DEPENDENCIES NOT YET INSTALLED — run before using:
 *    npm install @solana/web3.js
 *
 * ⚠  JUPITER API NOTE:
 *    Endpoints below reflect Jupiter v6 (quote-api.jup.ag/v6).
 *    Always verify at https://station.jup.ag/docs/apis/swap-api before
 *    deploying — the versioned URL path changes with major releases.
 *
 * ⚠  FEE ACCOUNT NOTE:
 *    NEXT_PUBLIC_KYMIA_FEE_WALLET must be the USDC Associated Token Account
 *    owned by the kymia.sol fee-collection wallet — NOT the raw wallet address.
 *    Jupiter sends fees to a token account, not a wallet.
 *    One-time setup: have kymia.sol hold some SOL, then create the USDC ATA.
 *    Verify the ATA on Solscan before going live.
 *
 * ⚠  LIVE TEST REQUIRED:
 *    Test the entire flow with $5–10 of real value before any public launch.
 *    Confirm the fee transfer appears in the transaction on Solscan.
 */

import {
  calculatePerformanceFee,
  getTaxableProfit,
  recordFeePaid,
} from "./performanceFee";

// ── Types ────────────────────────────────────────────────────────────────────
// Using `any` for @solana/web3.js types until the package is installed.
// Replace with proper imports once `npm install @solana/web3.js` is run:
//   import { PublicKey, VersionedTransaction, Connection } from "@solana/web3.js"
/* eslint-disable @typescript-eslint/no-explicit-any */
type PublicKey = any;
type VersionedTransaction = any;
type Connection = any;

export interface CloseLiveTradeParams {
  /** Connected Solana wallet public key */
  wallet: PublicKey;
  /** RPC connection (e.g. new Connection("https://mainnet.helius-rpc.com/?api-key=...")) */
  connection: Connection;
  /** Token mint being sold (e.g. SOL mint, or any SPL token) */
  inputMint: string;
  /** Output mint — should be USDC for the fee account to work correctly */
  outputMint: string;
  /** Raw token amount to sell (in smallest unit, e.g. lamports for SOL) */
  amount: number;
  /** USD value of the original entry (cost basis) */
  entryValueUsd: number;
  /** Current USD value at close */
  exitValueUsd: number;
  /** Performance fee percentage chosen by the user (5–15) */
  feePercent: number;
  /** Phantom / wallet adapter signTransaction function */
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  /** Optional logger — defaults to console.log */
  log?: (msg: string) => void;
}

export interface CloseLiveTradeResult {
  txSignature: string;
  feeAmountUsd: number;
  userProfitAfterFee: number;
}

// ── Jupiter v6 endpoints ─────────────────────────────────────────────────────
// Verify latest at: https://station.jup.ag/docs/apis/swap-api
const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_URL  = "https://quote-api.jup.ag/v6/swap";

export async function closeLiveTrade(
  params: CloseLiveTradeParams,
): Promise<CloseLiveTradeResult> {
  const {
    wallet, connection, inputMint, outputMint, amount,
    entryValueUsd, exitValueUsd, feePercent,
    signTransaction, log = console.log,
  } = params;

  const walletStr: string = typeof wallet.toString === "function"
    ? wallet.toString()
    : String(wallet);

  // ── 1. Calculate fee using high-water mark ───────────────────────────────
  const currentEquity = exitValueUsd; // approximate: treat close proceeds as equity proxy
  const rawProfit = exitValueUsd - entryValueUsd;
  const taxableProfit = getTaxableProfit(walletStr, currentEquity, rawProfit);

  // Adjusted entry so fee math yields (feePercent% of taxable profit only)
  const adjustedEntry = exitValueUsd - taxableProfit;
  const fee = calculatePerformanceFee(adjustedEntry, exitValueUsd, feePercent);

  log(
    `◈ Fee calc: profit $${rawProfit.toFixed(2)} | taxable $${taxableProfit.toFixed(2)}` +
    ` | fee $${fee.feeAmountUsd.toFixed(2)} (${fee.platformFeeBps} bps)`,
  );

  // ── 2. Jupiter quote WITH platform fee ───────────────────────────────────
  const quoteUrl = new URL(JUPITER_QUOTE_URL);
  quoteUrl.searchParams.set("inputMint", inputMint);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount", amount.toString());
  quoteUrl.searchParams.set("slippageBps", "50");
  if (fee.platformFeeBps > 0) {
    quoteUrl.searchParams.set("platformFeeBps", fee.platformFeeBps.toString());
  }

  const quoteRes = await fetch(quoteUrl.toString());
  if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status}`);
  const quote = await quoteRes.json();

  // ── 3. Build swap transaction with fee account ───────────────────────────
  const feeWallet = process.env.NEXT_PUBLIC_KYMIA_FEE_WALLET;
  if (fee.platformFeeBps > 0 && !feeWallet) {
    throw new Error("NEXT_PUBLIC_KYMIA_FEE_WALLET is not set. Cannot charge fee.");
  }

  const swapBody: Record<string, unknown> = {
    quoteResponse: quote,
    userPublicKey: walletStr,
    wrapAndUnwrapSol: true, // auto-wraps SOL → wSOL and unwraps back
  };
  if (fee.platformFeeBps > 0 && feeWallet) {
    // feeAccount must be the USDC ATA of the kymia.sol fee wallet, NOT a raw wallet address.
    swapBody.feeAccount = feeWallet;
  }

  const swapRes = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapBody),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap build failed: ${swapRes.status}`);
  const { swapTransaction } = await swapRes.json();

  // ── 4. User signs ONE transaction (swap + fee in the same ix) ────────────
  // Requires @solana/web3.js: import { VersionedTransaction } from "@solana/web3.js"
  const txBuf = Buffer.from(swapTransaction, "base64");
  // VersionedTransaction.deserialize is from @solana/web3.js — install the package first
  const tx = (globalThis as any).VersionedTransaction
    ? (globalThis as any).VersionedTransaction.deserialize(txBuf)
    : txBuf; // fallback: pass raw buffer if VersionedTransaction not imported

  const signedTx = await signTransaction(tx);

  // ── 5. Send and confirm ───────────────────────────────────────────────────
  // connection.sendRawTransaction requires @solana/web3.js Connection
  const rawTx = typeof signedTx.serialize === "function"
    ? signedTx.serialize()
    : signedTx;

  const txSignature: string = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  await connection.confirmTransaction(txSignature, "confirmed");

  // ── 6. Post-success bookkeeping ───────────────────────────────────────────
  if (fee.isProfit) {
    recordFeePaid(walletStr, fee.feeAmountUsd, currentEquity);
  }

  log(
    `◈ Trade closed. Profit $${rawProfit.toFixed(2)}` +
    ` · Fee $${fee.feeAmountUsd.toFixed(2)} (${feePercent}%)` +
    ` · You keep $${fee.userProfitAfterFee.toFixed(2)}` +
    ` · tx: ${txSignature}`,
  );

  return {
    txSignature,
    feeAmountUsd: fee.feeAmountUsd,
    userProfitAfterFee: fee.userProfitAfterFee,
  };
}
