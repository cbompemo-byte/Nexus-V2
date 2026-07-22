// lib/agents/types.ts
// Shared interfaces for the agent architecture — R17 (SPEC-AGENTS-CONFLUENCE.md).
// Import from here in every agent file and in the orchestrator (runDryRunCycle).

export interface AgentVerdict {
  agent:      string
  vote:       'APPROVE' | 'REJECT' | 'ABSTAIN'
  confidence: number          // 0-100
  reason:     string          // one human-readable sentence, loggable as-is
  data?:      Record<string, unknown>
}

export interface JupiterQuote {
  inAmount:       string
  outAmount:      string
  priceImpactPct: string
}

// Context built by the orchestrator before agents run.
// Enriched progressively: base fields first, then sizeCalculee / quoteJupiter /
// onchainEquity added in the BUY path before edge + risk agents.
export interface CycleContext {
  symbol:         string
  price:          number
  candles4h:      number[] | null   // 4h, ≥200 required by regime agent
  candles1h:      number[] | null   // 1h, shared by signal + sizing agents
  priceData:      Record<string, any> // full price cache — signal needs .change
  mintOut:        string
  // R21 — price lookup key (Kraken/KuCoin ticker, may differ from symbol for wrapped tokens)
  // cbBTC → 'BTC', WETH → 'ETH', all others → same as symbol
  priceSymbol?:   string
  // BUY path only:
  sizeCalculee?:  number
  quoteJupiter?:  JupiterQuote | null
  onchainEquity?: number
}
