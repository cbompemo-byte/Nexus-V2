// lib/risque/rug.ts
// Checks anti-rug adaptés pump.fun pré-graduation.
// Remplace les 7 checks memecoin (screen.ts) pour le module Risque.
//
// Sources :
//   - On-chain (RPC) : mint authority, freeze authority
//   - RugCheck /v1/tokens/{mint}/report/summary : topHolders, risks, score
//
// Score : CLEAN | CAUTION | DANGER | DATA_UNAVAILABLE
//
// Flags vérifiés :
//   mint_auth_revoked   — false = DANGER immédiat (peut minter des tokens à l'infini)
//   freeze_auth_revoked — false = DANGER immédiat (peut geler les wallets)
//   dev_pct             — % tokens créateur : > 10% = DANGER, > 5% = CAUTION
//   top10_pct           — % top 10 non-dev  : > 40% = CAUTION
//   dev_sold            — créateur a vendu   : DANGER
//   bundled             — lancement bundle   : DANGER si confirmé, null si inconnu
//   danger_risks        — risks level=danger RugCheck (ex: "High Mint Authority")
//   warn_risks          — risks level=warn RugCheck

import { PublicKey }    from '@solana/web3.js'
import { getConnection } from '@/lib/solana/wallet'

// ── Types publics ─────────────────────────────────────────────────────────────

export type RisqueScore = 'CLEAN' | 'CAUTION' | 'DANGER' | 'DATA_UNAVAILABLE'

export interface RugFlags {
  mint_auth_revoked:   boolean | null  // true = révoquée (safe) | false = active (DANGER) | null = échec RPC
  freeze_auth_revoked: boolean | null  // idem
  dev_pct:             number  | null  // % tokens créateur | null = données manquantes
  top10_pct:           number  | null  // % top 10 holders non-dev
  dev_sold:            boolean | null  // true = a vendu | false = tient encore | null = inconnu
  bundled:             boolean | null  // true = bundle confirmé | null = non détecté
  danger_risks:        string[]        // noms des risks level=danger
  warn_risks:          string[]        // noms des risks level=warn
}

export interface RugResult {
  score:  RisqueScore
  reason: string | null  // premier flag déclencheur si DANGER ou CAUTION
  flags:  RugFlags
}

// ── Mint / Freeze authority (on-chain) ───────────────────────────────────────

async function checkAuthorities(
  mint: string,
): Promise<{ mintRevoked: boolean | null; freezeRevoked: boolean | null }> {
  try {
    const conn   = getConnection()
    const info   = await conn.getParsedAccountInfo(new PublicKey(mint))
    const parsed = (info.value?.data as any)?.parsed?.info
    if (!parsed) return { mintRevoked: null, freezeRevoked: null }
    return {
      mintRevoked:   parsed.mintAuthority   === null,
      freezeRevoked: parsed.freezeAuthority === null,
    }
  } catch (e: any) {
    console.warn(`[rug] authorities RPC error ${mint.slice(0, 8)}…: ${e.message}`)
    return { mintRevoked: null, freezeRevoked: null }
  }
}

// ── Extraction des flags depuis le rapport RugCheck ───────────────────────────

function parseRugReport(rug: any): Omit<RugFlags, 'mint_auth_revoked' | 'freeze_auth_revoked'> {
  if (!rug) {
    return {
      dev_pct: null, top10_pct: null,
      dev_sold: null, bundled: null,
      danger_risks: [], warn_risks: [],
    }
  }

  const holders = (rug.topHolders as any[]) || []
  const risks   = (rug.risks      as any[]) || []

  // ── Dev holdings ──────────────────────────────────────────────────────────
  const devEntry  = holders.find((h: any) => h.isCreator || h.is_creator)
  const dev_pct   = devEntry !== undefined ? Number(devEntry.pct) : null

  // ── Top 10 non-dev ────────────────────────────────────────────────────────
  const nonDev    = holders.filter((h: any) => !(h.isCreator || h.is_creator) && h.pct != null)
  const top10_pct = nonDev.length > 0
    ? nonDev.slice(0, 10).reduce((s: number, h: any) => s + Number(h.pct), 0)
    : null

  // ── Dev sold ──────────────────────────────────────────────────────────────
  // Trois sources :
  //   1. Risk flag explicite ("Dev Sold X%" ou "Insider sold")
  //   2. Dev absent des topHolders alors que RugCheck en a (indice seulement — null, pas false)
  const devSoldRisk = risks.some((r: any) =>
    /dev.*sold|creator.*sold|insider.*sold|deployer.*sold/i.test(String(r.name ?? ''))
  )
  const dev_sold: boolean | null = devSoldRisk
    ? true
    : devEntry !== undefined
      ? false          // créateur toujours présent en topHolders → n'a pas vendu
      : null           // absent mais pas de flag explicite → incertain

  // ── Bundled ───────────────────────────────────────────────────────────────
  const bundledRisk = risks.some((r: any) => /bundle/i.test(String(r.name ?? '')))
  const bundled: boolean | null = bundledRisk ? true : null  // null = non détecté (pas false)

  // ── Risk lists ────────────────────────────────────────────────────────────
  const danger_risks = risks
    .filter((r: any) => r.level === 'danger')
    .map((r: any) => String(r.name ?? 'unknown'))
  const warn_risks   = risks
    .filter((r: any) => r.level === 'warn')
    .map((r: any) => String(r.name ?? 'unknown'))

  return { dev_pct, top10_pct, dev_sold, bundled, danger_risks, warn_risks }
}

// ── Score ─────────────────────────────────────────────────────────────────────
// Priorité : DANGER > CAUTION > DATA_UNAVAILABLE > CLEAN
// Le "reason" capture le premier flag déclencheur (pour affichage UI).

function computeScore(flags: RugFlags): { score: RisqueScore; reason: string | null } {
  // ── DANGER — bloquants immédiats ─────────────────────────────────────────
  if (flags.mint_auth_revoked === false)
    return { score: 'DANGER',  reason: 'mint authority NON révoquée' }
  if (flags.freeze_auth_revoked === false)
    return { score: 'DANGER',  reason: 'freeze authority NON révoquée' }
  if (flags.danger_risks.length > 0)
    return { score: 'DANGER',  reason: `rug risks: ${flags.danger_risks.slice(0, 3).join(', ')}` }
  if (flags.dev_sold === true)
    return { score: 'DANGER',  reason: 'créateur a vendu' }
  if (flags.bundled === true)
    return { score: 'DANGER',  reason: 'lancement en bundle confirmé' }
  if (flags.dev_pct !== null && flags.dev_pct > 10)
    return { score: 'DANGER',  reason: `créateur tient ${flags.dev_pct.toFixed(1)}% des tokens` }

  // ── CAUTION — signaux d'alerte ────────────────────────────────────────────
  if (flags.dev_pct !== null && flags.dev_pct > 5)
    return { score: 'CAUTION', reason: `créateur tient ${flags.dev_pct.toFixed(1)}%` }
  if (flags.top10_pct !== null && flags.top10_pct > 40)
    return { score: 'CAUTION', reason: `top10 tient ${flags.top10_pct.toFixed(1)}%` }
  if (flags.warn_risks.length >= 2)
    return { score: 'CAUTION', reason: `${flags.warn_risks.length} warn risks` }

  // ── DATA_UNAVAILABLE — toutes les données critiques sont nulles ──────────
  const hasData =
    flags.mint_auth_revoked   !== null ||
    flags.freeze_auth_revoked !== null ||
    flags.dev_pct             !== null ||
    flags.danger_risks.length  >  0
  if (!hasData) return { score: 'DATA_UNAVAILABLE', reason: null }

  return { score: 'CLEAN', reason: null }
}

// ── Point d'entrée public ─────────────────────────────────────────────────────
// rug : rapport RugCheck déjà fetchéà l'appelant (null si indisponible).
// Les deux sources (RPC + RugCheck) sont appelées en parallèle.

export async function checkRug(mint: string, rug: any | null): Promise<RugResult> {
  const [auths, rugData] = await Promise.all([
    checkAuthorities(mint),
    Promise.resolve(parseRugReport(rug)),
  ])

  const flags: RugFlags = {
    mint_auth_revoked:   auths.mintRevoked,
    freeze_auth_revoked: auths.freezeRevoked,
    ...rugData,
  }

  const { score, reason } = computeScore(flags)
  return { score, reason, flags }
}
