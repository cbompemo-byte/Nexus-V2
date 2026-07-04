import { NextResponse } from "next/server";

// Jupiter Price API v6 — returns spot prices for token IDs
// Note: this is the *price* endpoint, distinct from the swap quote
// endpoint at https://quote-api.jup.ag/v6/quote
const JUPITER_PRICE_URL = "https://price.jup.ag/v6/price";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ids = searchParams.get("ids") || "";

  try {
    const res = await fetch(`${JUPITER_PRICE_URL}?ids=${ids}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 0 },
    });

    if (!res.ok) {
      console.error(`[jupiter] Upstream error: ${res.status} ${res.statusText} for ids=${ids}`);
      return NextResponse.json(
        { data: {}, error: `Jupiter API returned ${res.status}`, fallback: true },
        { status: 200 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    console.error("[jupiter] Error:", e.message);
    return NextResponse.json(
      { data: {}, error: e.message, fallback: true },
      { status: 200 } // 200 so the client degrades gracefully instead of hard-failing
    );
  }
}
