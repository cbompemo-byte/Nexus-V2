# KYMIA — SPEC Architecture Agents & Score de Confluence
## (Partie E implémentée + fondations Partie D)

Extension de docs/SPEC-STRATEGIE-LIVE.md. Règles numérotées R17+.
Principe directeur : AUCUNE logique de décision ne change — on réorganise
les règles existantes en agents nommés qui rendent des verdicts explicites
et loggés. Même stratégie, mais auditable, extensible, et vraie vis-à-vis
du marketing "swarm".

---

# PARTIE F — Les Agents (restructuration du moteur existant)

## R17 — Définition d'un agent

```
Un agent = une fonction pure qui reçoit le contexte du cycle et retourne
un verdict standardisé :

interface AgentVerdict {
  agent: string            // nom unique, ex 'regime'
  vote: 'APPROVE' | 'REJECT' | 'ABSTAIN'   // ABSTAIN = pas concerné/pas de donnée
  confidence: number       // 0-100 — force de la conviction
  reason: string           // une phrase humaine, affichable telle quelle
  data?: object            // valeurs brutes (ema, rsi, atr...) pour l'audit
}

Règles :
- Un agent ne modifie JAMAIS l'état — il vote, c'est tout
- Un agent qui manque de données vote ABSTAIN (jamais REJECT par défaut —
  même principe que le SKIPPED du CHECK 2 : "je ne sais pas" ≠ "non")
- Tous les agents s'exécutent à CHAQUE évaluation (fin du fail-fast pour
  le core) : on veut le tableau complet des verdicts, pas juste le premier
  blocage. Exception : les guards de sécurité restent véto absolu (voir R19)
```

## R18 — Roster v1 (mapping des règles existantes → agents)

```
AGENT          | RÔLE (règle source)                        | VETO ?
---------------|--------------------------------------------|-------
regime         | R1 — EMA50/EMA200 4h, BULL/BEAR            | oui*
signal         | stratégie EMA/RSI existante (BUY/SELL/NONE)| non
edge           | R3 — gain attendu vs coût du swap          | non
sizing         | R4 — taille ATR (retourne la size en data) | non
risk           | risk-guards.ts — kill switch, fonds, impact| oui
universe       | R21 — le token est-il tradable (liquidité) | oui
rug            | module memecoin, 7 checks (candidats meme) | oui

Formules de confidence (calibration v1, 2026-07-21) :

regime APPROVE : pctAbove = (price−EMA200)/EMA200
  base   = clamp(50 + pctAbove×500, 50, 95)    // 0%→50  10%→95
  bonus  = clamp(emaSpread×200, 0, 10)          // spread EMA50/EMA200
  confidence = min(100, round(base + bonus))
regime REJECT  : pctBelow = (EMA200−price)/EMA200
  confidence = clamp(round(50 + pctBelow×500), 50, 100)
regime ABSTAIN : 0

signal : confidence produite directement par computeSignal
  (65-95 TREND, 60-90 RANGE, 72 MIXED, 0 NO_SIGNAL/ABSTAIN)

edge APPROVE : ratio = gainExpected/costEstimate
  confidence = min(100, round(50 + (ratio−3)/3 × 50))
  // 3× → 50   4.5× → 75   ≥6× → 100
edge REJECT  : 0

sizing : SIZING_RISK_COEFF = 0.00025, cap = MAX_POSITION_PCT × capital ($20)
  NOTE : coefficient d'échelle, PAS un risque-par-trade au sens Kelly.
  La vraie perte dépend du stop de signalAgent (max(2×ATR, 1.2% floor)).
  Calibré pour que le major le moins volatil (SOL, ~0.25% ATR/prix) atterrisse
  au cap. À re-valider après changement de régime de volatilité.
  sizeRaw = (200 × 0.00025) / (atr14/price)
  confidence = 100 si libre (sizeRaw ≤ $20), sinon round(100 × 20 / sizeRaw)
  data contient atr14 et vol_ratio NON arrondis pour calibration.

risk : APPROVE→100 / REJECT→0 (binaire assumé, c'est un véto dur)```

* véto "doux" : en régime BEAR le trade ne s'exécute pas, mais les autres
  agents votent quand même et tout est loggé — on veut savoir ce que le
  système "aurait pensé" même quand la porte est fermée.

Vétos durs (risk, universe, rug) : trade impossible quelle que soit la
somme des votes. Un score de 95 avec un véto risk = pas de trade, loggé
comme tel.
```

## R19 — Flux d'une évaluation

```
Pour chaque symbole du cycle :
1. Construire le contexte (prix, candles, indicateurs — déjà calculés)
2. Exécuter TOUS les agents → tableau de verdicts
3. Calculer le score de confluence (R20)
4. Décision :
   - un véto dur actif → decision selon le véto (GUARD_REFUSED etc.)
   - régime BEAR → BEAR_REGIME_SKIP (véto doux)
   - score < 50 → REJECTED_LOW_SCORE (nouvelle decision)
   - 50-70 → taille 50% du sizing / 70-85 → 100% / >85 → 100% + trailing élargi
   - (comportement épisodes/dry-run inchangé)
5. Logger : la décision globale (table existante) + CHAQUE verdict (R22)
```

# PARTIE E (implémentation) — Score de Confluence

## R20 — Calcul v1

```
Composantes (total 100) — pondérations initiales, revues avec les données :
  regime.confidence   × 0.25    // marché favorable, et à quel point
  signal.confidence   × 0.30    // force du setup EMA/RSI
  edge.confidence     × 0.20    // marge sur les coûts (6× le coût = 100)
  universe.confidence × 0.10    // qualité de liquidité du token
  contexte SOL        × 0.15    // SOL au-dessus de son EMA200 4h = vent porteur

Un agent ABSTAIN → sa composante est redistribuée au prorata des autres
(le score reste sur 100, mais un flag 'partial_score' est loggé).

Décisions issues du score :
  score < 50          → REJECTED_LOW_SCORE (trade bloqué)
  50 ≤ score < 70     → taille × 50%
  score ≥ 70          → taille pleine

Note comparabilité SOL vs non-SOL (important pour R23 / auto-audit) :
  Pour SOL lui-même, sol_context = ABSTAIN (évite le double-comptage avec
  son propre agent regime). Résultat : activeWeight = 0.75 sur SOL vs 0.90
  sur les autres quand SOL a voté. Les scores de SOL et des non-SOL ne sont
  donc PAS directement comparables dans les vues d'audit — le dénominateur
  diffère. Les filtrer séparément dans R23.

score_type : champ obligatoire dans data du verdict confluence.
  DECISION : signal a voté APPROVE ou REJECT (setup réellement évalué).
  AMBIENT  : signal ABSTAIN — mesure la météo du marché, PAS la conviction
             d'un trade. Sur 95% des cycles, score_type='AMBIENT'. Afficher
             un score AMBIENT comme indicateur d'un trade serait trompeur.

Chaque cycle persiste une ligne agent='confluence' dans kymia_agent_verdicts
avec data = { score, score_type, partial_score, active_weight, breakdown }
pour l'audit a posteriori. active_weight et breakdown permettent de
reconstruire exactement d'où vient le score.

Futur : smart_money (Partie D) entrera avec un poids de 0.20-0.25 en
réduisant les autres au prorata. Le calcul vit dans une fonction unique
computeConfluence(verdicts) — un seul endroit à modifier.
```

## R22 — Table des verdicts (le cœur de l'auditabilité)

```sql
CREATE TABLE IF NOT EXISTS kymia_agent_verdicts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_ts     timestamptz NOT NULL DEFAULT now(),
  symbol       text NOT NULL,
  agent        text NOT NULL,
  vote         text NOT NULL,          -- APPROVE | REJECT | ABSTAIN
  confidence   numeric,
  reason       text,
  data         jsonb,
  score_total  numeric,                -- score de confluence du cycle
  decision     text,                   -- décision globale du cycle
  episode_id   uuid                    -- lien vers l'épisode si ouvert
);
CREATE INDEX IF NOT EXISTS idx_verdicts_sym_ts
  ON kymia_agent_verdicts (symbol, cycle_ts DESC);
CREATE INDEX IF NOT EXISTS idx_verdicts_agent
  ON kymia_agent_verdicts (agent, cycle_ts DESC);
CREATE INDEX IF NOT EXISTS idx_verdicts_episode
  ON kymia_agent_verdicts (episode_id) WHERE episode_id IS NOT NULL;
```

Volume : ~7 agents × 7-12 symboles × 288 cycles/jour ≈ 15-25k lignes/jour.
Acceptable, mais prévoir une purge : garder le détail 30 jours, puis ne
conserver que les verdicts liés à un épisode. (Fonction SQL de purge à
créer, appelée 1×/jour.)

## R23 — Auto-audit (la promesse Partie E tenue)

```
Quand des épisodes fermés existent, requêtes d'audit (vues SQL à créer,
affichage /proof en phase 2) :
- win rate et PnL moyen par TRANCHE de score (< 50 jamais tradé mais
  loggé → on voit aussi ce qu'on a raté)
- par agent : corrélation entre sa confidence et le PnL des épisodes
  → un agent non-prédictif après N≥100 épisodes voit son poids questionné
Publication : d'abord interne, puis sur /proof quand N est significatif.

Règles de filtrage obligatoires pour toute comparaison de scores :
1. score_type = 'DECISION' uniquement — les scores AMBIENT mesurent
   la météo du marché, pas la qualité d'un setup. Les mélanger avec
   les scores DECISION biaise toutes les corrélations.
2. active_weight constant — les scores ne sont comparables qu'à
   active_weight égal. Observé en base : 0.25 (SOL, sol_context ABSTAIN)
   à 0.90 (JTO avec SOL en BULL). Filtrer par tranche ou normaliser
   explicitement avant toute agrégation.
3. Segmenter par date de déploiement — les scores ne sont pas comparables
   entre déploiements qui ont modifié les poids ou les agents votants :

   Avant R21 (universe = ABSTAIN) :
     active_weight non-SOL : 0.75 (sol_context ABSTAIN → 0.60)
   Après R21 (universe = APPROVE, poids 0.10) :
     active_weight non-SOL : 0.85 (sol_context ABSTAIN → 0.75)

   Toute vue d'audit cross-période DOIT filtrer sur cycle_ts ≥ date de
   déploiement R21 ou normaliser explicitement par active_weight.
   Référence : colonne active_weight dans kymia_agent_verdicts.data
   (agent='confluence') permet de reconstruire la période exacte.
4. Exclure les épisodes backfillés (sl_backfilled = true) —
   Ces épisodes ont été ouverts AVANT l'implémentation du SL guard.
   Le sl_price a été reconstruit après coup (formule signalAgent appliquée
   à l'entry_price historique, sans l'ATR ni le régime réels du moment).
   La sortie EPISODE_CLOSED_SL qui en résulte est donc plus tardive et
   plus mauvaise que ce que la stratégie aurait produit en conditions réelles.
   Inclure ces épisodes dans le win rate ou le PnL moyen biaiserait les
   stats à la baisse de manière non représentative.
   → Filtre SQL : AND (sl_backfilled IS NULL OR sl_backfilled = false)
     sur la jointure avec kymia_dryrun_positions.
   Épisode connu : RAY ouvert le 2026-07-23, fermé en EPISODE_CLOSED_SL
   avec reason contenant '[BACKFILLED_SL — late trigger, pre-fix episode]'.
```

---

# PARTIE G — Universe Agent (élargissement des tokens)

## R21 — Univers dynamique

```sql
CREATE TABLE IF NOT EXISTS kymia_universe (
  symbol        text PRIMARY KEY,
  mint          text NOT NULL,          -- SPL mint Solana (pour Jupiter)
  status        text NOT NULL DEFAULT 'CANDIDATE',
                -- ACTIVE | SUSPENDED | CANDIDATE
  price_symbol  text,                   -- ticker Kraken/KuCoin (ex. 'BTC' pour cbBTC)
  liquidity_usd numeric,
  volume_24h    numeric,
  last_check    timestamptz,
  status_reason text,
  added_at      timestamptz NOT NULL DEFAULT now()
);
```

```
Seed initial : SOL, JUP, JTO, PYTH, RAY (ACTIVE) + cbBTC, WETH (CANDIDATE).
price_symbol : SOL/JUP/JTO/PYTH/RAY → valeur identique au symbol.
              cbBTC → 'BTC' (Kraken XBTUSD), WETH → 'ETH' (Kraken ETHUSD).
Mints vérifiés via DexScreener à l'implémentation (jamais de mémoire).

RÈGLE D'ÉLIGIBILITÉ ACTIVE : un token n'est promu ACTIVE que si
  (a) price_symbol est présent ET reconnu dans KRAKEN_PAIRS ou KUCOIN_PAIRS, ET
  (b) liquidity agrégée (toutes paires Solana) > $500k ET volume 24h > $250k.
  Sans source de prix valide, le token reste CANDIDATE même si les seuils sont atteints.

Seuils (calibrés pour position ~$20) :
  CANDIDATE → ACTIVE  : liq > $500k ET vol > $250k (ET price_symbol valide)
  ACTIVE → SUSPENDED  : liq < $250k OU vol < $100k
  (hystérésis : seuils de sortie plus bas que d'entrée, évite le yo-yo)

Fragile à surveiller :
  PYTH — liq ~$557k (2× le seuil de suspension). Première à être touchée
  en cas de baisse de liquidité. Surveiller last_check/status_reason.

Suspension → épisode ouvert force-closé immédiatement (Option A) :
  Prix de fermeture = priceCache au moment du job (Kraken/KuCoin).
  Decision loggée : EPISODE_CLOSED, reason "forced close — UNIVERSE_SUSPENDED".
  PnL calculé et persisté. Ensuite seulement : statut → SUSPENDED.

Job quotidien (runUniverseCheckJob — dans runDryRunCycle) :
- rate-limit via MAX(last_check) en DB, 1×/23h
- pour chaque token : DexScreener /latest/dex/tokens/{mint}
  → agréger TOUTES les paires Solana (Jupiter route sur l'ensemble)
- transitions + force-close + logDryRun(UNIVERSE_CHANGE)
- chaque changement de statut → ligne kymia_dryrun_decisions visible sur la tape

Le cycle core itère sur SELECT FROM kymia_universe WHERE status='ACTIVE',
SOL trié en premier (solRegimeVerdict cache). Fallback WHITELIST_CORE si table vide.
Pour chaque token : price_symbol utilisé pour priceCache + getCandles ;
  mint utilisé pour Jupiter (jamais remplacé par price_symbol).

Limite connue du mapping price_symbol (critique en LIVE) :
  Les indicateurs techniques (EMA, RSI, ATR) et le PnL des épisodes sont calculés
  avec le prix Kraken de l'actif sous-jacent (BTC pour cbBTC, ETH pour WETH).
  L'exécution réelle se ferait au prix Solana du wrapped via Jupiter (peg ≈ 1:1
  mais non parfait, notamment en période de stress). En LIVE, le prix de fill
  à écrire en base DOIT venir de la quote/du swap Jupiter, jamais du priceCache.
  Cette règle est déjà documentée dans le SETUP — elle devient critique ici.

L'agent universe vote REJECT (véto dur) si liquidity_usd < $250k même pour
un token ACTIVE (protection intra-cycle si le job n'a pas encore tourné).
ABSTAIN si pas de données (fallback WHITELIST_CORE sans DB).
APPROVE sinon, confidence linéaire : $500k → 50, $25M → 100.
```

---

# PARTIE H — Early Scout Agent (zone 0-24h, OBSERVATION PURE)

## R24 — Mandat strict

```
JAMAIS de trade (même fictif au sens paper) en zone < 24h. Le scout
OBSERVE et prédit, pour apprendre.

Pipeline (extension du screening memecoin existant, même cadence 15min) :
- tokens rejetés PREFILTER pour l'âge uniquement (âge < 24h mais
  volume déjà > 100k$) → candidats scout
- pour chacun : snapshot dans kymia_scout_tracks :
  { mint, symbol, first_seen, age_at_detect, liq, vol, holders,
    checks partiels exécutables (1, 4), snapshot_price }
- job de suivi (comme updatePaperTrades) : re-visite à +6h, +24h, +72h :
  { price_vs_snapshot, liq_vs_snapshot, statut: ALIVE | RUGGED | DEAD
    (liq -90% = RUGGED, volume ~0 = DEAD) }
```

```sql
CREATE TABLE IF NOT EXISTS kymia_scout_tracks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint          text NOT NULL,
  symbol        text,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  age_at_detect numeric,
  snapshot      jsonb NOT NULL,      -- liq, vol, holders, checks, prix
  t6h           jsonb,
  t24h          jsonb,
  t72h          jsonb,
  outcome       text                 -- ALIVE | RUGGED | DEAD (à 72h)
);
CREATE INDEX IF NOT EXISTS idx_scout_mint ON kymia_scout_tracks (mint);
```

```
Objectif : après 3-4 semaines, analyse "quels signaux à H+1 prédisent
ALIVE à 72h ?" → si un pattern robuste émerge, il deviendra un agent
votant pour le module memecoin. Sinon, on aura prouvé que la zone <24h
est intradable sans smart money — conclusion précieuse aussi.
```

---

# PARTIE I — Benchmark Agent (R25-R26)
Long-only spot : un PnL positif seul ne prouve rien, il faut le comparer
à ne rien faire. Sans benchmark on publie du bêta déguisé en alpha.

R25 — table kymia_benchmark { symbol PK, baseline_price, baseline_at,
last_price, last_update }. Job dans le cycle (1×/h) : si pas de ligne
pour un symbole ACTIF → INSERT au prix courant ; sinon UPDATE last_price.
Métriques (vue/fonction SQL, pas de stockage redondant) :
- hold_pct = (last - baseline)/baseline
- agent_pct = somme des pnl_pct des épisodes fermés du symbole
- alpha = agent_pct - hold_pct
- exposure_pct = temps en position / temps total
- max_drawdown comparé hold vs épisodes agent
Un alpha négatif est publié comme les autres. Alpha faible + drawdown
inférieur = bon résultat : afficher les deux ensemble.

R26 — publication /proof "Agent vs Buy & Hold" par symbole et global,
observation et live séparés (règle R2). Mention obligatoire de la durée.

---

# PARTIE J — Shadow Regime Evaluation (R-shadow, 2026-07-23)
Observation pure des variantes du filtre de régime. Zéro impact décisionnel.

table kymia_regime_shadow { id, cycle_ts, symbol, variant, regime, price, data }
Variantes : V1_current (référence), V2_fast4h (EMA20/50 4h), V3_cross (croisement seul),
V4_price (prix seul), V5_momentum (EMA20/50 1h + gap > 0.1%).
Analyse : kymia_regime_shadow_stats() — spread = fwd_bull - fwd_bear par variante/symbole.
V5_momentum : pente EMA50(1h) rejetée (3 points fiables sur 52 bougies = bruit).
Remplacée par gap > 0.1% : même esprit (momentum confirmé), robuste.

Volume : ~10 000 lignes/jour. Purge à planifier : conserver 60 jours (~600k lignes),
purger au-delà via fonction SQL 1×/semaine (comme kymia_agent_verdicts).
Spread_1h fiable à partir de N≥100 cycles (≈8h), spread_24h à partir de N≥576 (≈2 jours).

---

# Candidats agents v2 (spec ultérieure, NE PAS implémenter maintenant)
- mean_reversion : achats de replis RSI en régime BULL (contre-stratégie)
- beta_lag : retard des majors Solana sur les mouvements forts de SOL
- volume_anomaly : volume 3-5× la moyenne avant mouvement de prix
- smart_money : Partie D (R12-R14) — entre comme votant à poids 0.20+

# Filtres d'entrée memecoin implémentés (R9 — module memecoin uniquement)
- reentry_cooldown (2026-07-22) : refus d'ouverture si SL_HIT sur ce mint
  il y a < 24h. Vérifié dans openPaperTrade (lib/memecoin/paper.ts) via
  requête kymia_memecoin_paper. Validé par 9 trades obs. : CUBEMAN 5×/32h,
  TOESCOIN 2× ; 8 SL / 9 trades, -2.35 USDC.
- momentum_h6 (2026-07-22) : refus si priceChange.h6 > +80% (DexScreener).
  Vérifié dans runMemeScreening (lib/memecoin/screen.ts) avant openPaperTrade.
  Si donnée absente → non bloquant (skip du filtre).

---

# Ordre d'implémentation

1. R17-R18-R19 : restructuration en agents, comportement identique
   (vérifiable : les décisions avant/après doivent être les mêmes sur
   les mêmes données)
2. R22 : table des verdicts + SQL AVANT déploiement (règle établie)
3. R20 : score de confluence + nouvelle decision REJECTED_LOW_SCORE
4. R21 : Universe Agent + table + cbBTC/WETH en CANDIDATE
5. Mise à jour front : LIVE REASONING branché sur les vrais verdicts,
   nombre d'agents réel sur la landing, tape affiche UNIVERSE_CHANGE
6. R24 : Early Scout (chantier séparé, peut suivre de quelques jours)
7. R23 : vues d'audit quand les épisodes existent

# Garde-fous du chantier
- Étape 1 se valide par comparaison : mêmes entrées → mêmes décisions
  qu'avant la restructuration. Aucune "amélioration" de logique en même
  temps que la réorganisation.
- Un seul déploiement par étape, SQL toujours avant le code.
- Le front (étape 5) ne vient qu'après 24h de verdicts propres en base.
