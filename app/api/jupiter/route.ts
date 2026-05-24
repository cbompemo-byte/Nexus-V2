import { NextResponse } from "next/server";
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ids = searchParams.get("ids") || "";
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${ids}`, {
      headers: { "Accept": "application/json" },
      next: { revalidate: 0 },
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ data: {} }, { status: 500 });
  }
}
