/**
 * KYMIA — Open a live SPOT trade via Jupiter (USDC → token).
 *
 * No performance fee on open — fee is charged only on the closing swap.
 * Caller receives the actual confirmed token qty so the portfolio state
 * reflects real slippage rather than a theoretical price calculation.
 *
 * Same warnings as closeLiveTrade.ts:
 * - Verify Jupiter v6 endpoints at https://station.jup.ag/docs/apis/swap-api
 * - Test with $5–10 real value before any public launch
 */

import { VersionedTransaction, PublicKey } from "@solana/web3.js";

export interface OpenLiveTradeParams {
  wallet: PublicKey;
  /** Token mint to buy */
  outputMint: string;
  /** USDC to spend in whole dollars (e.g. 350.50 = $350.50) */
  usdcToSpend: number;
  /** Slippage tolerance in bps — default 50 (0.5%) */
  slippageBps?: number;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  sendAndConfirm: (tx: VersionedTransaction) => Promise<string>;
  log?: (msg: string) => void;
}

export interface OpenLiveTradeResult {
  txSignature: string;
  /** Raw output amount in the token's smallest unit (convert with TOKEN_DECIMALS) */
  rawOutAmount: number;
  /** USDC actually sent */
  usdcSpent: number;
}

const USDC_MINT     = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;
const JUPITER_QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_URL  = "https://quote-api.jup.ag/v6/swap";

export async function openLiveTrade(
  params: OpenLiveTradeParams,
): Promise<OpenLiveTradeResult> {
  const {
    wallet, outputMint, usdcToSpend, slippageBps = 50,
    signTransaction, sendAndConfirm, log = console.log,
  } = params;

  const usdcLamports = Math.round(usdcToSpend * Math.pow(10, USDC_DECIMALS));

  // ── 1. Quote: USDC → token ───────────────────────────────────────────────
  const quoteUrl = new URL(JUPITER_QUOTE_URL);
  quoteUrl.searchParams.set("inputMint",  USDC_MINT);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount",     usdcLamports.toString());
  quoteUrl.searchParams.set("slippageBps", slippageBps.toString());

  const quoteRes = await fetch(quoteUrl.toString());
  if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status}`);
  const quote = await quoteRes.json() as { outAmount: string; [k: string]: unknown };

  // ── 2. Build swap transaction ─────────────────────────────────────────────
  const swapRes = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse:  quote,
      userPublicKey:  wallet.toString(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap build failed: ${swapRes.status}`);
  const { swapTransaction } = await swapRes.json() as { swapTransaction: string };

  // ── 3. Deserialize → user signs ONE transaction ───────────────────────────
  const tx       = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  const signedTx = await signTransaction(tx);

  // ── 4. Send + confirm ─────────────────────────────────────────────────────
  const txSignature  = await sendAndConfirm(signedTx);
  const rawOutAmount = parseInt(quote.outAmount, 10);

  log(
    `◈ Opened: spent $${usdcToSpend.toFixed(2)} USDC` +
    ` · received ${rawOutAmount} raw units` +
    ` · tx: ${txSignature}`,
  );

  return { txSignature, rawOutAmount, usdcSpent: usdcToSpend };
}
