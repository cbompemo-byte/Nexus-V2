// app/api/admin/risque/sync-webhook/route.ts
// Synchronise la liste des adresses du webhook Helius avec kymia_risque_wallets.
//
// Usage :
//   GET  /api/admin/risque/sync-webhook   → compare webhook actuel vs table (dry-run)
//   POST /api/admin/risque/sync-webhook   → applique la mise à jour sur Helius
//
// Variables d'environnement :
//   NEXT_PUBLIC_HELIEUS_KEY  — clé API Helius
//   HELIUS_WEBHOOK_ID        — ID du webhook (optionnel : auto-détecté si absent)
//
// La route liste tous les webhooks Helius, trouve celui dont l'URL de callback
// contient "/api/risque/webhook" (ou utilise HELIUS_WEBHOOK_ID si fourni),
// puis met à jour accountAddresses avec la liste complète de kymia_risque_wallets.
//
// Idempotent : si la liste est déjà synchronisée, rien n'est modifié.

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@supabase/supabase-js'

const HELIUS_API = 'https://api.helius.xyz/v0'

function isAuthorized(req: NextRequest): boolean {
  const adminKey = process.env.KYMIA_ADMIN_KEY
  return !!adminKey && req.headers.get('x-admin-key') === adminKey
}

interface HeliusWebhook {
  webhookID:         string
  webhookURL:        string
  accountAddresses:  string[]
  transactionTypes:  string[]
  webhookType:       string
}

async function getWebhooks(apiKey: string): Promise<HeliusWebhook[]> {
  const res = await fetch(`${HELIUS_API}/webhooks?api-key=${apiKey}`, {
    headers: { 'User-Agent': 'KYMIA/1.0' },
    signal:  AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`Helius GET /webhooks: HTTP ${res.status}`)
  return res.json()
}

async function updateWebhook(
  apiKey:     string,
  webhookId:  string,
  webhook:    HeliusWebhook,
  addresses:  string[],
): Promise<void> {
  const body = {
    webhookURL:       webhook.webhookURL,
    transactionTypes: webhook.transactionTypes,
    accountAddresses: addresses,
    webhookType:      webhook.webhookType,
  }
  const res = await fetch(`${HELIUS_API}/webhooks/${webhookId}?api-key=${apiKey}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'KYMIA/1.0' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Helius PUT /webhooks/${webhookId}: HTTP ${res.status} — ${text}`)
  }
}

async function handler(req: NextRequest, apply: boolean): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = process.env.NEXT_PUBLIC_HELIEUS_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_HELIEUS_KEY manquant' }, { status: 500 })
  }

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ error: 'Supabase env vars manquants' }, { status: 500 })
  }

  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  // ── 1. Charger tous les wallets actifs de la table ────────────────────────
  const { data: walletRows, error: walletErr } = await supabase
    .from('kymia_risque_wallets')
    .select('address, label, active')
    .eq('active', true)

  if (walletErr) {
    return NextResponse.json({ error: `wallets: ${walletErr.message}` }, { status: 500 })
  }

  const dbAddresses = (walletRows ?? []).map(w => w.address as string)

  // ── 2. Récupérer les webhooks Helius ──────────────────────────────────────
  let webhooks: HeliusWebhook[]
  try {
    webhooks = await getWebhooks(apiKey)
  } catch (e: any) {
    return NextResponse.json({ error: `Helius API: ${e.message}` }, { status: 502 })
  }

  if (!webhooks.length) {
    return NextResponse.json({ error: 'Aucun webhook trouvé sur ce compte Helius' }, { status: 404 })
  }

  // ── 3. Trouver le bon webhook ─────────────────────────────────────────────
  const envWebhookId = process.env.HELIUS_WEBHOOK_ID
  let webhook: HeliusWebhook | undefined

  if (envWebhookId) {
    webhook = webhooks.find(w => w.webhookID === envWebhookId)
    if (!webhook) {
      return NextResponse.json({
        error: `HELIUS_WEBHOOK_ID=${envWebhookId} introuvable parmi ${webhooks.length} webhook(s)`,
        webhooks: webhooks.map(w => ({ id: w.webhookID, url: w.webhookURL })),
      }, { status: 404 })
    }
  } else {
    // Auto-détection : webhook dont l'URL contient /api/risque/webhook
    webhook = webhooks.find(w => w.webhookURL.includes('/api/risque/webhook'))
    if (!webhook) {
      // Fallback : prendre le seul webhook s'il n'y en a qu'un
      if (webhooks.length === 1) {
        webhook = webhooks[0]
      } else {
        return NextResponse.json({
          error: 'Impossible d\'auto-détecter le webhook KYMIA (URL ne contient pas /api/risque/webhook). Définir HELIUS_WEBHOOK_ID.',
          webhooks: webhooks.map(w => ({ id: w.webhookID, url: w.webhookURL })),
        }, { status: 400 })
      }
    }
  }

  // ── 4. Calculer le diff ───────────────────────────────────────────────────
  const currentSet = new Set(webhook.accountAddresses)
  const dbSet      = new Set(dbAddresses)

  const toAdd    = dbAddresses.filter(a => !currentSet.has(a))
  const toRemove = webhook.accountAddresses.filter(a => !dbSet.has(a))
  const unchanged = webhook.accountAddresses.filter(a => dbSet.has(a))

  const inSync = toAdd.length === 0 && toRemove.length === 0

  const summary = {
    webhook_id:     webhook.webhookID,
    webhook_url:    webhook.webhookURL,
    db_wallets:     dbAddresses.length,
    webhook_before: webhook.accountAddresses.length,
    webhook_after:  dbAddresses.length,
    to_add:         toAdd,
    to_remove:      toRemove,
    unchanged_count: unchanged.length,
    in_sync:        inSync,
  }

  if (inSync) {
    return NextResponse.json({ ok: true, message: 'Webhook déjà synchronisé', ...summary })
  }

  if (!apply) {
    // GET → dry-run : affiche le diff sans modifier
    return NextResponse.json({ ok: true, dry_run: true, action_required: true, ...summary })
  }

  // ── 5. Mettre à jour le webhook ───────────────────────────────────────────
  try {
    await updateWebhook(apiKey, webhook.webhookID, webhook, dbAddresses)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 })
  }

  console.log(
    `[sync-webhook] mis à jour — ajoutés: ${toAdd.length}, retirés: ${toRemove.length},` +
    ` total: ${dbAddresses.length} adresses`
  )

  return NextResponse.json({
    ok:      true,
    applied: true,
    ...summary,
    wallets_added:   toAdd,
    wallets_removed: toRemove,
  })
}

export async function GET(req: NextRequest)  { return handler(req, false) }
export async function POST(req: NextRequest) { return handler(req, true)  }
