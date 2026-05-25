import { NextResponse } from "next/server";

export const runtime = "nodejs";

const KRAKEN_PAIR = "SOLUSD";

// ── Server-side indicator helpers ────────────────────────────────────────────

function calcSMA(values: number[], period: number): number {
  const s = values.slice(-period);
  return s.reduce((a, b) => a + b, 0) / (s.length || 1);
}

function calcEMAArr(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function calcRSI14(closes: number[]): number {
  const period = 14;
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  const rs = g / (l || 0.001);
  return 100 - 100 / (1 + rs);
}

function calcADX(rows: number[][], period = 14): { adx: number; plusDI: number; minusDI: number } {
  if (rows.length < period * 2) return { adx: 20, plusDI: 20, minusDI: 20 };
  const trs: number[] = [], pDMs: number[] = [], mDMs: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const [, , h, l, c] = rows[i];
    const [, , ph, pl, pc] = rows[i - 1];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - ph, dn = pl - l;
    trs.push(tr);
    pDMs.push(up > dn && up > 0 ? up : 0);
    mDMs.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let pDM = pDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let mDM = mDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let dxSum = 0, dxN = 0;
  for (let i = period; i < trs.length; i++) {
    atr = atr - atr / period + trs[i];
    pDM = pDM - pDM / period + pDMs[i];
    mDM = mDM - mDM / period + mDMs[i];
    const pDI = (pDM / atr) * 100, mDI = (mDM / atr) * 100;
    dxSum += (Math.abs(pDI - mDI) / ((pDI + mDI) || 1)) * 100;
    dxN++;
  }
  const plusDI = (pDM / atr) * 100, minusDI = (mDM / atr) * 100;
  return { adx: dxN > 0 ? dxSum / dxN : 25, plusDI, minusDI };
}

// Fetch Kraken OHLC → parsed rows [time,open,high,low,close,...]
async function krakenOHLC(interval: number, count: number): Promise<number[][]> {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_PAIR}&interval=${interval}&count=${count}`;
  const res = await fetch(url, { next: { revalidate: 0 } });
  const raw = await res.json();
  if (raw.error?.length) throw new Error(raw.error[0]);
  const rows: string[][] = Object.values(raw.result as Record<string, string[][]>)[0];
  return rows.map((r) => [+r[0], +r[1], +r[2], +r[3], +r[4], +r[5], +r[6]]);
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = (await searchParams).get("type") || "";

  try {
    // ── Existing endpoints ────────────────────────────────────────────────────

    if (type === "rsi") {
      const rows = await krakenOHLC(1, 30);
      const data = rows.map((r) => ["", "", "", "", r[4], "", "", ""]);
      return NextResponse.json({ type: "rsi", sym: KRAKEN_PAIR, data });
    }

    if (type === "volume") {
      const url =
        "https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false";
      const res = await fetch(url, { next: { revalidate: 0 } });
      const raw = await res.json();
      const md = raw?.market_data;
      const data = {
        priceChangePercent: String(md?.price_change_percentage_24h ?? 0),
        volume: String((md?.total_volume?.usd ?? 0) / (md?.current_price?.usd ?? 1)),
        highPrice: String(md?.high_24h?.usd ?? 0),
        currentPrice: String(md?.current_price?.usd ?? 0),
      };
      return NextResponse.json({ type: "volume", sym: "SOL", data });
    }

    if (type === "depth") {
      const url =
        "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112";
      const res = await fetch(url, { next: { revalidate: 0 } });
      const raw = await res.json();
      const pairs: Record<string, unknown>[] = (raw?.pairs ?? []).filter(
        (p: Record<string, unknown>) => p.chainId === "solana"
      );
      pairs.sort(
        (a, b) =>
          parseFloat(String((b.volume as Record<string, unknown>)?.h24 ?? 0)) -
          parseFloat(String((a.volume as Record<string, unknown>)?.h24 ?? 0))
      );
      const top = pairs[0];
      const buys = (top?.txns as Record<string, Record<string, number>>)?.h1?.buys ?? 0;
      const sells = (top?.txns as Record<string, Record<string, number>>)?.h1?.sells ?? 0;
      const totalVol = parseFloat(String((top?.volume as Record<string, unknown>)?.h24 ?? 0));
      const totalTx =
        ((top?.txns as Record<string, Record<string, number>>)?.h24?.buys ?? 0) +
        ((top?.txns as Record<string, Record<string, number>>)?.h24?.sells ?? 0) || 1;
      const avgTradeUsd = totalVol / totalTx;
      const priceUsd = parseFloat(String(top?.priceUsd ?? 150));
      const makeLevels = (count: number, totalUsd: number, base: number) =>
        Array.from({ length: Math.min(count, 10) }, (_, i) => [
          String(base * (1 - i * 0.001)),
          String((totalUsd / (Math.min(count, 10) * base)) || 0),
        ]);
      const data = {
        bids: makeLevels(buys, buys * avgTradeUsd, priceUsd),
        asks: makeLevels(sells, sells * avgTradeUsd, priceUsd),
      };
      return NextResponse.json({ type: "depth", sym: "SOL", data });
    }

    if (type === "ema") {
      const rows = await krakenOHLC(5, 30);
      const data = rows.map((r) => ["", "", "", "", r[4], "", "", ""]);
      return NextResponse.json({ type: "ema", sym: KRAKEN_PAIR, data });
    }

    if (type === "dominance") {
      const res = await fetch("https://api.coingecko.com/api/v3/global", {
        next: { revalidate: 60 },
      });
      const data = await res.json();
      const btcDom: number = data?.data?.market_cap_percentage?.btc ?? 0;
      return NextResponse.json({ type: "dominance", btcDom });
    }

    if (type === "fear") {
      const res = await fetch("https://api.alternative.me/fng/?limit=1", {
        next: { revalidate: 300 },
      });
      const data = await res.json();
      const value = parseInt(data?.data?.[0]?.value ?? "50", 10);
      const label = data?.data?.[0]?.value_classification ?? "Neutral";
      return NextResponse.json({ type: "fear", value, label });
    }

    // ── New endpoints ─────────────────────────────────────────────────────────

    // ORACLE — Kraken recent trades → buy vs sell volume
    if (type === "orderflow") {
      const url = `https://api.kraken.com/0/public/Trades?pair=${KRAKEN_PAIR}&count=100`;
      const res = await fetch(url, { next: { revalidate: 0 } });
      const raw = await res.json();
      if (raw.error?.length) throw new Error(raw.error[0]);
      // Format: [price, volume, time, buy_sell, market_limit, misc, trade_id]
      // buy_sell: "b" = buy, "s" = sell
      const trades: string[][] = Object.values(raw.result as Record<string, unknown>)[0] as string[][];
      let buyVol = 0, sellVol = 0;
      for (const t of trades) {
        const vol = parseFloat(t[1]);
        t[3] === "b" ? (buyVol += vol) : (sellVol += vol);
      }
      const total = buyVol + sellVol || 1;
      const buyPressure = buyVol / total;
      const lastPrice = parseFloat(trades[trades.length - 1]?.[0] ?? "0");
      return NextResponse.json({ type: "orderflow", buyVol, sellVol, buyPressure, lastPrice, tradeCount: trades.length });
    }

    // PHANTOM — Deribit futures: index price + open interest + funding rate
    if (type === "options") {
      const [idxRes, sumRes] = await Promise.allSettled([
        fetch("https://www.deribit.com/api/v2/public/get_index_price?index_name=sol_usd", { next: { revalidate: 0 } }),
        fetch("https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=SOL&kind=future", { next: { revalidate: 0 } }),
      ]);
      const indexPrice: number =
        idxRes.status === "fulfilled"
          ? ((await idxRes.value.json())?.result?.index_price ?? 0)
          : 0;
      let openInterest = 0, fundingRate = 0, markPrice = 0;
      if (sumRes.status === "fulfilled") {
        const sd = await sumRes.value.json();
        const items: Record<string, unknown>[] = sd?.result ?? [];
        // Sum OI across all SOL futures
        openInterest = items.reduce((s, i) => s + ((i.open_interest as number) ?? 0), 0);
        // Use perpetual if present, else first contract
        const perp = items.find((i) => String(i.instrument_name ?? "").includes("PERP")) ?? items[0];
        fundingRate = (perp?.funding_8h as number) ?? 0;
        markPrice = (perp?.mark_price as number) ?? indexPrice;
      }
      return NextResponse.json({ type: "options", indexPrice, markPrice, openInterest, fundingRate });
    }

    // TITAN — SMA50 vs SMA200 market regime (Kraken 1h candles)
    if (type === "sma") {
      const rows = await krakenOHLC(60, 220); // 220 so we have enough for SMA200
      const closes = rows.map((r) => r[4]);
      const currentPrice = closes[closes.length - 1];
      const sma50 = calcSMA(closes, 50);
      const sma200 = calcSMA(closes, 200);
      const regime =
        currentPrice > sma50 && sma50 > sma200
          ? "bull"
          : currentPrice < sma50 && sma50 < sma200
          ? "bear"
          : "neutral";
      return NextResponse.json({ type: "sma", currentPrice, sma50, sma200, regime, candles: rows.length });
    }

    // HYDRA — CoinGlass liquidation data (requires free API key; graceful fallback)
    if (type === "liquidations") {
      try {
        const res = await fetch(
          "https://open-api.coinglass.com/public/v2/liquidation_chart?symbol=SOL&interval=h1",
          {
            headers: { "coinglassSecret": process.env.COINGLASS_API_KEY ?? "" },
            next: { revalidate: 0 },
          }
        );
        if (!res.ok) throw new Error("CoinGlass HTTP " + res.status);
        const raw = await res.json();
        if (raw.code !== "0" && raw.code !== 0) throw new Error("CoinGlass: " + raw.msg);
        const data = raw?.data ?? {};
        // data.longLiquidationUsd / shortLiquidationUsd per time bucket
        const longLiqs: number[] = (data.longLiquidationUsd ?? []).slice(-6);
        const shortLiqs: number[] = (data.shortLiquidationUsd ?? []).slice(-6);
        const totalLong = longLiqs.reduce((a: number, b: number) => a + b, 0);
        const totalShort = shortLiqs.reduce((a: number, b: number) => a + b, 0);
        const ratio = totalLong / (totalLong + totalShort || 1);
        return NextResponse.json({ type: "liquidations", longLiqs: totalLong, shortLiqs: totalShort, ratio, source: "coinglass" });
      } catch {
        // Fallback: Deribit perpetual funding rate as liquidation pressure proxy
        const res = await fetch(
          "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=SOL&kind=future",
          { next: { revalidate: 0 } }
        );
        const sd = await res.json();
        const items: Record<string, unknown>[] = sd?.result ?? [];
        const perp = items.find((i) => String(i.instrument_name ?? "").includes("PERP")) ?? items[0] ?? {};
        const fundingRate: number = (perp.funding_8h as number) ?? 0;
        const openInterest: number = (perp.open_interest as number) ?? 0;
        // Positive funding = longs paying = long liquidation risk
        // Negative funding = shorts paying = short liquidation risk
        const longLiqs = Math.max(0, fundingRate) * openInterest * 100;
        const shortLiqs = Math.max(0, -fundingRate) * openInterest * 100;
        const ratio = longLiqs / (longLiqs + shortLiqs || 1);
        return NextResponse.json({ type: "liquidations", longLiqs, shortLiqs, ratio, source: "deribit-proxy", fundingRate, openInterest });
      }
    }

    // DELTA — Cross-exchange arbitrage: Jupiter vs Raydium
    if (type === "arb") {
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const [jupRes, rayRes] = await Promise.allSettled([
        fetch(`https://price.jup.ag/v6/price?ids=${SOL_MINT}`, { next: { revalidate: 0 } }),
        fetch("https://api.raydium.io/v2/main/price", { next: { revalidate: 0 } }),
      ]);
      const jupPrice: number =
        jupRes.status === "fulfilled"
          ? ((await jupRes.value.json())?.data?.[SOL_MINT]?.price ?? 0)
          : 0;
      let raydiumPrice = 0;
      if (rayRes.status === "fulfilled") {
        try {
          const rd = await rayRes.value.json();
          // Raydium v2 price returns {SOL: price, ...} or {data: {SOL: ...}}
          raydiumPrice = rd?.[SOL_MINT] ?? rd?.SOL ?? rd?.data?.[SOL_MINT] ?? rd?.data?.SOL ?? 0;
        } catch { raydiumPrice = 0; }
      }
      // Fallback: DexScreener Raydium pair
      if (!raydiumPrice) {
        try {
          const dsr = await fetch(
            "https://api.dexscreener.com/latest/dex/tokens/" + SOL_MINT,
            { next: { revalidate: 0 } }
          );
          const dsd = await dsr.json();
          const raydiumPair = (dsd?.pairs ?? []).find(
            (p: Record<string, unknown>) => p.chainId === "solana" && p.dexId === "raydium"
          );
          raydiumPrice = parseFloat(String(raydiumPair?.priceUsd ?? 0));
        } catch { raydiumPrice = jupPrice; }
      }
      const spread = raydiumPrice && jupPrice ? raydiumPrice - jupPrice : 0;
      const spreadPct = jupPrice ? (spread / jupPrice) * 100 : 0;
      return NextResponse.json({ type: "arb", jupiterPrice: jupPrice, raydiumPrice, spread, spreadPct });
    }

    // RAZOR — 1m RSI + MACD scalping signal
    if (type === "macd") {
      const rows = await krakenOHLC(1, 50);
      const closes = rows.map((r) => r[4]);
      const rsi = calcRSI14(closes);
      // MACD (12, 26, 9)
      const ema12 = calcEMAArr(closes, 12);
      const ema26 = calcEMAArr(closes, 26);
      const macdLine = ema12.map((v, i) => v - ema26[i]);
      const signalLine = calcEMAArr(macdLine.slice(25), 9); // valid from index 25
      const macdVal = macdLine[macdLine.length - 1];
      const signalVal = signalLine[signalLine.length - 1];
      const histogram = macdVal - signalVal;
      const prevHistogram = macdLine[macdLine.length - 2] - (signalLine[signalLine.length - 2] ?? signalVal);
      const macdCross = histogram > 0 && prevHistogram <= 0 ? "bullish" : histogram < 0 && prevHistogram >= 0 ? "bearish" : "none";
      return NextResponse.json({ type: "macd", rsi, macd: macdVal, signal: signalVal, histogram, macdCross, candles: closes.length });
    }

    // VECTOR — ADX trend strength (Kraken 1h candles)
    if (type === "adx") {
      const rows = await krakenOHLC(60, 50);
      const closes = rows.map((r) => r[4]);
      const { adx, plusDI, minusDI } = calcADX(rows, 14);
      const sma20 = calcSMA(closes, 20);
      const currentPrice = closes[closes.length - 1];
      const trendDir = plusDI > minusDI ? "up" : "down";
      const trendStrength = adx > 40 ? "STRONG" : adx > 25 ? "MODERATE" : "WEAK";
      return NextResponse.json({ type: "adx", adx, plusDI, minusDI, sma20, currentPrice, trendDir, trendStrength });
    }

    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
