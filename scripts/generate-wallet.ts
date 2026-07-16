// scripts/generate-wallet.ts
// Usage : npx tsx scripts/generate-wallet.ts
// ⚠️ Lance ça en LOCAL uniquement. Copie la clé privée dans Vercel
// puis SUPPRIME toute trace du terminal (clear + historique).

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const kp = Keypair.generate();

console.log("=== KYMIA TRADING WALLET ===");
console.log("Adresse publique (safe à partager) :");
console.log(kp.publicKey.toBase58());
console.log("");
console.log("Clé privée (SECRET — à mettre dans Vercel env var) :");
console.log(bs58.encode(kp.secretKey));
console.log("");
console.log("⚠️ Ne partage JAMAIS la clé privée. Pas de screenshot, pas de note iCloud.");
