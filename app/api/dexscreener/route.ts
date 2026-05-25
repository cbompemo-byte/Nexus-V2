import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = (await searchParams).get("type") || "whale";
  const pair = (await searchParams).get("pair") || "So11111111111111111111111111111111111111112";

  try {
    if (type === "whale") {
      // DexScreener pair info — buy pressure / large trades
      const url = `https://api.dexscreener.com/latest/dex/tokens/${pair}`;
      const res = await fetch(url, { next: { revalidate: 0 } });
      const data = await res.json();
      const p = data?.pairs?.[0];
      if (!p) return NextResponse.json({ type: "whale", buyPressure: 0.5, volume24h: 0 });
      const buys = p.txns?.h1?.buys ?? 0;
      const sells = p.txns?.h1?.sells ?? 0;
      const total = buys + sells || 1;
      const buyPressure = buys / total;
      const volume24h = parseFloat(p.volume?.h24 ?? "0");
      return NextResponse.json({ type: "whale", buyPressure, volume24h, priceUsd: p.priceUsd });
    }

    if (type === "new-tokens") {
      // DexScreener search for newest Solana pairs
      const url = "https://api.dexscreener.com/latest/dex/search?q=SOL";
      const res = await fetch(url, { next: { revalidate: 0 } });
      const data = await res.json();
      const pairs = (data?.pairs ?? [])
        .filter((p: Record<string, unknown>) => p.chainId === "solana")
        .slice(0, 20)
        .map((p: Record<string, unknown>) => {
          const txns = p.txns as Record<string, Record<string, number>> | undefined;
          const volume = p.volume as Record<string, number> | undefined;
          const liquidity = p.liquidity as Record<string, number> | undefined;
          const priceChange = p.priceChange as Record<string, number> | undefined;
          const baseToken = p.baseToken as Record<string, string> | undefined;
          const buys = txns?.h1?.buys ?? 0;
          const sells = txns?.h1?.sells ?? 0;
          const vol = volume?.h24 ?? 0;
          const liq = liquidity?.usd ?? 0;
          const change = priceChange?.h1 ?? 0;
          // Rug score: higher = riskier
          const rugScore =
            (liq < 5000 ? 30 : liq < 50000 ? 15 : 0) +
            (vol < 1000 ? 20 : vol < 10000 ? 10 : 0) +
            (Math.abs(change) > 50 ? 30 : Math.abs(change) > 20 ? 15 : 0) +
            (buys + sells < 10 ? 20 : buys + sells < 50 ? 10 : 0);
          return {
            address: p.pairAddress,
            name: baseToken?.symbol ?? "???",
            price: p.priceUsd,
            change1h: change,
            volume24h: vol,
            liquidity: liq,
            rugScore: Math.min(rugScore, 100),
            buys,
            sells,
          };
        });
      return NextResponse.json({ type: "new-tokens", pairs });
    }

    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
