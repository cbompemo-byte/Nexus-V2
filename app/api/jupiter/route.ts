import { NextResponse } from "next/server";

// price.jup.ag is unreachable from Vercel servers.
// This route proxies through CoinGecko instead, mapping
// Solana mint addresses → CoinGecko IDs and returning
// the same response shape the client expects:
// { data: { [mint]: { price: number } } }

const MINT_TO_CG: Record<string, string> = {
  So11111111111111111111111111111111111111112: "solana",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "bitcoin",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ethereum",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "jupiter-ag",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "raydium",
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: "orca",
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: "pyth-network",
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "jito-governance",
  DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7: "drift-protocol",
  MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac: "mango-markets",
  EchesyfXePKdLtoiZSL8pBe8Myagyy8ZRqsACNCFGnvp: "bonfida",
  StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT: "step-finance",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "bonk",
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: "dogwifcoin",
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": "popcat",
  HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4: "myro",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "jito-governance",
  ZETAxsqTWhLDGkGnSPMNUKMqhcJRHRSXVgDoVLRFJvL: "zeta",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "usd-coin",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "tether",
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ids = (searchParams.get("ids") || "").split(",").filter(Boolean);

  // Map requested mints to CoinGecko IDs, skip unknowns
  const cgIds: string[] = []
  const cgIdToMints: Record<string, string[]> = {}
  for (const mint of ids) {
    const cgId = MINT_TO_CG[mint]
    if (!cgId) continue
    if (!cgIdToMints[cgId]) { cgIdToMints[cgId] = []; cgIds.push(cgId) }
    cgIdToMints[cgId].push(mint)
  }

  if (cgIds.length === 0) {
    return NextResponse.json({ data: {} })
  }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds.join(",")}&vs_currencies=usd`,
      {
        headers: { Accept: "application/json", "User-Agent": "KYMIA/1.0" },
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(8000),
      }
    )

    if (!res.ok) {
      console.error(`[jupiter] CoinGecko error: ${res.status}`)
      return NextResponse.json({ data: {}, error: `CoinGecko returned ${res.status}`, fallback: true }, { status: 200 })
    }

    const cgData = await res.json()

    // Build response in Jupiter price format: { data: { [mint]: { price } } }
    const data: Record<string, { price: number }> = {}
    for (const [cgId, mints] of Object.entries(cgIdToMints)) {
      const price = cgData[cgId]?.usd
      if (price == null) continue
      for (const mint of mints) {
        data[mint] = { price }
      }
    }

    return NextResponse.json({ data })
  } catch (e: any) {
    console.error("[jupiter] Error:", e.message)
    return NextResponse.json(
      { data: {}, error: e.message, fallback: true },
      { status: 200 }
    )
  }
}
