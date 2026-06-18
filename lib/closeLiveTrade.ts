/**
 * KYMIA — Close a live (SPOT) trade via Jupiter with embedded performance fee.
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

import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import {
  calculatePerformanceFee,
  getTaxableProfit,
  recordFeePaid,
} from "./performanceFee";

export interface CloseLiveTradeParams {
  /** Connected Solana wallet public key */
  wallet: PublicKey;
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
  /**
   * Phantom / wallet adapter signTransaction.
   * Receives a VersionedTransaction; must return the signed copy.
   * Phantom v1+ supports this directly:
   *   const { signTransaction } = window.phantom.solana
   */
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  /**
   * Send the signed, serialized transaction and return the signature string.
   * Use connection.sendRawTransaction(tx.serialize()) with @solana/web3.js Connection,
   * or send via the Solana JSON-RPC sendTransaction method directly.
   */
  sendAndConfirm: (tx: VersionedTransaction) => Promise<string>;
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
    wallet, inputMint, outputMint, amount,
    entryValueUsd, exitValueUsd, feePercent,
    signTransaction, sendAndConfirm, log = console.log,
  } = params;

  const walletStr = wallet.toString();

  // ── 1. Calculate fee using high-water mark ───────────────────────────────
  const currentEquity = exitValueUsd;
  const rawProfit = exitValueUsd - entryValueUsd;
  const taxableProfit = getTaxableProfit(walletStr, currentEquity, rawProfit);

  // Adjusted entry so fee = feePercent% of taxable profit only (not total exit)
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
  const quote: unknown = await quoteRes.json();

  // ── 3. Build swap transaction with fee account ───────────────────────────
  const feeWallet = process.env.NEXT_PUBLIC_KYMIA_FEE_WALLET;
  if (fee.platformFeeBps > 0 && !feeWallet) {
    throw new Error("NEXT_PUBLIC_KYMIA_FEE_WALLET is not set. Cannot charge fee.");
  }

  const swapBody: Record<string, unknown> = {
    quoteResponse: quote,
    userPublicKey: walletStr,
    wrapAndUnwrapSol: true, // auto-wraps native SOL → wSOL and back
  };
  if (fee.platformFeeBps > 0 && feeWallet) {
    // feeAccount MUST be the USDC ATA of the fee wallet, NOT the raw wallet address.
    swapBody.feeAccount = feeWallet;
  }

  const swapRes = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapBody),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap build failed: ${swapRes.status}`);
  const { swapTransaction } = await swapRes.json() as { swapTransaction: string };

  // ── 4. Deserialize → sign → send (one user signature) ───────────────────
  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);

  const signedTx = await signTransaction(tx);
  const txSignature = await sendAndConfirm(signedTx);

  // ── 5. Post-success bookkeeping ───────────────────────────────────────────
  if (fee.isProfit) {
    recordFeePaid(walletStr, fee.feeAmountUsd, currentEquity);
  }

  log(
    `◈ Trade closed. Profit $${rawProfit.toFixed(2)}` +
    ` · Fee $${fee.feeAmountUsd.toFixed(2)} (${feePercent}%)` +
    ` · You keep $${fee.userProfitAfterFee.toFixed(2)}` +
    ` · tx: ${txSignature}`,
  );

  return { txSignature, feeAmountUsd: fee.feeAmountUsd, userProfitAfterFee: fee.userProfitAfterFee };
}
