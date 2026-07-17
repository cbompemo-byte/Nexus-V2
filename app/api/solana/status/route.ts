import { NextRequest, NextResponse } from "next/server";
import {
  getTradingWalletAddress,
  getSolBalance,
  getTokenBalance,
  MINTS,
} from "@/lib/solana/wallet";

export async function GET(req: NextRequest) {
  // Auth : header x-kymia-key requis
  const adminKey = process.env.KYMIA_ADMIN_KEY;
  if (!adminKey || req.headers.get("x-kymia-key") !== adminKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const address = getTradingWalletAddress();
    const [solBalance, usdcBalance] = await Promise.all([
      getSolBalance(),
      getTokenBalance(MINTS.USDC),
    ]);

    return NextResponse.json({ address, solBalance, usdcBalance, rpcOk: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, rpcOk: false }, { status: 500 });
  }
}
