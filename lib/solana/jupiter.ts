// lib/solana/jupiter.ts
// ------------------------------------------------------------------
// KYMIA Phase 1 — Exécution de swaps via Jupiter (aggregateur Solana)
//
// Flow : getQuote() → executeSwap() → confirmation on-chain
//
// Ce module remplace, en mode live Solana, ce que faisait la simulation
// dans app/api/agents/cycle/route.ts : quand la stratégie décide BUY,
// on swap USDC → token ; quand elle décide SELL, token → USDC.
//
// IMPORTANT : le prix de fill réel (celui retourné ici) doit être celui
// écrit en base pour le PnL — jamais le prix théorique du signal.
// ------------------------------------------------------------------

import { VersionedTransaction } from "@solana/web3.js";
import { getConnection, getTradingWallet } from "./wallet";

const JUPITER_API = "https://lite-api.jup.ag/swap/v1";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string; // en unités atomiques (raw)
  outAmount: string;
  priceImpactPct: string;
  raw: any; // quote complète à repasser à /swap
}

export interface SwapResult {
  signature: string; // hash de la transaction → lien Solscan
  inAmountRaw: string;
  outAmountRaw: string;
  solscanUrl: string;
}

/**
 * Demande une quote à Jupiter.
 * @param inputMint  mint du token vendu (ex: MINTS.USDC)
 * @param outputMint mint du token acheté (ex: MINTS.SOL)
 * @param amountRaw  montant en unités atomiques (USDC = 6 décimales : 100 USDC = 100_000_000)
 * @param slippageBps slippage max en basis points (50 = 0.5%)
 */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: bigint,
  slippageBps = 50
): Promise<JupiterQuote> {
  const url =
    `${JUPITER_API}/quote?inputMint=${inputMint}` +
    `&outputMint=${outputMint}` +
    `&amount=${amountRaw.toString()}` +
    `&slippageBps=${slippageBps}` +
    `&restrictIntermediateTokens=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  }

  const quote = await res.json();

  return {
    inputMint,
    outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
    raw: quote,
  };
}

/**
 * Exécute le swap : construit la transaction via Jupiter, la signe avec
 * le wallet serveur, l'envoie, et attend la confirmation.
 */
export async function executeSwap(quote: JupiterQuote): Promise<SwapResult> {
  const wallet = getTradingWallet();
  const connection = getConnection();

  // 1. Demander la transaction de swap à Jupiter
  const swapRes = await fetch(`${JUPITER_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      // Priority fees dynamiques — indispensable en période de congestion
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: "high",
          maxLamports: 5_000_000, // plafond 0.005 SOL de priority fee
        },
      },
    }),
  });

  if (!swapRes.ok) {
    throw new Error(`Jupiter swap build failed: ${swapRes.status} ${await swapRes.text()}`);
  }

  const { swapTransaction } = await swapRes.json();

  // 2. Désérialiser + signer
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);

  // 3. Envoyer
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  // 4. Attendre la confirmation
  const latestBlockhash = await connection.getLatestBlockhash();
  const confirmation = await connection.confirmTransaction(
    { signature, ...latestBlockhash },
    "confirmed"
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  return {
    signature,
    inAmountRaw: quote.inAmount,
    outAmountRaw: quote.outAmount,
    solscanUrl: `https://solscan.io/tx/${signature}`,
  };
}

/**
 * Helper : convertit un montant humain en unités atomiques.
 * USDC = 6 décimales, SOL = 9 décimales.
 */
export function toRawAmount(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 10 ** decimals));
}
