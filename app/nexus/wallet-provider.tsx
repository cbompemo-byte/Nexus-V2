"use client";
// ── Phantom Wallet Provider (STUB) ────────────────────────────────────────────
// This file is a structural stub for future Phantom wallet integration.
// DO NOT install @solana/wallet-adapter-* packages — they cause webpack polyfill
// issues on Vercel builds. Activate only when Solana packages are configured.
//
// To activate:
// 1. npm install @solana/wallet-adapter-react @solana/wallet-adapter-phantom @solana/web3.js
// 2. Add webpack polyfills to next.config.ts (buffer, crypto, stream)
// 3. Uncomment the implementation below and wrap <KYMIA> in <WalletProvider>
//
// import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
// import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
// import { clusterApiUrl } from "@solana/web3.js";
//
// const endpoint = clusterApiUrl("mainnet-beta");
// const wallets = [new PhantomWalletAdapter()];
//
// export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
//   return (
//     <ConnectionProvider endpoint={endpoint}>
//       <WalletProvider wallets={wallets} autoConnect>
//         {children}
//       </WalletProvider>
//     </ConnectionProvider>
//   );
// }

export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  // Stub: pass through until Solana packages are activated
  return <>{children}</>;
}
