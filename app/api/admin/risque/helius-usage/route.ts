// app/api/admin/risque/helius-usage/route.ts
// Lecture directe de l'utilisation réelle des crédits Helius via leur API officielle.
//
// Usage :
//   GET /api/admin/risque/helius-usage
//   Header : x-admin-key: <KYMIA_ADMIN_KEY>
//
// Retourne :
//   - usage_api   : données brutes de l'API Helius (credits_used, credits_limit, etc.)
//   - estimate    : décomposition estimée de la consommation par source
//   - internal    : état de kymia_helius_quota (smart money audit seulement)
//
// Note : kymia_helius_quota ne couvre que l'audit smart money (getSignaturesForAddress).
//   Les webhooks, DAS getAsset, et RPC getAccountInfo ne sont pas comptés en interne.
//   Cet endpoint est la source de vérité pour la consommation totale.

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const heliusKey = process.env.NEXT_PUBLIC_HELIEUS_KEY
  if (!heliusKey) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_HELIEUS_KEY manquant' }, { status: 500 })
  }

  // ── 1. Usage réel via l'API Helius ────────────────────────────────────────
  let usageApi: Record<string, unknown> | null = null
  let usageErr: string | null = null

  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/api-info?api-key=${heliusKey}`,
      { headers: { 'User-Agent': 'KYMIA/1.0' }, signal: AbortSignal.timeout(8_000) },
    )
    if (res.ok) {
      usageApi = await res.json()
    } else {
      usageErr = `HTTP ${res.status} — ${await res.text().catch(() => '')}`
    }
  } catch (e: any) {
    usageErr = e.message
  }

  // ── 2. Interne : kymia_helius_quota (smart money audit seulement) ─────────
  let internalQuota: Record<string, unknown> | null = null

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (supaUrl && supaKey) {
    const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })
    const { data } = await supabase
      .from('kymia_helius_quota')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
    if (data) internalQuota = data as Record<string, unknown>
  }

  // ── 3. Estimation de consommation par source ──────────────────────────────
  // Basée sur l'architecture actuelle (1 webhook = 1 achat observé en moyenne,
  // 1 DAS + 1 RugCheck [~3 credits] par token nouveau, etc.)
  //
  // Crédits Helius par opération :
  //   - Webhook delivery           : 1 crédit / tx reçue
  //   - DAS getAsset               : 1 crédit / appel  (1 fois par token NOUVEAU)
  //   - RPC getAccountInfo (curve) : 1 crédit / appel  (1 fois par cycle monitor par position)
  //   - getSignaturesForAddress    : variable (~2-10 credits selon nb pages)
  //   - RugCheck                   : 0 crédit (API externe indépendante)
  //
  // Volumétrie observée (à ajuster selon vos métriques) :
  //   - ~50-200 tx/jour reçues en webhook (dépend de l'activité des wallets suivis)
  //   - ~5-20 tokens NOUVEAUX/jour (DAS+RugCheck seulement sur les nouveaux)
  //   - ~10 positions ouvertes max × 2 cycles/min × 1440 min/jour = ~28 800 getAccountInfo/jour
  //     → mais le monitor tourne 1x/min max, et avec 10 positions = 10 getAccountInfo/cycle
  //     → à 60 cycles/heure × 24h × 10 pos = 14 400 crédits/jour seulement pour le monitor
  //   - Smart money audit (désactivé) : 0
  //
  // OPTIMISATION PRINCIPALE : watch route désactivée — économise ~1000-5000 credits/jour.

  const estimate = {
    note: 'Estimations indicatives — volumétrie réelle dans usage_api',
    sources: [
      {
        source:        'Webhook delivery (Helius Enhanced Transactions)',
        credits_per:   '1 crédit / tx',
        frequency:     'Toutes les transactions des wallets suivis',
        daily_low:     50,
        daily_high:    500,
        optimisable:   false,
        note:          'Coût fixe — proportionnel à l\'activité des wallets',
      },
      {
        source:        'DAS getAsset (symbol/name)',
        credits_per:   '1 crédit / appel',
        frequency:     '1 fois par token NOUVEAU (depuis ce déploiement)',
        daily_low:     5,
        daily_high:    30,
        optimisable:   true,
        note:          'FIX DÉPLOYÉ : skip si symbol déjà en base — économise ~95% des appels',
      },
      {
        source:        'RPC getAccountInfo (bonding curve, monitor)',
        credits_per:   '1 crédit / appel',
        frequency:     '1 × nombre positions ouvertes × cycles/jour',
        daily_low:     100,
        daily_high:    1_500,
        optimisable:   true,
        note:          'Proportionnel au nombre de positions ouvertes × fréquence du cron',
      },
      {
        source:        'getSignaturesForAddress (smart money audit)',
        credits_per:   '1-10 crédits / wallet / appel',
        frequency:     'Désactivé (guard_triggered ou manuel)',
        daily_low:     0,
        daily_high:    0,
        optimisable:   false,
        note:          'Désactivé — ne contribue plus à la consommation quotidienne',
      },
      {
        source:        '/api/risque/watch (DÉSACTIVÉE)',
        credits_per:   '~3 crédits / token suivi (getAccountInfo curve + SOL price)',
        frequency:     'DÉSACTIVÉE — était la cause principale de l\'épuisement',
        daily_low:     0,
        daily_high:    0,
        optimisable:   true,
        note:          'Route supprimée de cron-job.org — économie estimée ~3 000-10 000 crédits/jour',
      },
    ],
    total_daily_estimate: {
      low:  155,
      high: 2_030,
      comment: 'Hors watch désactivée. Dominant = monitor (getAccountInfo × positions × cycles).',
    },
  }

  return NextResponse.json({
    ok:              true,
    usage_api:       usageApi,
    usage_api_error: usageErr,
    internal_quota:  internalQuota,
    estimate,
  })
}
