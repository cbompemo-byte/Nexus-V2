import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = (await searchParams).get("type") || "";
  const sym = (await searchParams).get("sym") || "SOLUSDT";

  try {
    if (type === "rsi") {
      // Binance klines for RSI calculation (1m, last 30 candles)
      const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&limit=30`;
      const res = await fetch(url, { next: { revalidate: 0 } });
      const data = await res.json();
      return NextResponse.json({ type: "rsi", sym, data });
    }

    if (type === "volume") {
      // Binance 24hr ticker
      const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`;
      const res = await fetch(url, { next: { revalidate: 0 } });
      const data = await res.json();
      return NextResponse.json({ type: "volume", sym, data });
    }

    if (type === "depth") {
      // Binance order book depth
      const url = `https://api.binance.com/api/v3/depth?symbol=${sym}&limit=20`;
      const res = await fetch(url, { next: { revalidate: 0 } });
      const data = await res.json();
      return NextResponse.json({ type: "depth", sym, data });
    }

    if (type === "ema") {
      // Binance 5m klines for EMA 9/21
      const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=5m&limit=30`;
      const res = await fetch(url, { next: { revalidate: 0 } });
      const data = await res.json();
      return NextResponse.json({ type: "ema", sym, data });
    }

    if (type === "dominance") {
      // CoinGecko global (BTC dominance)
      const url = "https://api.coingecko.com/api/v3/global";
      const res = await fetch(url, { next: { revalidate: 60 } });
      const data = await res.json();
      const btcDom: number = data?.data?.market_cap_percentage?.btc ?? 0;
      return NextResponse.json({ type: "dominance", btcDom });
    }

    if (type === "fear") {
      // Fear & Greed index
      const url = "https://api.alternative.me/fng/?limit=1";
      const res = await fetch(url, { next: { revalidate: 300 } });
      const data = await res.json();
      const value = parseInt(data?.data?.[0]?.value ?? "50", 10);
      const label = data?.data?.[0]?.value_classification ?? "Neutral";
      return NextResponse.json({ type: "fear", value, label });
    }

    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
