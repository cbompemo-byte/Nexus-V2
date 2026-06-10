# KYMIA — Autonomous Quant AI Trading Dashboard

> **Multi-agent AI swarm running 24/7 across 180+ crypto markets. Zero human latency. Pure signal.**

---

## Overview

KYMIA is a production-grade autonomous trading dashboard powered by a swarm of 17 specialized AI agents. Each agent monitors a different market dimension — momentum, volatility, sentiment, on-chain flow — and feeds its signal into a consensus engine that executes trades in real time.

Built on Next.js 16 App Router with a fully reactive UI, KYMIA operates in **DEMO mode** (virtual $10,000 portfolio) by default, with a clear upgrade path to live Phantom wallet execution via Jupiter.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         KYMIA UI                            │
│  ┌─────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Swarm  │  │  DecisionZone│  │  Portfolio / Missions  │ │
│  │  Graph  │  │  (Consensus) │  │  Health Monitor        │ │
│  └────┬────┘  └──────┬───────┘  └────────────────────────┘ │
│       │              │                                       │
│  ┌────▼──────────────▼───────────────────────────────────┐  │
│  │              Agent Swarm (17 agents)                  │  │
│  │  LENS · RADAR · RAZOR · VECTOR · SURGE · LEVIATHAN   │  │
│  │  ECHO · PHANTOM · VORTEX · SIGMA · ORACLE · TITAN    │  │
│  │  NEXUS · CIPHER · APEX · GHOST · HYDRA               │  │
│  └────────────────────────────┬──────────────────────────┘  │
│                               │                              │
│  ┌────────────────────────────▼──────────────────────────┐  │
│  │              Real-Time Data Layer                     │  │
│  │  Kraken OHLCV · DexScreener · CoinGecko · Deribit    │  │
│  │  Fear & Greed Index · Helius (on-chain)               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Agent Roster

| Agent | Specialty | Signal Type |
|---|---|---|
| **LENS** | RSI momentum analysis | Oversold/overbought extremes |
| **RADAR** | EMA crossover detection | Trend direction |
| **RAZOR** | MACD + RSI confluence | Entry precision |
| **VECTOR** | ADX trend strength | Trade quality filter |
| **SURGE** | Volume anomaly detection | Breakout confirmation |
| **LEVIATHAN** | Order book pressure | Buy/sell imbalance |
| **ECHO** | Fear & Greed sentiment | Contrarian entries |
| **PHANTOM** | Volatility regime | Risk sizing |
| **VORTEX** | Multi-timeframe trend | Directional bias |
| **SIGMA** | Statistical deviation | Mean reversion |
| **ORACLE** | Macro event scoring | Risk-off alerts |
| **TITAN** | Large-cap dominance | Rotation signals |
| **NEXUS** | Swarm meta-signal | Consensus aggregation |
| **CIPHER** | Pattern recognition | Chart formations |
| **APEX** | Peak detection | Reversal alerts |
| **GHOST** | Low-volume stalking | Accumulation zones |
| **HYDRA** | Multi-leg correlation | Spread opportunities |

---

## Key Features

### Trading Engine
- **LONG & SHORT execution** — Kelly Criterion position sizing, anti-correlation filtering, multi-timeframe signal confirmation
- **Experienced Trader Rules** — Peak-hour confidence thresholds (UTC 07–09, 13–17), consecutive-loss size reduction, daily drawdown circuit breaker
- **Trailing stop-loss** — Activates at 4% profit, trails 3% below peak
- **24/7 Continuous Loop** — Async `while(active)` agent loop with 5s error recovery, never sleeps

### Mission System
Five progressive portfolio milestones that unlock as equity grows:

| Mission | Target | Reward |
|---|---|---|
| FIRST BLOOD | +5% | $500 |
| ALPHA CONFIRMED | +10% | $1,000 |
| MOMENTUM PREDATOR | +25% | $2,500 |
| MARKET DOMINATOR | +50% | $5,000 |
| NEXUS ELITE | +100% | $10,000 |

### UI Panels
- **Swarm Graph** — Live node visualization with conviction pulse, node flash on signal flip
- **DecisionZone** — Real-time vote percentage, EXECUTE/REJECT controls at ≥55% consensus
- **Globe 3D** — Three.js world map with live trade arcs between exchange nodes
- **TradingView Chart** — Full Advanced Chart widget per trade (Bollinger, RSI, MACD, EMA, Volume)
- **Agent Analysis Panel** — Per-trade staggered agent card reveal with cinematic TA overlays
- **Time Scrubber** — Session timeline with green/red trade markers
- **Portfolio Health** — Live equity, win rate, signal count, mission progress
- **Agent Activity Monitor** — 12-agent real-time status grid (ACTIVE / SCAN / IDLE)
- **On-Chain Tab** — Public Solana wallet feed via Helius API

### Crisis Replay
Replay historical Black Swan events (COVID crash, FTX collapse, Terra/LUNA collapse, 2022 crypto winter) and observe how the swarm would have responded.

### Swarm DNA
AI-generated performance personality card after 3+ trades — identifies your trading archetype, strengths, and weakness.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.6 (App Router, Turbopack) |
| Language | TypeScript (strict) |
| UI | React 19, Framer Motion, Three.js |
| Styling | CSS-in-JS (inline), custom keyframe animations |
| Data | Kraken REST, DexScreener, CoinGecko, Deribit, Helius |
| Charts | TradingView Advanced Chart widget |
| Wallet | Phantom (stub, activatable via env var) |
| Swap | Jupiter v6 API (stub, activatable via env var) |
| Deployment | Vercel (Fluid Compute) |

---

## Environment Variables

```env
# Required for On-Chain tab
NEXT_PUBLIC_WALLET_ADDRESS=<your-public-solana-address>
HELIUS_API_KEY=<your-helius-api-key>

# Optional: enable live trading (requires wallet-provider.tsx activation)
NEXT_PUBLIC_TRADING_MODE=DEMO   # or LIVE
```

---

## Getting Started

```bash
# Install dependencies
npm install

# Start development server (Turbopack)
npm run dev

# Build for production
npm run build
```

Open `http://localhost:3000/nexus` to access the dashboard.

---

## DEMO → LIVE Upgrade Path

KYMIA ships in **DEMO mode** by default — a virtual $10,000 portfolio with no real transactions.

To activate live trading:

1. Install Solana packages:
   ```bash
   npm install @solana/wallet-adapter-react @solana/wallet-adapter-phantom @solana/web3.js
   ```
2. Add webpack polyfills to `next.config.ts` (`buffer`, `crypto`, `stream`)
3. Uncomment the implementation in `app/nexus/wallet-provider.tsx`
4. Set `NEXT_PUBLIC_TRADING_MODE=LIVE` in your environment
5. Implement the Jupiter swap in `app/nexus/trade-executor.ts` → `executeTradeJupiter()`

---

## Data Sources

All data is fetched server-side via Next.js API routes to avoid CORS and geo-restrictions:

| Route | Source | Used For |
|---|---|---|
| `/api/jupiter` | Jupiter Price API v6 | Token prices (180+ pairs) |
| `/api/market` | Kraken OHLCV + CoinGecko | Historical candles, market cap |
| `/api/dexscreener` | DexScreener | New token scanner, DEX pairs |
| `/api/debate` | Claude AI | Agent debate synthesis, DNA |
| `/api/helius` | Helius | On-chain wallet transactions |

---

## Project Structure

```
nexus-v2/
├── app/
│   ├── nexus/
│   │   ├── page.tsx              # Route entry point
│   │   ├── nexus-client.tsx      # Main dashboard (all UI + logic)
│   │   ├── trade-executor.ts     # DEMO/LIVE trade abstraction
│   │   └── wallet-provider.tsx   # Phantom wallet stub
│   └── api/
│       ├── jupiter/route.ts      # Price feed proxy
│       ├── market/route.ts       # OHLCV + market data
│       ├── dexscreener/route.ts  # DEX scanner
│       ├── debate/route.ts       # AI synthesis
│       └── helius/route.ts       # On-chain data
├── public/
└── README.md
```

---

## How It Works — Transparency

KYMIA is not a mysterious AI black box. It is **18 mathematical functions** running in parallel on real market data.

### Agent Logic (plain English)

**LENS Agent**
```
fetch Kraken candles
calcRSI(14)
if RSI < 40 → BUY
if RSI > 65 → SELL
```

**LEVIATHAN Agent**
```
fetch DexScreener flow
buyRatio = buys / (buys + sells)
if ratio > 0.62 → BUY
```

**CONSENSUS Agent**
```
count all 17 votes
if 60%+ agree → execute
else → wait
```

Every agent follows the same pattern: fetch public market data → run a deterministic calculation → emit BUY / SELL / HOLD. No black box, no magic.

### 3 Guarantees

- **Full source code on GitHub** — readable by anyone
- **Non-custodial** — your keys, your funds, always
- **Every live trade on Solana blockchain** — verifiable on-chain

### Data Sources (all public APIs)

| Agent | Data Source | Calculation |
|---|---|---|
| LENS | Kraken OHLCV | RSI(14) |
| RADAR | Kraken OHLCV | EMA(9) / EMA(21) crossover |
| RAZOR | Kraken OHLCV | MACD histogram |
| LEVIATHAN | DexScreener | Buy/sell flow ratio |
| ECHO | Alternative.me | Fear & Greed Index |
| SURGE | CoinGecko | Volume spike vs 7-day avg |
| CONSENSUS | All 17 agents | Weighted vote aggregation |
| AEGIS | Portfolio state | Drawdown + risk limits |

---

## License

Private — all rights reserved. Not open source.
