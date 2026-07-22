# KYMIA — SPEC Stratégie Live Solana (Phase 1)
## Spot-only + Module Memecoin sécurisé

Spec à donner à Claude Code. Chaque règle a un identifiant (R1, R2...) pour
pouvoir en discuter/modifier individuellement.

---

# PARTIE A — Adaptation de la stratégie EMA/RSI au spot-only

## R1 — Filtre de régime (PRIORITÉ ABSOLUE)

L'agent ne peut ouvrir AUCUNE position si le marché n'est pas en tendance haussière.

```
Condition d'activation (par symbole) :
  prix_actuel > EMA200 (timeframe 4h)
  ET EMA50(4h) > EMA200(4h)

Si condition fausse → régime = "BEAR" → agent 100% USDC sur ce symbole,
aucun signal BUY accepté, seuls les EXIT sont traités.
Logger le régime à chaque cycle : { symbol, regime: "BULL" | "BEAR" }
```

## R2 — Remapping des signaux SHORT (héritage de la démo)

La démo générait des signaux SHORT. En spot Solana, ils sont remappés :

```
Signal SHORT reçu :
  - Si position ouverte sur ce symbole → EXIT total (vendre, retour USDC)
  - Si pas de position → IGNORER (logger "SHORT_SIGNAL_IGNORED_SPOT")

⚠️ Ne JAMAIS ouvrir de position inverse. Pas de marge, pas de perps en Phase 1.
```

Important pour la cohérence du dashboard : les stats de la démo (win rate 46%)
incluaient les shorts. Les stats live doivent être trackées SÉPARÉMENT
(nouvelle table ou flag `mode: "live_spot"`) — ne jamais mélanger les deux
dans l'affichage public /proof.

## R3 — Seuil de rentabilité par trade

Chaque aller-retour Jupiter coûte ~0.2-0.6% (fees + slippage + priority fees).

```
Avant chaque BUY :
  cout_estime_pct = 2 × (fee_jupiter + slippage_max)   // aller-retour
  gain_attendu_pct = distance entre prix d'entrée et TP1

  Si gain_attendu_pct < 3 × cout_estime_pct → SIGNAL REJETÉ
  (logger "REJECTED_LOW_EDGE")
```

Effet attendu : moins de trades qu'en démo, mais chaque trade a une vraie marge.

## R4 — Position sizing par volatilité (ATR)

```
taille_position = (capital × risque_par_trade) / (ATR14 / prix)

avec risque_par_trade = 1% du capital
plafonné par le guard MAX_POSITION_PCT (10%) de risk-guards.ts
```

Un token calme → position plus grosse. Un token nerveux → position plus petite.
Le risque réel par trade devient constant.

## R5 — Trailing stop renforcé (capture des tendances)

Le système trailing + partial TP existant reste, avec un ajustement :

```
Si tendance forte (prix > EMA20(1h) depuis > 12 bougies) :
  trailing_distance = 2.5 × ATR   // laisser courir
Sinon :
  trailing_distance = 1.5 × ATR   // protéger
```

## R6 — Paires autorisées Phase 1 (hors memecoins)

Uniquement les tokens liquides où la stratégie EMA/RSI a du sens :

```
WHITELIST_CORE = [SOL, JUP, JTO, PYTH, RAY]  (vs USDC)
Critère d'inclusion : liquidité > $5M, volume 24h > $10M
```

---

# PARTIE B — Module Memecoin (allocation séparée, règles strictes)

## Principe fondamental

Les memecoins ne passent PAS par la stratégie EMA/RSI (inutilisable sur des
tokens qui ont 2 heures d'existence). C'est un MODULE SÉPARÉ avec :

```
R7 — Allocation memecoin :
  max 10% du capital total dédié au module memecoin
  max 2% du capital par memecoin individuel
  Le reste de la stratégie ne peut JAMAIS puiser dans cette poche (et inversement)
```

## R8 — Pipeline de sécurité AVANT tout achat (tous les checks doivent passer)

Source de données : API DexScreener (token profiles + pairs) + API RugCheck
(rugcheck.xyz) + appels RPC directs.

```
CHECK 1 — Autorités du token (RPC direct, getAccountInfo sur le mint) :
  ✗ REJET si mint_authority ≠ null        (le créateur peut imprimer des tokens)
  ✗ REJET si freeze_authority ≠ null      (le créateur peut geler ton wallet)

CHECK 2 — Liquidité :
  ✗ REJET si liquidité pool < $50 000
  ✗ REJET si liquidité non lockée/burnée (RugCheck: "LP locked" < 80%)
  ⚠ SKIPPED (pas REJET) si RugCheck retourne une réponse minimale
    (pas de champ markets + lpLockedPct=0 + risks vide) — statut LP
    non vérifiable, le token continue vers checks 3-7, grade PARTIAL/WEAK.
  TODO AVANT LIVE : remplacer la dépendance RugCheck pour le LP lock par
    une vérification on-chain directe (RPC) du burn du LP token
    (solde LP sur adresse burn 0x000…dead). En phase OBSERVATION, SKIPPED suffit.

CHECK 3 — Distribution des holders :
  ✗ REJET si top 10 holders (hors pool) > 30% de la supply
  ✗ REJET si un seul holder (hors pool) > 10%

CHECK 4 — Honeypot / sellability :
  Simuler un SELL via Jupiter quote (montant test) :
  ✗ REJET si aucune route de sortie n'existe
  ✗ REJET si price impact du sell test > 10%

CHECK 5 — Âge et activité :
  ✗ REJET si token < 24h d'existence     (la zone de mortalité maximale)
  ✗ REJET si volume 24h < $500 000
  ✗ REJET si nombre de holders < 500

  ⚠️ L'âge est nécessaire mais JAMAIS suffisant : le piège classique est
  le dev qui achète au lancement avec plusieurs wallets, laisse passer
  les 24h, puis vide sur les nouveaux acheteurs. C'est CHECK 7 qui couvre
  ce cas — un token de 48h avec CHECK 7 rouge est plus dangereux qu'un
  token jeune organique. CHECK 5 et CHECK 7 sont indissociables.

CHECK 6 — Score RugCheck global :
  ✗ REJET si score RugCheck = "danger" ou warnings critiques

CHECK 7 — Détection bundling / wallets liés (anti "slow rug") :
  L'âge de 24h (CHECK 5) NE SUFFIT PAS : un dev peut acheter au lancement
  avec 20-50 wallets différents, laisser le token "mûrir", puis tout
  vider quand les vrais acheteurs arrivent. Détection :

  ✗ REJET si > 15% de la supply a été achetée dans le même bloc (ou les
    3 premiers blocs) que la création du pool — signature classique du bundle
  ✗ REJET si des clusters de wallets financés depuis la même adresse
    source détiennent ensemble > 20% de la supply
    (RugCheck "insider networks" + analyse des funding sources via RPC/Helius)
  ✗ REJET si le wallet créateur détient encore > 5% de la supply
  ✗ REJET si le wallet créateur a déjà déployé des tokens morts/ruggés
    (historique du deployer via son adresse)
  ⚠️ SIGNAL DE SORTIE en position : si des wallets du cluster initial
    commencent à vendre (> 2% de la supply vendue par des early wallets
    en < 1h) → EXIT immédiat, sans attendre le SL

→ Un token qui passe les 7 checks est éligible. Logger chaque rejet avec
  la raison : { mint, check_failed, details, timestamp }
```

## R9 — Règles de trading memecoin (une fois éligible)

```
Signal d'entrée (momentum, pas EMA/RSI) :
  - volume 1h en croissance sur 3 fenêtres consécutives
  - prix > VWAP de la session
  - pas d'achat si le token a déjà fait > +80% dans les 6 dernières heures
    (DexScreener priceChange.h6 — si donnée absente, filtre non appliqué)
  - pas de ré-entrée si le dernier trade fermé sur ce mint a fini en SL_HIT
    il y a < 24h (reentry_cooldown — prouvé nécessaire : CUBEMAN 5 trades
    en 32h, TOESCOIN 2 trades ; 8 SL_HIT sur 9 trades, -2.35 USDC)

Gestion de position (stricte, automatique) — SL/TP OBLIGATOIRES,
créés au moment même de l'achat, jamais "ajoutés plus tard" :

  Stop loss : -15% dur, non négociable
  Système 4 TP en échelle :
    - TP1 à +25%  : vendre 25% → puis SL déplacé à breakeven (prix d'entrée)
    - TP2 à +50%  : vendre 25% → SL déplacé à +20%
    - TP3 à +100% : vendre 25% → SL déplacé à +50%
    - TP4 : les 25% restants en trailing stop 20-25%
            (laisser courir les x10 éventuels)
  → Après TP1, le trade ne peut mathématiquement plus être perdant.

  Time stop : si ni SL ni TP1 touché en 48h → sortir (un memecoin qui
    stagne est un memecoin qui meurt)

Re-vérification continue :
  - Re-lancer CHECK 2 et CHECK 3 toutes les heures tant que la position
    est ouverte → si un check devient rouge, EXIT immédiat
```

## R10 — Kill switch memecoin séparé

```
Si la poche memecoin perd 20% de sa valeur initiale → module memecoin
désactivé 7 jours. Le kill switch global (risk-guards.ts) reste
au-dessus de tout.
```

---

# PARTIE C — Transparence publique (l'argument marketing)

## R11 — Tout trade live est publié

```
Chaque trade (core + memecoin) écrit en base :
  { signature_solana, solscan_url, side, token, amount, fill_price,
    pnl_realise, mode: "live_spot", module: "core" | "memecoin",
    reasoning: <résumé du signal qui a déclenché> }

→ alimentera la page /proof (Phase 1.5) : le wallet public + l'historique
  complet, y compris les pertes et les trades rejetés par les guards.
```

---

# PARTIE D — Module Smart Money (signaux on-chain, héritage WhaleScope)

## Principe

On ne suit pas ce que les gens DISENT (X/Telegram = shill payé, souvent le
sommet). On suit ce que les wallets gagnants FONT (blockchain = infalsifiable).
Ce module génère des SIGNAUX D'ENTRÉE pour le module memecoin (Partie B) —
il ne bypass JAMAIS les 7 checks de R8.

## R12 — Construction du registre de smart wallets

```
Source : historique on-chain via RPC Helius (getSignaturesForAddress + parse
des swaps) et/ou API d'analytics (Birdeye/Solscan pro si budget).

Critères d'admission d'un wallet au registre :
  - ≥ 20 trades sur les 90 derniers jours
  - win rate ≥ 55% OU PnL total ≥ +100% sur la période
  - pas un bot MEV/sandwich (exclure les wallets avec > 500 tx/jour)
  - pas dans un cluster lié à un deployer de token ruggé (croiser CHECK 7b)

Registre stocké en base : { wallet, win_rate, pnl_90d, trades_90d,
  score (0-100), last_updated }
Re-scoring hebdomadaire : un wallet qui passe sous les critères est retiré.
Taille cible : 50-200 wallets suivis.
```

## R13 — Signal de convergence

```
Surveillance continue des achats des wallets du registre (webhooks Helius
ou polling des tx).

SIGNAL déclenché sur un token si :
  - ≥ 3 smart wallets distincts achètent le même token dans une fenêtre
    de 6h (wallets NON liés entre eux — vérif financement, cf CHECK 7b)
  - ET le montant cumulé de leurs achats > $10 000
  - ET aucun d'eux n'a commencé à revendre

→ Le token entre alors dans le pipeline Partie B : les 7 checks de R8
  s'appliquent INTÉGRALEMENT. Le signal smart money remplace uniquement
  le signal momentum de R9, jamais les checks de sécurité.

Sortie renforcée : si ≥ 2 des smart wallets qui ont déclenché le signal
revendent > 50% de leur position → EXIT immédiat (ils savent quelque
chose avant nous).
```

## R14 — Signal social = bonus seulement, jamais décisionnaire

```
Optionnel (phase ultérieure) : trending DexScreener / boost / mentions.
Effet maximum autorisé : +10% sur la taille de position d'un signal déjà
validé par R13 + R8. Un signal social SEUL ne déclenche JAMAIS un achat.
Raison : le trending social est le canal de sortie des insiders.
```

---

# PARTIE E — Score de Confluence publié (le différenciateur marketing)

## Principe

Ce que quasi personne ne fait : chaque trade reçoit un SCORE DE CONVICTION
calculé AVANT l'entrée, publié publiquement, et dont la performance par
tranche de score est vérifiable a posteriori. C'est l'anti-"trust me bro".

## R15 — Calcul du score (0-100)

```
Composantes (pondération initiale, ajustable après données) :
  +25  régime de marché favorable (R1 vert sur le timeframe supérieur)
  +20  signal technique (EMA/RSI core OU momentum memecoin selon module)
  +25  smart money : nb de smart wallets positionnés × qualité (score R12)
  +15  santé du token : marge des checks R8 (passés largement vs de justesse)
  +15  contexte : SOL en tendance haussière, pas d'événement macro imminent

Règles d'exécution par tranche :
  score < 50  → pas de trade
  50-70       → position à 50% de la taille calculée par R4
  70-85       → position à 100%
  > 85        → position à 100% + trailing élargi (laisser courir)
```

## R16 — Publication et auto-audit (l'argument qui vend)

```
Chaque trade publié sur /proof avec :
  { score, détail des composantes, décision de sizing }

Page /proof, section "Le score marche-t-il ?" :
  tableau win rate et PnL moyen PAR TRANCHE de score, calculé sur les
  trades réels — mis à jour automatiquement.

→ Pitch : "Notre agent note sa propre conviction avant chaque trade,
  publie la note, et vous laisse vérifier si elle prédit vraiment.
  Personne d'autre ne s'expose comme ça."

Honnêteté structurelle : si les données montrent que le score ne prédit
rien, on le voit aussi — et on itère les pondérations. C'est un système
qui s'améliore en public.
```

---

# Ordre d'implémentation recommandé

1. R1 + R2 (filtre de régime + remapping shorts) — protège le capital
2. R3 + R4 (seuil de rentabilité + sizing ATR) — protège l'edge
3. R6 (whitelist core) + intégration avec les modules wallet/jupiter/guards
4. Tests live core pendant 1-2 semaines
5. SEULEMENT ENSUITE : Partie B (memecoins) — c'est le module le plus risqué,
   il ne doit pas être debuggé en même temps que le reste
6. R11 (/proof) en parallèle dès que les premiers trades live existent
7. Partie D (smart money) : d'abord R12 en OBSERVATION pure (construire le
   registre, logger les signaux R13 sans trader dessus, mesurer leur
   qualité) — activer le trading sur ces signaux seulement après 2+
   semaines de signaux loggés convaincants
8. Partie E (score) : calculable dès l'étape 4 en dry-run, publié sur
   /proof dès que les données existent
```
