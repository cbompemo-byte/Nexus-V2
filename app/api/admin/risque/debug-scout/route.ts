// app/api/admin/risque/debug-scout/route.ts
// Rejoue l'évaluation éclaireur (SCOUT) condition par condition sur un token donné.
// Utile pour diagnostiquer pourquoi une entrée SCOUT ne s'est pas déclenchée.
//
// GET ?mint=<mint>                          — évalue toutes les conditions scout
// GET ?mint=<mint>&wallet=<label>          — filtre sur un wallet tier A spécifique
//
// Auth : x-admin-key
// Réponse : objet JSON avec une clé par condition (pass/fail + détail)

export const dynamic    = 'force-dynamic'
export const maxDuration = 30

import { NextRequest, NextResponse }    from 'next/server'
import { createClient }                 from '@supabase/supabase-js'
import { getTokenMarketData, fetchSolPriceUsd } from '@/lib/risque/pumpfun'
import { loadSettings }                 from '@/lib/risque/positions'

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

type ConditionResult =
  | { pass: true;  detail: string }
  | { pass: false; detail: string }

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url  = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }

  const sp           = req.nextUrl.searchParams
  const mint         = sp.get('mint')
  const walletFilter = sp.get('wallet')   // label facultatif

  if (!mint) {
    return NextResponse.json({ error: 'paramètre mint manquant' }, { status: 400 })
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })
  const settings = await loadSettings(supabase)

  // ── 1. Prix + market cap ─────────────────────────────────────────────────────
  let priceUsd:    number | null = null
  let mcapUsd:     number | null = null
  let priceSource: string        = 'unknown'

  try {
    const md = await getTokenMarketData(mint)
    priceUsd    = md?.priceUsd    ?? null
    mcapUsd     = md?.marketCapUsd ?? null
    priceSource = (md as any)?.source ?? 'unknown'

    // Fallback onchain_sol_only → dériver depuis SOL
    if (priceUsd === null && (md as any)?.marketCapSol != null) {
      const solPrice = await fetchSolPriceUsd()
      mcapUsd  = (md as any).marketCapSol * solPrice
      priceUsd = mcapUsd! / 1_000_000_000
      priceSource = 'derived_from_sol'
    }
  } catch (e: any) {
    return NextResponse.json({ error: `getTokenMarketData: ${e.message}` }, { status: 500 })
  }

  const conditions: Record<string, ConditionResult> = {}

  // ── 2. Wallets tier A ────────────────────────────────────────────────────────
  const { data: wallets } = await supabase
    .from('kymia_risque_wallets')
    .select('address, label, tier')
    .eq('tier', 'A')

  const tierAWallets = (wallets ?? []) as Array<{ address: string; label: string; tier: string }>
  if (walletFilter) {
    conditions.tier_a_wallets = tierAWallets.some(w => w.label === walletFilter)
      ? { pass: true,  detail: `wallet "${walletFilter}" est bien tier A` }
      : { pass: false, detail: `wallet "${walletFilter}" n'est pas tier A (ou introuvable)` }
  } else {
    conditions.tier_a_wallets = tierAWallets.length > 0
      ? { pass: true,  detail: `${tierAWallets.length} wallet(s) tier A : ${tierAWallets.map(w => w.label).join(', ')}` }
      : { pass: false, detail: 'aucun wallet tier A configuré' }
  }

  // ── 3. Récents achats tier A sur ce token ────────────────────────────────────
  const windowStart = new Date(Date.now() - 6 * 3600_000).toISOString()
  const tierAAddresses = tierAWallets.map(w => w.address)

  let recentBuysOfTierA: Array<{ wallet_label: string; bought_at: string; sol_amount: number | null; usdc_amount: number | null; market_cap_at_buy: number | null }> = []
  if (tierAAddresses.length > 0) {
    const { data: buys } = await supabase
      .from('kymia_risque_buys')
      .select('wallet_label, wallet_address, bought_at, sol_amount, usdc_amount, market_cap_at_buy')
      .eq('token_mint', mint)
      .gte('bought_at', windowStart)
      .in('wallet_address', tierAAddresses)
    recentBuysOfTierA = (buys ?? []) as typeof recentBuysOfTierA
  }

  // Calculer buyUsdApprox pour chaque achat
  let solPrice = 100
  try { solPrice = await fetchSolPriceUsd() } catch { /* fallback */ }

  const buyUsdSummary = recentBuysOfTierA.map(b => {
    const usd = Math.max((b.sol_amount ?? 0) * solPrice, b.usdc_amount ?? 0)
    return { label: b.wallet_label, bought_at: b.bought_at, usd: parseFloat(usd.toFixed(2)) }
  })

  conditions.recent_tier_a_buys = buyUsdSummary.length > 0
    ? { pass: true,  detail: `${buyUsdSummary.length} achat(s) tier A ≤6h : ${JSON.stringify(buyUsdSummary)}` }
    : { pass: false, detail: 'aucun achat tier A sur ce mint dans les 6 dernières heures' }

  // ── 4. Vérification prix ─────────────────────────────────────────────────────
  conditions.price_available = priceUsd !== null
    ? { pass: true,  detail: `prix=$${priceUsd!.toFixed(8)} mcap=${mcapUsd ? '$' + mcapUsd.toFixed(0) : 'null'} source=${priceSource}` }
    : { pass: false, detail: `prix USD indisponible (source=${priceSource}) — éclaireur impossible` }

  if (priceUsd === null) {
    return NextResponse.json({
      mint,
      settings: {
        scoutMinUsd:      settings.scoutMinUsd,
        scoutMaxMcapUsd:  settings.scoutMaxMcapUsd,
        scoutSizeUsd:     settings.scoutSizeUsd,
        stopLossPct:      settings.stopLossPct,
        blockIfSoldWithin: settings.blockIfSoldWithinMinutes,
        maxConcurrent:    settings.maxConcurrentPositions,
      },
      conditions,
      verdict: 'SKIP — prix USD indisponible',
    })
  }

  // ── 5. buyUsd ≥ scoutMinUsd ──────────────────────────────────────────────────
  // Utilise le premier achat tier A qualifié (ou le wallet filtré)
  const relevantBuys = walletFilter
    ? buyUsdSummary.filter(b => b.label === walletFilter)
    : buyUsdSummary
  const maxBuyUsd = relevantBuys.length > 0 ? Math.max(...relevantBuys.map(b => b.usd)) : 0

  conditions.buy_usd_min = maxBuyUsd >= settings.scoutMinUsd
    ? { pass: true,  detail: `achat max $${maxBuyUsd.toFixed(0)} ≥ scout_min_usd $${settings.scoutMinUsd}` }
    : { pass: false, detail: `achat max $${maxBuyUsd.toFixed(0)} < scout_min_usd $${settings.scoutMinUsd}` }

  // ── 6. mcap ≤ scoutMaxMcapUsd ───────────────────────────────────────────────
  conditions.mcap_max = mcapUsd === null || mcapUsd <= settings.scoutMaxMcapUsd
    ? { pass: true,  detail: `mcap ${mcapUsd ? '$' + mcapUsd.toFixed(0) : 'null'} ≤ $${settings.scoutMaxMcapUsd.toLocaleString()}` }
    : { pass: false, detail: `mcap $${mcapUsd.toFixed(0)} > $${settings.scoutMaxMcapUsd.toLocaleString()} (scout_max_mcap_usd)` }

  // ── 7. Pas de position ouverte ───────────────────────────────────────────────
  const { data: openPos } = await supabase
    .from('kymia_risque_positions')
    .select('id, strategy_tag, status')
    .eq('token_mint', mint)
    .eq('status', 'OPEN')
    .limit(1)
    .maybeSingle()

  conditions.no_open_position = !openPos
    ? { pass: true,  detail: 'aucune position ouverte sur ce mint' }
    : { pass: false, detail: `position ouverte : id=${(openPos as any).id} strategy=${(openPos as any).strategy_tag}` }

  // ── 8. Pas de ré-entrée ──────────────────────────────────────────────────────
  const { data: closedPos } = await supabase
    .from('kymia_risque_positions')
    .select('id, status, exit_at')
    .eq('token_mint', mint)
    .neq('status', 'OPEN')
    .limit(1)
    .maybeSingle()

  conditions.no_reentry = !closedPos
    ? { pass: true,  detail: 'aucune position fermée sur ce mint — première entrée possible' }
    : { pass: false, detail: `token déjà tradé : statut=${(closedPos as any).status} exit_at=${(closedPos as any).exit_at}` }

  // ── 9. Vente récente (block_if_sold) ─────────────────────────────────────────
  let recentSellBlock: ConditionResult = { pass: true, detail: 'block_if_sold_within_minutes=0 — désactivé' }
  if (settings.blockIfSoldWithinMinutes > 0) {
    const cutoff = new Date(Date.now() - settings.blockIfSoldWithinMinutes * 60_000).toISOString()
    const { data: recentSells } = await supabase
      .from('kymia_risque_sells')
      .select('wallet_label, sold_at')
      .eq('token_mint', mint)
      .gte('sold_at', cutoff)
      .limit(5)
    const sells = (recentSells ?? []) as Array<{ wallet_label: string; sold_at: string }>
    recentSellBlock = sells.length === 0
      ? { pass: true,  detail: `aucune vente dans les ${settings.blockIfSoldWithinMinutes}min` }
      : { pass: false, detail: `${sells.length} vente(s) récente(s) : ${sells.map(s => s.wallet_label + '@' + s.sold_at).join(', ')}` }
  }
  conditions.no_recent_sell = recentSellBlock

  // ── 10. Plafond concurrent ───────────────────────────────────────────────────
  const { count: openCount } = await supabase
    .from('kymia_risque_positions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'OPEN')

  const safeConcurrent = settings.liveMode
    ? Math.min(settings.maxConcurrentPositions, Math.floor(settings.capitalUsd / Math.max(settings.positionSizeUsd, 1)))
    : settings.maxConcurrentPositions

  conditions.concurrent_max = (openCount ?? 0) < safeConcurrent
    ? { pass: true,  detail: `${openCount}/${safeConcurrent} positions ouvertes — place disponible` }
    : { pass: false, detail: `${openCount}/${safeConcurrent} positions — plafond concurrent atteint` }

  // ── 11. Score sécurité ───────────────────────────────────────────────────────
  const { data: token } = await supabase
    .from('kymia_risque_tokens')
    .select('risque_score, symbol')
    .eq('mint', mint)
    .maybeSingle()

  conditions.security_score = (token as any)?.risque_score !== 'DANGER'
    ? { pass: true,  detail: `score=${((token as any)?.risque_score ?? 'n/a')} (symbol=${((token as any)?.symbol ?? 'n/a')})` }
    : { pass: false, detail: 'score DANGER — entrée refusée' }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  const failedConditions = Object.entries(conditions)
    .filter(([, v]) => !v.pass)
    .map(([k]) => k)

  const allPass = failedConditions.length === 0
  const verdict = allPass
    ? `PASS — éclaireur s'ouvrirait ($${settings.scoutSizeUsd}, stop -${settings.stopLossPct}%)`
    : `SKIP — ${failedConditions.join(', ')}`

  return NextResponse.json({
    mint,
    symbol: (token as any)?.symbol ?? null,
    priceUsd,
    mcapUsd,
    priceSource,
    settings: {
      scoutMinUsd:       settings.scoutMinUsd,
      scoutMaxMcapUsd:   settings.scoutMaxMcapUsd,
      scoutSizeUsd:      settings.scoutSizeUsd,
      stopLossPct:       settings.stopLossPct,
      blockIfSoldWithin: settings.blockIfSoldWithinMinutes,
      maxConcurrent:     safeConcurrent,
    },
    conditions,
    verdict,
    timestamp: new Date().toISOString(),
  })
}
