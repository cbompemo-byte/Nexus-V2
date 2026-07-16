// lib/solana/wallet.ts
// ------------------------------------------------------------------
// KYMIA Phase 1 — Wallet serveur autonome
//
// npm install @solana/web3.js bs58
//
// Env vars requises (Vercel → Settings → Environment Variables) :
//   SOLANA_TRADING_WALLET_SECRET  → clé privée base58 (voir scripts/generate-wallet.ts)
//   SOLANA_RPC_URL                → endpoint RPC (Helius/QuickNode recommandé)
//
// SÉCURITÉ :
// - La clé privée ne doit JAMAIS être loggée, ni stockée en base, ni
//   renvoyée dans une réponse API.
// - Ce module ne doit être importé QUE côté serveur (routes API).
// ------------------------------------------------------------------

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";

let _keypair: Keypair | null = null;
let _connection: Connection | null = null;

/** Charge le wallet de trading depuis l'env var (singleton). */
export function getTradingWallet(): Keypair {
  if (_keypair) return _keypair;

  const secret = process.env.SOLANA_TRADING_WALLET_SECRET;
  if (!secret) {
    throw new Error(
      "SOLANA_TRADING_WALLET_SECRET manquante. Génère un wallet avec scripts/generate-wallet.ts"
    );
  }

  _keypair = Keypair.fromSecretKey(bs58.decode(secret));
  return _keypair;
}

/** Connexion RPC (singleton). */
export function getConnection(): Connection {
  if (_connection) return _connection;

  const url = process.env.SOLANA_RPC_URL;
  if (!url) {
    throw new Error(
      "SOLANA_RPC_URL manquante. Utilise un provider dédié (Helius/QuickNode) — le RPC public est trop rate-limité."
    );
  }

  _connection = new Connection(url, "confirmed");
  return _connection;
}

/** Adresse publique du wallet de trading (safe à afficher/publier). */
export function getTradingWalletAddress(): string {
  return getTradingWallet().publicKey.toBase58();
}

/** Solde SOL du wallet (pour les frais de transaction). */
export async function getSolBalance(): Promise<number> {
  const conn = getConnection();
  const lamports = await conn.getBalance(getTradingWallet().publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

/** Solde d'un token SPL (ex: USDC) en unités humaines. */
export async function getTokenBalance(mintAddress: string): Promise<number> {
  const conn = getConnection();
  const owner = getTradingWallet().publicKey;

  const resp = await conn.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(mintAddress),
  });

  if (resp.value.length === 0) return 0;

  const info = resp.value[0].account.data.parsed.info;
  return Number(info.tokenAmount.uiAmount ?? 0);
}

// Mints des tokens principaux (mainnet)
export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112", // wrapped SOL
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
} as const;
