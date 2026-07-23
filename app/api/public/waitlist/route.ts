// app/api/public/waitlist/route.ts
// Inscription waitlist live trading — endpoint public en écriture.
//
// Sécurité :
//   - Upsert silencieux sur email existant (pas de 409 = pas d'énumération)
//   - Rate-limit in-memory par IP : 5 requêtes / heure
//     NOTE : non partagé entre instances Vercel (best-effort, pas cryptographique).
//     Suffisant pour le spam de base. Si le volume l'exige, remplacer par Upstash Redis.
//   - Validation email côté serveur
//   - SUPABASE_SERVICE_ROLE_KEY jamais exposé au client

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ── Rate limit ─────────────────────────────────────────────────────────────────
const ipLog      = new Map<string, number[]>()
const WINDOW_MS  = 3_600_000   // 1 heure
const MAX_REQ    = 5

function isRateLimited(ip: string): boolean {
  const now    = Date.now()
  const cutoff = now - WINDOW_MS
  const prev   = (ipLog.get(ip) ?? []).filter(t => t > cutoff)
  if (prev.length >= MAX_REQ) return true
  ipLog.set(ip, [...prev, now])
  return false
}

// ── Email validation ───────────────────────────────────────────────────────────
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())
}

// ── Handler ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  if (isRateLimited(ip)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  let body: { email?: string; source?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const email  = (body.email  ?? '').trim().toLowerCase()
  const source = (body.source ?? 'dashboard').slice(0, 50)   // cap longueur

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )

    // ignoreDuplicates: true = ON CONFLICT (email) DO NOTHING
    // Pas de 409, pas d'énumération — l'appelant reçoit toujours 200
    const { error } = await supabase
      .from('kymia_waitlist')
      .upsert({ email, source }, { onConflict: 'email', ignoreDuplicates: true })

    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[api/public/waitlist]', e?.message)
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
