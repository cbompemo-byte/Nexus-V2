import { NextResponse } from "next/server";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_BASE = "https://api.helius.xyz/v0";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const wallet = (await searchParams).get("wallet") || "";
  const type = (await searchParams).get("type") || "txs";

  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 });
  }

  if (!HELIUS_API_KEY) {
    return NextResponse.json({ error: "HELIUS_API_KEY not configured" }, { status: 503 });
  }

  try {
    if (type === "balance") {
      const res = await fetch(
        `${HELIUS_BASE}/addresses/${wallet}/balances?api-key=${HELIUS_API_KEY}`,
        { next: { revalidate: 30 } }
      );
      const data = await res.json();
      const solBalance = (data.nativeBalance || 0) / 1e9;
      return NextResponse.json({ balance: solBalance });
    }

    // type === "txs" — fetch parsed transactions
    const res = await fetch(
      `${HELIUS_BASE}/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=25`,
      { next: { revalidate: 30 } }
    );
    const data = await res.json();
    return NextResponse.json(Array.isArray(data) ? data : []);
  } catch (e) {
    console.error("[helius route]", e);
    return NextResponse.json({ error: "upstream error" }, { status: 502 });
  }
}
