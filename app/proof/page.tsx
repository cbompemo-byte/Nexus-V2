// app/proof/page.tsx
// Public proof-of-work page — Server Component, no auth.
// All display strings come from lib/proof-i18n.ts (EN dictionary).
// Cache 60s — one Supabase round-trip per minute regardless of traffic.

import type { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'
import { EN, translateDecision, translateFailReason } from '@/lib/proof-i18n'

export const revalidate = 60

export const metadata: Metadata = {
  title:       'Proof — KYMIA',
  description: 'Every decision the KYMIA agent made, in real time. Observation mode — no real capital.',
}

// ── Colour tokens (match global brand) ────────────────────────────────────────
const C = {
  bg:     '#04060D',
  panel:  'rgba(6,10,18,0.85)',
  border: 'rgba(0,242,254,0.10)',
  cyan:   '#00F2FE',
  green:  '#00FF88',
  red:    '#FF3366',
  gold:   '#FFD700',
  dim:    '#3A6080',
  muted:  '#1A3050',
  text:   '#A8D0EC',
  white:  '#E8F4FF',
}

const MONO = "'JetBrains Mono','Courier New',monospace"

// ── Data fetching ──────────────────────────────────────────────────────────────

async function fetchProofData() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const [decisionsRes, screensRes, statsRes] = await Promise.all([
    supabase
      .from('kymia_dryrun_decisions')
      .select('timestamp,symbol,regime,decision,reason')
      .order('timestamp', { ascending: false })
      .limit(30),
    supabase
      .from('kymia_memecoin_screens')
      .select('screened_at,symbol,name,age_hours,volume_24h,eligible,first_failed_check,fail_reason')
      .order('screened_at', { ascending: false })
      .limit(20),
    supabase.rpc('kymia_proof_stats'),
  ])

  const pgStats = (statsRes.data ?? {}) as {
    core:     { total_decisions: number; depuis: string | null; par_decision: Record<string, number> }
    memecoin: { total_analyses: number; bloques: number; eligibles: number; par_check: Record<string, number> }
  }

  return {
    decisions:    decisionsRes.data ?? [],
    screens:      screensRes.data   ?? [],
    coreStats:    pgStats.core      ?? {},
    memecoinStats: pgStats.memecoin ?? {},
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: '2-digit', day: '2-digit',
      hour:  '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return iso }
}

function fmtVol(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function decisionColor(decision: string | null): string {
  if (!decision) return C.dim
  if (decision === 'WOULD_EXECUTE')       return C.green
  if (decision === 'EPISODE_CLOSED')      return C.cyan
  if (decision === 'GUARD_REFUSED')       return C.gold
  if (/SKIP|IGNORE|UNAVAIL|ZERO|WHITELIST|INSUFFICIENT/.test(decision)) return C.dim
  return C.text
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`,
      borderRadius: 8, padding: '16px 20px', minWidth: 140,
    }}>
      <div style={{ fontSize: 11, color: C.dim, fontFamily: MONO, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.cyan, fontFamily: MONO }}>
        {value}
      </div>
    </div>
  )
}

function SectionHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: C.white, fontFamily: MONO }}>
        ◈ {title}
      </h2>
      <p style={{ margin: '4px 0 0', fontSize: 11, color: C.dim, fontFamily: MONO }}>
        {sub}
      </p>
    </div>
  )
}

function ThCell({ children }: { children: React.ReactNode }) {
  return (
    <th style={{
      padding: '8px 12px', textAlign: 'left', fontSize: 10,
      color: C.dim, fontFamily: MONO, fontWeight: 600,
      borderBottom: `1px solid ${C.muted}`, whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  )
}

function TdCell({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <td style={{
      padding: '8px 12px', fontSize: 11, color: color ?? C.text,
      fontFamily: MONO, borderBottom: `1px solid ${C.muted}`,
      verticalAlign: 'top', maxWidth: 320,
    }}>
      {children}
    </td>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default async function ProofPage() {
  const { decisions, screens, coreStats, memecoinStats } = await fetchProofData()
  const dict = EN

  const since = coreStats.depuis
    ? new Date(coreStats.depuis).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—'

  return (
    <main style={{
      minHeight: '100vh', background: C.bg, color: C.text,
      fontFamily: MONO, padding: '40px 20px',
    }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>

        {/* ── Hero ──────────────────────────────────────────────────────────── */}
        <div style={{ marginBottom: 48, textAlign: 'center' }}>
          <div style={{
            display: 'inline-block', marginBottom: 20,
            padding: '4px 14px', borderRadius: 4,
            background: 'rgba(0,242,254,0.06)', border: `1px solid ${C.border}`,
            fontSize: 10, color: C.cyan, letterSpacing: '0.12em',
          }}>
            {dict.mode_badge}
          </div>
          <h1 style={{
            margin: '0 0 12px', fontSize: 36, fontWeight: 900,
            color: C.white, letterSpacing: '-0.02em',
          }}>
            {dict.hero_title}
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: C.dim }}>
            {dict.hero_subtitle}
          </p>
        </div>

        {/* ── Core stats ────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 48 }}>
          <StatCard label={dict.stat_total}   value={(coreStats.total_decisions ?? 0).toLocaleString()} />
          <StatCard label={dict.stat_since}   value={since} />
          <StatCard label={dict.stat_blocked} value={(memecoinStats.bloques ?? 0).toLocaleString()} />
          <StatCard label={dict.stat_eligible} value={(memecoinStats.eligibles ?? 0).toLocaleString()} />
        </div>

        {/* ── Decision feed ─────────────────────────────────────────────────── */}
        <div style={{ marginBottom: 48 }}>
          <SectionHeader title={dict.section_feed} sub={dict.section_feed_sub} />
          <div style={{
            background: C.panel, border: `1px solid ${C.border}`,
            borderRadius: 8, overflow: 'auto',
          }}>
            {decisions.length === 0 ? (
              <p style={{ padding: 24, color: C.dim, textAlign: 'center', fontSize: 12 }}>
                {dict.empty}
              </p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <ThCell>{dict.col_time}</ThCell>
                    <ThCell>{dict.col_symbol}</ThCell>
                    <ThCell>{dict.col_regime}</ThCell>
                    <ThCell>{dict.col_decision}</ThCell>
                    <ThCell>{dict.col_reason}</ThCell>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d: any, i: number) => (
                    <tr key={i} style={{ opacity: i === 0 ? 1 : 0.85 }}>
                      <TdCell color={C.dim}>{fmtTime(d.timestamp)}</TdCell>
                      <TdCell color={C.cyan}>{d.symbol ?? '—'}</TdCell>
                      <TdCell color={d.regime === 'BULL' ? C.green : d.regime === 'BEAR' ? C.red : C.dim}>
                        {d.regime ?? '—'}
                      </TdCell>
                      <TdCell color={decisionColor(d.decision)}>
                        {translateDecision(d.decision, dict)}
                      </TdCell>
                      <TdCell color={C.dim} >{d.reason ?? '—'}</TdCell>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ── Memecoin blocks ───────────────────────────────────────────────── */}
        <div style={{ marginBottom: 48 }}>
          <SectionHeader title={dict.section_blocks} sub={dict.section_blocks_sub} />
          <div style={{
            background: C.panel, border: `1px solid ${C.border}`,
            borderRadius: 8, overflow: 'auto',
          }}>
            {screens.length === 0 ? (
              <p style={{ padding: 24, color: C.dim, textAlign: 'center', fontSize: 12 }}>
                {dict.empty}
              </p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <ThCell>{dict.col_time}</ThCell>
                    <ThCell>{dict.col_token}</ThCell>
                    <ThCell>{dict.col_age}</ThCell>
                    <ThCell>{dict.col_volume}</ThCell>
                    <ThCell>{dict.col_blocked_by}</ThCell>
                    <ThCell>{dict.col_why}</ThCell>
                  </tr>
                </thead>
                <tbody>
                  {screens.map((s: any, i: number) => (
                    <tr key={i} style={{ opacity: i === 0 ? 1 : 0.85 }}>
                      <TdCell color={C.dim}>{fmtTime(s.screened_at)}</TdCell>
                      <TdCell color={C.white}>
                        <span style={{ color: C.cyan }}>{s.symbol ?? '—'}</span>
                        {s.name && s.name !== s.symbol && (
                          <span style={{ color: C.dim, marginLeft: 6, fontSize: 10 }}>
                            {s.name}
                          </span>
                        )}
                      </TdCell>
                      <TdCell color={C.dim}>
                        {s.age_hours != null ? `${s.age_hours}h` : '—'}
                      </TdCell>
                      <TdCell color={C.dim}>
                        {s.volume_24h != null ? fmtVol(s.volume_24h) : '—'}
                      </TdCell>
                      <TdCell color={s.eligible ? C.green : C.red}>
                        {s.eligible
                          ? dict.eligible_badge
                          : s.first_failed_check ?? dict.blocked_badge}
                      </TdCell>
                      <TdCell color={C.dim}>
                        {s.eligible ? '—' : translateFailReason(s.fail_reason, dict)}
                      </TdCell>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ── Wallet ────────────────────────────────────────────────────────── */}
        <div>
          <SectionHeader title={dict.section_wallet} sub="" />
          <WalletSection dict={dict} />
        </div>

        {/* ── Footer ────────────────────────────────────────────────────────── */}
        <div style={{
          marginTop: 64, paddingTop: 24,
          borderTop: `1px solid ${C.muted}`,
          fontSize: 10, color: C.muted, textAlign: 'center',
        }}>
          KYMIA · OBSERVATION MODE · Updated every 60 seconds
        </div>

      </div>
    </main>
  )
}

// ── Wallet section (needs env var — isolated so error is contained) ────────────

function WalletSection({ dict }: { dict: typeof EN }) {
  let address = '—'
  let solscan = '#'
  try {
    const { getTradingWalletAddress } = require('@/lib/solana/wallet')
    address = getTradingWalletAddress()
    solscan = `https://solscan.io/account/${address}`
  } catch { /* wallet env var not set — show placeholder */ }

  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`,
      borderRadius: 8, padding: '20px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexWrap: 'wrap', gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 10, color: C.dim, marginBottom: 4 }}>
          {dict.wallet_label}
        </div>
        <div style={{ fontSize: 13, color: C.cyan, letterSpacing: '0.04em' }}>
          {address}
        </div>
      </div>
      {solscan !== '#' && (
        <a
          href={solscan}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '8px 16px', borderRadius: 6,
            background: 'rgba(0,242,254,0.08)',
            border: `1px solid rgba(0,242,254,0.20)`,
            color: C.cyan, fontSize: 11, textDecoration: 'none',
            fontFamily: MONO, whiteSpace: 'nowrap',
          }}
        >
          {dict.wallet_verify}
        </a>
      )}
    </div>
  )
}
