// app/api/admin/smartmoney/collect/route.ts
// Collecte les top-20 wallets GMGN via Parse.bot et les insère dans
// kymia_smart_wallets avec source='GMGN' et label='gmgn_01'…'gmgn_20'.
//
// Auth     : header x-admin-key = KYMIA_ADMIN_KEY
// Env var  : PARSEBOT_API_KEY (clé Parse.bot — free tier 200 crédits/mois)
// Coût     : 1 crédit Parse.bot par appel (top 20 = 1 requête)
//
// Aucun audit déclenché — collecte et audit restent deux étapes séparées.
// ON CONFLICT (address) DO NOTHING : les wallets déjà en base sont préservés,
// y compris w01-w09 existants.

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'

// ── Config ─────────────────────────────────────────────────────────────────────

const PARSEBOT_API_KEY = process.env.PARSEBOT_API_KEY ?? ''
const PARSEBOT_URL     = 'https://api.parse.bot/scraper/fd0acc27-2d9b-49ca-b8ff-216a1b3ce0e0/get_wallet_rankings'

// 30j realized_profit : filtre les "coups de chance" 7j et favorise les
// traders qui closent régulièrement leurs positions.
const PERIOD   = '30d'
const ORDER_BY = 'realized_profit_30d'
const TOP_N    = 20

// ── Pré-filtres bot (avant insertion) ─────────────────────────────────────────
// But : éviter de consommer des crédits Helius sur des wallets évidemment bots.
// Ces seuils sont VOLONTAIREMENT généreux (on laisse le pipeline d'audit
// trancher les cas ambigus). On pré-filtre uniquement l'évident.
//
// Logique :
//   buy_1d > 100  → >100 achats/jour = ~3 000/mois — clairement automatisé
//   buy_30d > 1500 → plus de swaps en 30j que notre seuil bot sur 90j
//                    (même si buy ≈ moitié des swaps, c'est > 3 000 swaps/90d)
const BOT_BUY_1D_MAX  = 100
const BOT_BUY_30D_MAX = 1500

// ── Auth helper ────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  if (!adminKey) return false
  return req.headers.get('x-admin-key') === adminKey
}

// ── Parse.bot / GMGN response shape ───────────────────────────────────────────
// Structure confirmée : { status: "success", data: { rank: [...] } }
// Champs observés sur le leaderboard realized_profit_30d.

interface ParseBotWallet {
  address:          string
  arc_balance?:     string | number
  avg_cost_30d?:    string | number
  buy?:             number   // total achats (toutes périodes)
  buy_1d?:          number   // achats sur les dernières 24h
  buy_30d?:         number   // achats sur les 30 derniers jours
  sell?:            number
  sell_1d?:         number
  sell_30d?:        number
  realized_profit?: number
  realized_profit_30d?: number
  winrate?:         number
  win_rate?:        number
  tags?:            string[]
  [key: string]:    unknown  // champs supplémentaires non documentés
}

// ── Pré-filtre bot ─────────────────────────────────────────────────────────────

function preFilterBot(w: ParseBotWallet): string | null {
  const buy1d  = typeof w.buy_1d  === 'number' ? w.buy_1d  : null
  const buy30d = typeof w.buy_30d === 'number' ? w.buy_30d : null

  if (buy1d !== null && buy1d > BOT_BUY_1D_MAX) {
    return `buy_1d=${buy1d} > ${BOT_BUY_1D_MAX} (bot évident)`
  }
  if (buy30d !== null && buy30d > BOT_BUY_30D_MAX) {
    return `buy_30d=${buy30d} > ${BOT_BUY_30D_MAX} (volume bot 30j)`
  }
  return null
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!PARSEBOT_API_KEY) {
    return NextResponse.json(
      { error: 'PARSEBOT_API_KEY manquant — configure la variable dans Vercel Dashboard → Settings → Environment Variables' },
      { status: 503 },
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Supabase env vars missing' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })

  // ── 1. Appel Parse.bot ───────────────────────────────────────────────────────

  console.log(`[collect] fetching GMGN top ${TOP_N} — period=${PERIOD} orderby=${ORDER_BY}`)

  const url = new URL(PARSEBOT_URL)
  url.searchParams.set('chain',   'sol')
  url.searchParams.set('period',  PERIOD)
  url.searchParams.set('orderby', ORDER_BY)

  let rawWallets: ParseBotWallet[]
  try {
    const res = await fetch(url.toString(), {
      headers: {
        'X-API-Key': PARSEBOT_API_KEY,
        'Accept':    'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[collect] Parse.bot HTTP ${res.status}: ${body.slice(0, 300)}`)
      return NextResponse.json(
        { error: `Parse.bot error ${res.status}`, detail: body.slice(0, 300) },
        { status: 502 },
      )
    }

    const json = await res.json()
    // Structure confirmée : { status: "success", data: { rank: [...] } }
    rawWallets = json?.data?.rank ?? []

    if (!Array.isArray(rawWallets) || rawWallets.length === 0) {
      console.warn('[collect] Parse.bot shape inattendu ou vide:', JSON.stringify(json).slice(0, 300))
      return NextResponse.json({ error: 'Parse.bot returned no wallets', raw: JSON.stringify(json).slice(0, 500) }, { status: 502 })
    }
  } catch (e: any) {
    console.error('[collect] fetch error:', e.message)
    return NextResponse.json({ error: `fetch failed: ${e.message}` }, { status: 502 })
  }

  // Prend les TOP_N premiers — Parse.bot peut en renvoyer plus
  const top = rawWallets.slice(0, TOP_N)
  console.log(`[collect] Parse.bot returned ${rawWallets.length} wallets, using top ${top.length}`)

  // ── 2. Insertion dans kymia_smart_wallets ────────────────────────────────────

  const now         = new Date().toISOString()
  let inserted      = 0
  let skipped       = 0
  let preFiltered   = 0
  let errors        = 0
  let gmgnRank      = 0   // rang dans le leaderboard GMGN (bot exclus non comptés)
  const details: Array<{ label: string; address: string; action: 'inserted' | 'skipped' | 'pre_filtered' | 'error'; reason?: string }> = []

  for (let i = 0; i < top.length; i++) {
    const w       = top[i]
    const address = w.address ?? null
    const rawRank = i + 1   // rang brut dans la réponse Parse.bot

    if (!address || address.length < 32) {
      console.warn(`[collect] rang brut ${rawRank} — adresse manquante ou invalide:`, JSON.stringify(w).slice(0, 100))
      skipped++
      continue
    }

    // ── Pré-filtre bot ──────────────────────────────────────────────────────
    const botReason = preFilterBot(w)
    if (botReason) {
      console.log(`[collect] rang ${rawRank} ${address.slice(0, 8)}… PRE_FILTERED — ${botReason}`)
      preFiltered++
      details.push({ label: `gmgn_raw${rawRank}`, address, action: 'pre_filtered', reason: botReason })
      continue
    }

    // Rang effectif = position dans le leaderboard après exclusion des bots évidents
    gmgnRank++
    if (gmgnRank > TOP_N) break
    const label = `gmgn_${String(gmgnRank).padStart(2, '0')}`   // gmgn_01 … gmgn_20

    // upsert avec ignoreDuplicates=true = ON CONFLICT (address) DO NOTHING
    // Ne modifie PAS les wallets existants (préserve w01-w09 et leur statut).
    const { data: upserted, error } = await supabase
      .from('kymia_smart_wallets')
      .upsert(
        { address, label, source: 'GMGN', status: 'CANDIDATE', updated_at: now },
        // first_seen omis volontairement : DEFAULT now() côté DB, pas de created_at dans le schéma
        { onConflict: 'address', ignoreDuplicates: true },
      )
      .select('address')

    if (error) {
      console.error(`[collect] ${label} ${address.slice(0, 8)}… upsert error:`, error.message, error.code)
      errors++
      details.push({ label, address, action: 'error', reason: `${error.code}: ${error.message}` })
    } else if (!upserted || upserted.length === 0) {
      // ignoreDuplicates=true + row existante → upserted vide = déjà en base
      console.log(`[collect] ${label} ${address.slice(0, 8)}… already exists — skipped`)
      skipped++
      details.push({ label, address, action: 'skipped' })
    } else {
      console.log(`[collect] ${label} ${address.slice(0, 8)}… inserted`)
      inserted++
      details.push({ label, address, action: 'inserted' })
    }
  }

  console.log(`[collect] done — inserted=${inserted} skipped=${skipped} pre_filtered=${preFiltered} errors=${errors}`)

  return NextResponse.json({
    ok:           true,
    source:       'GMGN',
    period:       PERIOD,
    orderby:      ORDER_BY,
    inserted,
    skipped,
    pre_filtered: preFiltered,
    errors,
    total_raw:    top.length,
    wallets:      details,   // contient TOUS les wallets traités, quelle que soit l'issue
    timestamp:    now,
  })
}
