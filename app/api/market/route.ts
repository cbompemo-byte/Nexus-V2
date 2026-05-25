import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Kraken pair name for SOL (works from all Vercel regions, no geo-block)
const KRAKEN_PAIR = "SOLUSD";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = (await searchParams).get("type") || "";

  try {
    if (type === "rsi") {
      // Kraken OHLC 1m — close is index 4, same position as Binance klines
      // format: [time, open, high, low, close, vwap, volume, count]
      const url = `https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_PAIR}&interval=1&count=30`;
      const res = await fetch(url, { next: { revalidate: 0 } });
      const raw = await res.json();
      if (raw.error?.length) throw new Error(raw.error[0]);
      // Kraken returns { result: { SOLUSD: [[...]], last: N }, error: [] }
      const rows: unknown[][] = Object.values(raw.result as Record<string, unknown[][]>)[0] as unknown[][];
      // Reshape to match Binance format — client reads index [4] as close
      const data = rows.map((r) => ["", "", "", "", r[4], "", "", ""]);
      return NextResponse.json({ type: "rsi", sym: KRAKEN_PAIR, data });
    }

    if (type === "volume") {
      // CoinGecko SOL market data — price_change_percentage_24h + total_volume
      const url =
        "https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false";
      const res = await fetch(url, { next: { revalidate: 0 } });
      const raw = await res.json();
      const md = raw?.market_data;
      const priceChangePercent: number = md?.price_change_percentage_24h ?? 0;
      const volume: number = md?.total_volume?.usd ?? 0;
      const highPrice: number = md?.high_24h?.usd ?? 0;
      // Shape to match what nexus-client expects on d.data.*
      const data = {
        priceChangePercent: String(priceChangePercent),
        volume: String(volume / (md?.current_price?.usd ?? 1)), // convert USD vol → SOL units
        highPrice: String(highPrice),
        priceChangeUsd: String(md?.price_change_24h ?? 0),
        currentPrice: String(md?.current_price?.usd ?? 0),
      };
      return NextResponse.json({ type: "volume", sym: "SOL", data });
    }

    if (type === "depth") {
      // DexScreener SOL/USDC pair — use 1h buy/sell txn counts as order book proxy
      // Primary Raydium SOL/USDC pool on Solana
      const url =
        "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112";
      const res = await fetch(url, { next: { revalidate: 0 } });
      const raw = await res.json();
      // Pick the highest-volume pair
      const pairs: Record<string, unknown>[] = (raw?.pairs ?? []).filter(
        (p: Record<string, unknown>) => p.chainId === "solana"
      );
      pairs.sort(
        (a: Record<string, unknown>, b: Record<string, unknown>) =>
          parseFloat(String((b.volume as Record<string, unknown>)?.h24 ?? 0)) -
          parseFloat(String((a.volume as Record<string, unknown>)?.h24 ?? 0))
      );
      const top = pairs[0];
      const buys = (top?.txns as Record<string, Record<string, number>>)?.h1?.buys ?? 0;
      const sells = (top?.txns as Record<string, Record<string, number>>)?.h1?.sells ?? 0;
      const totalVol = parseFloat(String((top?.volume as Record<string, unknown>)?.h24 ?? 0));
      // Approximate $ value per trade using 24h volume / 24h tx count
      const totalTx = (top?.txns as Record<string, Record<string, number>>)?.h24?.buys + (top?.txns as Record<string, Record<string, number>>)?.h24?.sells || 1;
      const avgTradeUsd = totalVol / totalTx;
      // Reshape to match what nexus-client expects: bids/asks as [[price, qty], ...]
      // Distribute estimated bid/ask dollar volume across 10 levels
      const makeLevels = (count: number, totalUsd: number, basePrice: number) =>
        Array.from({ length: Math.min(count, 10) }, (_, i) => [
          String(basePrice * (1 - i * 0.001)),
          String((totalUsd / (Math.min(count, 10) * basePrice)) || 0),
        ]);
      const priceUsd = parseFloat(String(top?.priceUsd ?? 150));
      const data = {
        bids: makeLevels(buys, buys * avgTradeUsd, priceUsd),
        asks: makeLevels(sells, sells * avgTradeUsd, priceUsd),
      };
      return NextResponse.json({ type: "depth", sym: "SOL", data });
    }

    if (type === "ema") {
      // Kraken OHLC 5m — same reshape as rsi route
      const url = `https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_PAIR}&interval=5&count=30`;
      const res = await fetch(url, { next: { revalidate: 0 } });
      const raw = await res.json();
      if (raw.error?.length) throw new Error(raw.error[0]);
      const rows: unknown[][] = Object.values(raw.result as Record<string, unknown[][]>)[0] as unknown[][];
      const data = rows.map((r) => ["", "", "", "", r[4], "", "", ""]);
      return NextResponse.json({ type: "ema", sym: KRAKEN_PAIR, data });
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
