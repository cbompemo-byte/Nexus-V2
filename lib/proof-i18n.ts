// lib/proof-i18n.ts
// Single source of truth for all display strings on the /proof page.
// All strings are in English (EN). To add FR: duplicate the EN object
// with FR translations and select via locale param.
// NEVER hardcode display strings in JSX — always reference this file.

export interface ProofDict {
  // Hero
  hero_title:        string
  hero_subtitle:     string
  mode_badge:        string

  // Section headers
  section_feed:      string
  section_feed_sub:  string
  section_blocks:    string
  section_blocks_sub:string
  section_wallet:    string

  // Column headers — decisions
  col_time:          string
  col_symbol:        string
  col_regime:        string
  col_decision:      string
  col_reason:        string

  // Column headers — memecoin blocks
  col_token:         string
  col_age:           string
  col_volume:        string
  col_blocked_by:    string
  col_why:           string

  // Wallet
  wallet_label:      string
  wallet_verify:     string

  // Stats labels
  stat_total:        string
  stat_since:        string
  stat_blocked:      string
  stat_eligible:     string

  // Misc
  eligible_badge:    string
  blocked_badge:     string
  empty:             string

  // Landing-specific (tape + rejected feed)
  loading:             string
  tape_badge:          string
  last_decision:       string
  mins_ago:            string
  stat_analyzed:       string
  stat_approved:       string
  approved_tagline:    string
  section_rejected:    string
  section_rejected_sub:string
  blocked_card_badge:  string

  // Decision code → human sentence
  decisions: Record<string, string>

  // fail_reason prefix → human sentence (ordered, first match wins)
  fail_reasons: Array<{ match: string; label: string }>
}

export const EN: ProofDict = {
  hero_title:         'Proof, not promises',
  hero_subtitle:      'Watch the agent think in real time',
  mode_badge:         'OBSERVATION MODE — no real capital deployed',

  section_feed:       'Live decision feed',
  section_feed_sub:   'Every signal the agent evaluated — and what it decided',
  section_blocks:     'What the system blocked',
  section_blocks_sub: 'Memecoins that failed the security pipeline',
  section_wallet:     'Verify it yourself — the wallet is public',

  col_time:           'Time',
  col_symbol:         'Asset',
  col_regime:         'Regime',
  col_decision:       'Decision',
  col_reason:         'Reason',
  col_token:          'Token',
  col_age:            'Age',
  col_volume:         'Vol 24h',
  col_blocked_by:     'Blocked by check',
  col_why:            'Why',

  wallet_label:       'Trading wallet address',
  wallet_verify:      'View on Solscan →',

  stat_total:         'Total decisions',
  stat_since:         'Tracking since',
  stat_blocked:       'Tokens blocked',
  stat_eligible:      'Passed all checks',

  eligible_badge:     'PASSED',
  blocked_badge:      'BLOCKED',
  empty:              '— no data yet —',

  loading:             'Loading…',
  tape_badge:          'LIVE DECISIONS · OBSERVATION',
  last_decision:       'Last decision',
  mins_ago:            'min ago',
  stat_analyzed:       'ANALYZED',
  stat_approved:       'APPROVED',
  approved_tagline:    'High standards. Zero compromise.',
  section_rejected:    'What the system blocked',
  section_rejected_sub:'Every token that failed the 7-check security pipeline',
  blocked_card_badge:  'BLOCKED',

  decisions: {
    WOULD_EXECUTE:               'Signal confirmed — would execute',
    EPISODE_CLOSED:              'Position closed',
    EPISODE_CLOSED_SL:           'Position closed — stop loss triggered',
    ALREADY_IN_POSITION:         'Already in position — skipped',
    BEAR_REGIME_SKIP:            'Position declined — bear market',
    NO_SIGNAL:                   'Monitoring — no valid setup',
    SHORT_SIGNAL_IGNORED_SPOT:   'Exit signal — staying in cash',
    GUARD_REFUSED:               'Signal detected — blocked by risk guards',
    REJECTED_LOW_SCORE:          'Setup too weak — confluence score below threshold',
    CANDLES_UNAVAILABLE:         'Data unavailable — skipped for safety',
    NOT_IN_WHITELIST:            'Token not in approved list',
    EDGE_INSUFFICIENT:           'Edge below cost threshold — skipped',
    SIZE_ZERO:                   'Position size too small — skipped',
    UNIVERSE_CHANGE:             'Universe updated — token tradability changed',
    UNIVERSE_ANOMALY:            'Universe check — liquidity data spike detected, update skipped',
  },

  // Ordered: more specific matches first
  fail_reasons: [
    { match: 'no sell route',       label: 'No sell route found — likely honeypot' },
    { match: 'sell price impact',   label: 'High sell impact — possible honeypot' },
    { match: 'LP locked',           label: 'Liquidity not locked — creator can drain the pool' },
    { match: 'liquidity < $50k',    label: 'Liquidity too thin to exit safely' },
    { match: 'single holder',       label: 'Single wallet controls too much supply' },
    { match: 'top10',               label: 'Whale concentration — top 10 hold too much' },
    { match: 'creator holds',       label: 'Creator still holds a large position' },
    { match: 'insider networks',    label: 'Insider network detected' },
    { match: 'critical risks',      label: 'Critical risks flagged by RugCheck' },
    { match: 'score = danger',      label: 'RugCheck: danger rating' },
    { match: 'mint authority',      label: 'Mint authority not revoked — supply can be inflated' },
    { match: 'age',                 label: 'Too young — maximum mortality zone' },
    { match: 'vol',                 label: 'Insufficient volume' },
    { match: 'PREFILTER',           label: 'Did not meet minimum age or volume' },
  ],
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Translate a decision code. Falls back to the raw code. */
export function translateDecision(code: string | null, dict: ProofDict): string {
  if (!code) return '—'
  return dict.decisions[code] ?? code
}

/** Translate a fail_reason string via prefix matching (first match wins). */
export function translateFailReason(raw: string | null, dict: ProofDict): string {
  if (!raw) return '—'
  const entry = dict.fail_reasons.find(f =>
    raw.toLowerCase().includes(f.match.toLowerCase())
  )
  return entry?.label ?? raw
}
