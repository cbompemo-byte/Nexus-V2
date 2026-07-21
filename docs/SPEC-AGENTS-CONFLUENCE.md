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
  edge.confidence     × 0.20    // marge sur les coûts (4× le coût = 100)
  universe.confidence × 0.10    // qualité de liquidité du token
  contexte SOL        × 0.15    // SOL au-dessus de son EMA200 4h = vent porteur

Un agent ABSTAIN → sa composante est redistribuée au prorata des autres
(le score reste sur 100, mais un flag 'partial_score' est loggé).

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
```

---

# PARTIE G — Universe Agent (élargissement des tokens)

## R21 — Univers dynamique

```sql
CREATE TABLE IF NOT EXISTS kymia_universe (
  symbol        text PRIMARY KEY,
  mint          text NOT NULL,
  status        text NOT NULL DEFAULT 'CANDIDATE',
                -- ACTIVE | SUSPENDED | CANDIDATE
  liquidity_usd numeric,
  volume_24h    numeric,
  last_check    timestamptz,
  status_reason text,
  added_at      timestamptz NOT NULL DEFAULT now()
);
```

```
Seed initial : SOL, JUP, JTO, PYTH, RAY (ACTIVE) + cbBTC, WETH (CANDIDATE).
Mints à vérifier au moment de l'implémentation (jamais de mémoire).

Job quotidien (dans le cycle, 1×/24h comme le screening 15min) :
- pour chaque ligne : liquidité + volume via DexScreener/Jupiter quote test
- CANDIDATE → ACTIVE si liquidité > $5M ET volume 24h > $10M
- ACTIVE → SUSPENDED si liquidité < $3M OU volume < $5M (hystérésis :
  seuils de sortie plus bas que d'entrée, évite le yo-yo)
- chaque changement de statut → ligne dans kymia_dryrun_decisions
  (decision: 'UNIVERSE_CHANGE', reason humaine) → visible sur la tape

Le cycle core itère sur SELECT symbol FROM kymia_universe WHERE
status='ACTIVE' au lieu de la constante WHITELIST_CORE.
L'agent universe vote REJECT (véto) pour tout symbole non-ACTIVE.
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

# Candidats agents v2 (spec ultérieure, NE PAS implémenter maintenant)
- mean_reversion : achats de replis RSI en régime BULL (contre-stratégie)
- beta_lag : retard des majors Solana sur les mouvements forts de SOL
- volume_anomaly : volume 3-5× la moyenne avant mouvement de prix
- smart_money : Partie D (R12-R14) — entre comme votant à poids 0.20+
- reentry_cooldown : pas de nouveau trade memecoin sur un mint dont le
  dernier trade a fini SL_HIT il y a < 24-48h (pattern observé le
  20/07 : ré-entrée CUBEMAN 6h après le sommet du pump → -16%).
  À valider avec plus de données avant implémentation.

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
