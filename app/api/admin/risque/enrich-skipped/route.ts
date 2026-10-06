// app/api/admin/risque/enrich-skipped/route.ts
// Enrichit kymia_risque_skipped avec price_1h et price_24h.
// À appeler quotidiennement (cron-job.org avec x-admin-key).
//
// Logique :
//   Phase 1 — rows où price_1h IS NULL et skipped_at < NOW() - 1h  → price_1h  = prix DexScreener courant
//   Phase 2 — rows où price_24h IS NULL et skipped_at < NOW() - 24h → price_24h = prix DexScreener courant
//
// DexScreener est gratuit (pas de clé API). On déduplique par mint pour
// ne faire qu'un appel par token, même si plusieurs rows le concernent.
// Throttle 150 ms entre appels pour rester dans les limites non documentées.

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  const incoming = req.headers.get('x-admin-key')
  return !!adminKey && incoming === adminKey
}

// Récupère le prix USD du meilleur pair DexScreener pour un mint donné.
// Retourne null si indisponible (token retiré, erreur réseau, pas de pair).
async function fetchDexPrice(mint: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(5_000) },
    )
    if (!res.ok) return null
    const data = await res.json()
    const pairs = (data.pairs ?? []) as Array<{
      priceUsd?:   string
      liquidity?:  { usd: number }
    }>
    const best = pairs
      .filter(p => p.priceUsd && parseFloat(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
    return best ? parseFloat(best.priceUsd!) : null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })
  const now      = new Date()

  // Cache des prix déjà récupérés pour éviter un 2e appel DexScreener si le
  // même mint apparaît dans les deux phases.
  const priceCache = new Map<string, number | null>()

  async function getDexPrice(mint: string): Promise<number | null> {
    if (priceCache.has(mint)) return priceCache.get(mint) as number | null
    const price = await fetchDexPrice(mint)
    priceCache.set(mint, price)
    await new Promise(r => setTimeout(r, 150))   // throttle DexScreener
    return price
  }

  // ── Phase 1 : price_1h ────────────────────────────────────────────────────
  const cutoff1h = new Date(now.getTime() -  1 * 3600_000).toISOString()
  const { data: rows1h, error: err1h } = await supabase
    .from('kymia_risque_skipped')
    .select('id, token_mint')
    .is('price_1h', null)
    .lt('skipped_at', cutoff1h)
    .limit(100)

  if (err1h) {
    return NextResponse.json({ error: err1h.message }, { status: 500 })
  }

  // Grouper par mint → un appel DexScreener par token
  const byMint1h = new Map<string, string[]>()
  for (const row of rows1h ?? []) {
    const ids = byMint1h.get(row.token_mint) ?? []
    ids.push(row.id)
    byMint1h.set(row.token_mint, ids)
  }

  let filled1h = 0
  for (const [mint, ids] of byMint1h) {
    const price = await getDexPrice(mint)
    if (price !== null) {
      await supabase
        .from('kymia_risque_skipped')
        .update({ price_1h: price })
        .in('id', ids)
      filled1h += ids.length
    }
  }

  // ── Phase 2 : price_24h ───────────────────────────────────────────────────
  const cutoff24h = new Date(now.getTime() - 24 * 3600_000).toISOString()
  const { data: rows24h, error: err24h } = await supabase
    .from('kymia_risque_skipped')
    .select('id, token_mint')
    .is('price_24h', null)
    .lt('skipped_at', cutoff24h)
    .limit(100)

  if (err24h) {
    return NextResponse.json({ error: err24h.message }, { status: 500 })
  }

  const byMint24h = new Map<string, string[]>()
  for (const row of rows24h ?? []) {
    const ids = byMint24h.get(row.token_mint) ?? []
    ids.push(row.id)
    byMint24h.set(row.token_mint, ids)
  }

  let filled24h = 0
  for (const [mint, ids] of byMint24h) {
    const price = await getDexPrice(mint)   // utilise le cache si mint déjà fetché
    if (price !== null) {
      await supabase
        .from('kymia_risque_skipped')
        .update({ price_24h: price })
        .in('id', ids)
      filled24h += ids.length
    }
  }

  const summary = {
    ok:               true,
    price_1h_rows:    rows1h?.length  ?? 0,
    price_24h_rows:   rows24h?.length ?? 0,
    price_1h_filled:  filled1h,
    price_24h_filled: filled24h,
    mints_fetched:    priceCache.size,
    timestamp:        now.toISOString(),
  }

  console.log(
    `[enrich-skipped]` +
    ` price_1h: ${filled1h}/${rows1h?.length ?? 0} rows` +
    ` | price_24h: ${filled24h}/${rows24h?.length ?? 0} rows` +
    ` | mints: ${priceCache.size}`
  )

  return NextResponse.json(summary)
}
