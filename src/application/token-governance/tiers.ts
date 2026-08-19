// Token biudžeto tier'ų vokabuliaras — atskirame modulyje, kad turn-budget ir
// optimizatorius jį dalintųsi be importų ciklo. Behaviour etalon: AG_loop
// policy/token-budget-optimizer.ts (tier pusė).

export type TokenBudgetTier = "small" | "medium" | "large";

export const TOKEN_BUDGET_TIERS: readonly TokenBudgetTier[] = ["small", "medium", "large"];

/**
 * Sprendimo (`decision.json` ir attempt `decision` artefakto) laukas, kuriuo preflight
 * paskelbia token biudžeto tier'ą dispatch'ui (task 0941). Rakto vardas gyvena čia, kad
 * rašytojas ir skaitytojas negalėtų išsiskirti.
 */
export const DECISION_TOKEN_BUDGET_TIER_KEY = "token_budget_tier";

/**
 * Persistuoto (schema `.passthrough()` keliu atkeliavusio) tier'o skaitymas. Nežinoma ar
 * sugadinta reikšmė grąžina `undefined`, kad kvietėjas kristų į savo dokumentuotą atsarginį
 * kelią, o ne dispatch'intų su prasimanytu tier'u.
 */
export function parseTokenBudgetTier(value: unknown): TokenBudgetTier | undefined {
  return typeof value === "string" && (TOKEN_BUDGET_TIERS as readonly string[]).includes(value)
    ? (value as TokenBudgetTier)
    : undefined;
}

/**
 * Vienas laiptelis žemyn tier'o skalėje — soft biudžeto reakcija. Dispatch'e kanoninio
 * worker prompt'o turinio kirpti NEGALIMA (byte parity kontraktas), tad priartėjus prie
 * whole-task ribos mažinamas ne prompt'as, o darbo langas.
 */
export function reduceTier(tier: TokenBudgetTier): TokenBudgetTier {
  return tier === "large" ? "medium" : "small";
}
