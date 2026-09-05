// Turn/wall-clock biudžeto konfigo sluoksnis (etalonas: AG_loop policy/token-budget-config.ts
// 1:1; task 0033-03). Kanoninis override — `vq/config/token-budget.json`; pirmumas PER RAKTĄ
// ir STEBIMAS (`sources`): 1) kietos lubos (kodo konstantos, nekonfigūruojamos) — atmetimas
// PO merge; 2) konfigas; 3) legacyTurnLimits (`preflight-limits.json#turnLimits`, perduodamas
// kaip duomenys — šis modulis to failo neskaito); 4) kodo default'ai (fail-safe bazė).
// Importo kryptis viena: config -> turn-budget; fail-safe bazė pasiekiama net konfigui krentant.

import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import type { PolicyConfigFileSystemPort } from "../policy-governance/ports.js";
import {
  DEFAULT_TURN_LIMITS,
  DISPATCH_TIMEOUT_OVERHEAD_MS,
  MAX_DISPATCH_WALL_CLOCK_MS,
  PER_TURN_WALLCLOCK_ALLOWANCE_MS,
  resolveDispatchTimeoutMs,
  type TurnLimits,
} from "./turn-budget.js";

/** `runtimeRoot`-reliatyvus konfigo kelias — vienintelė šio failo vardo vieta. */
export const TOKEN_BUDGET_CONFIG_FILE = "config/token-budget.json";

/** Kaip konfigas vadinamas klaidų žinutėse (projekto šaknies atžvilgiu). */
const CONFIG_DISPLAY_PATH = `vq/${TOKEN_BUDGET_CONFIG_FILE}`;

const CONFIG_LABEL = "token budget config";

export function tokenBudgetConfigPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, ...TOKEN_BUDGET_CONFIG_FILE.split("/"));
}

// Turn limitas yra teigiamas sveikas skaičius. 0 čia NELEIDŽIAMAS sąmoningai:
// „0 = be ribos" opt-out gyvena tik `preflight-limits.json#dispatchMaxTurns`.
const turnLimitSchema = z.number().int().positive();

// Visi raktai optional (dalinis override), nežinomas raktas = klaida, ne tylus ignoravimas.
const turnLimitsOverrideSchema = z.strictObject({
  small: turnLimitSchema.optional(),
  medium: turnLimitSchema.optional(),
  large: turnLimitSchema.optional(),
  repair: turnLimitSchema.optional(),
  semanticReview: turnLimitSchema.optional(),
});

export const tokenBudgetConfigSchema = z.strictObject({
  version: z.literal(1).optional(),
  turnLimits: turnLimitsOverrideSchema.optional(),
  perTurnWallclockAllowanceMs: z.number().int().positive().optional(),
  // 0 teisėta: „grynas turn lango šešėlis be pridėtinės kainos". SPĄSTAI: rakto MAŽINIMAS
  // dažniausiai yra tylus no-op — MIN_DISPATCH_TIMEOUT_MS clamp'as (žr. turn-budget.ts);
  // langui siaurinti naudok turnLimits arba perTurnWallclockAllowanceMs.
  dispatchTimeoutOverheadMs: z.number().int().nonnegative().optional(),
  /**
   * Vienos dispatch sesijos RAW (su cache_read) lubos. Task 1215: watchdog'as šio rakto
   * NEBELYGINA — jis matuoja billable bazę; raktas lieka diagnostinėms RAW luboms
   * (`DISPATCH RAW TOKEN NOTICE`), baigties nekeičia.
   */
  maxDispatchTokens: z.number().int().positive().optional(),
  /**
   * Kiek BILLABLE tokenų (input + output + cache_creation, BE cache_read) viena dispatch
   * sesija gali sudeginti iki mid-stream nutraukimo (task 1215). Etalono 2026-08-12 pamoka:
   * raw riba nutraukdavo sesijas, kurių reali kaina buvo dešimtadalis ribos.
   */
  maxDispatchBillableTokens: z.number().int().positive().optional(),
});

export type TokenBudgetConfig = z.infer<typeof tokenBudgetConfigSchema>;

export type TokenBudgetSourceKey =
  | keyof TurnLimits
  | "perTurnWallclockAllowanceMs"
  | "dispatchTimeoutOverheadMs"
  | "maxDispatchTokens"
  | "maxDispatchBillableTokens";

/** Iš kurio sluoksnio atkeliavo konkreti reikšmė. */
export type TokenBudgetSource = "config" | "legacy" | "code";

export type ResolvedTokenBudget = {
  turnLimits: TurnLimits;
  perTurnWallclockAllowanceMs: number;
  dispatchTimeoutOverheadMs: number;
  maxDispatchTokens: number;
  maxDispatchBillableTokens: number;
  /** Pirmumas kaip stebimas duomuo, ne kaip komentaras. */
  sources: Record<TokenBudgetSourceKey, TokenBudgetSource>;
};

// Kietos lubos — NEKONFIGŪRUOJAMOS (paskutinis stabdiklis prieš vieną redaguotą JSON
// eilutę, kuri paverstų dispatch'ą de facto neribotu).
export const MAX_CONFIGURABLE_TURNS = 300;
export const MAX_CONFIGURABLE_PER_TURN_WALLCLOCK_MS = 120_000;
export const MAX_CONFIGURABLE_OVERHEAD_MS = 3_600_000;
/**
 * Kompozicinės lubos IŠVEDAMAM langui (4 h) — raktai atskirai legalūs, sandauga ne.
 *
 * Reikšmė nekinta, keičiasi ŠALTINIS: ta pati riba nurodo, kiek laiko gyvumo langas ir lease TTL
 * privalo padengti, tad ji gyvena vienoje vietoje (`turn-budget.ts`), o ne trijuose literaluose.
 */
export const MAX_DERIVED_DISPATCH_TIMEOUT_MS = MAX_DISPATCH_WALL_CLOCK_MS;

/** Lygus tool-budget default max_total_billable_tokens (10 M) — watchdog'as pats savaime
 * neuždraudžia sesijos, kurią post-hoc vartai leistų. */
export const DEFAULT_MAX_DISPATCH_TOKENS = 10_000_000;
export const MAX_CONFIGURABLE_DISPATCH_TOKENS = 20_000_000;
/** Per maža reikšmė destruktyvi kaip per didelė: self-DoS į queue↔abort ciklą. */
export const MIN_CONFIGURABLE_DISPATCH_TOKENS = 100_000;

/** Task 1215 derivacija iš realių duomenų: ~2.3–3.4× blogiausio stebėto billable atvejo. */
export const DEFAULT_MAX_DISPATCH_BILLABLE_TOKENS = 1_500_000;
/** TYČIA lygios raw grindims — vienas mentalinis modelis operatoriui. */
export const MIN_CONFIGURABLE_DISPATCH_BILLABLE_TOKENS = 100_000;
/** Griežtai 10 M: `billable <= raw`, tad aukštesnė riba ĮRODOMAI nesuveiktų anksčiau vartų. */
export const MAX_CONFIGURABLE_DISPATCH_BILLABLE_TOKENS = 10_000_000;

// Raktų sąrašas iš kodo lentelės — naujas TurnLimits raktas negali likti be validacijos.
const TURN_LIMIT_KEYS = Object.keys(DEFAULT_TURN_LIMITS) as (keyof TurnLimits)[];

function fail(detail: string): never {
  throw new Error(`${CONFIG_LABEL} validation failed: ${detail}`);
}

function show(value: unknown): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

// Lubų žinutė rodo TIKRĄJĮ pažeidusios reikšmės sluoksnį (iš `sources`, ne spėjimu).
const SOURCE_DESCRIPTIONS: Record<TokenBudgetSource, string> = {
  config: CONFIG_DISPLAY_PATH,
  legacy: "vq/config/preflight-limits.json#turnLimits",
  code: "the code default in application/token-governance/turn-budget.ts",
};

function ceilingAttribution(constantName: string, source: TokenBudgetSource): string {
  return `(code constant ${constantName}; the ceiling is not configurable and this value comes from ${SOURCE_DESCRIPTIONS[source]})`;
}

/**
 * Legacy sluoksnio forma: `preflight-limits.json#turnLimits` ateina iš zod `.optional()`
 * laukų, kurie su exactOptionalPropertyTypes inferuoja `number | undefined` — tipas čia
 * eksplicitiškai jį priima (merge vis tiek tikrina `!== undefined`).
 */
export type LegacyTurnLimits = { [K in keyof TurnLimits]?: number | undefined };

/**
 * GRYNA merge + validacija: jokio IO. Semantinė validacija PO merge — dalinis override
 * gali sulaužyti tvarką ne tarp savo raktų, o prieš default'us.
 */
export function resolveTokenBudgetConfig(input: {
  override?: TokenBudgetConfig;
  legacyTurnLimits?: LegacyTurnLimits;
}): ResolvedTokenBudget {
  const sources = {} as Record<TokenBudgetSourceKey, TokenBudgetSource>;
  const turnLimits: TurnLimits = { ...DEFAULT_TURN_LIMITS };

  for (const key of TURN_LIMIT_KEYS) {
    const fromConfig = input.override?.turnLimits?.[key];
    const fromLegacy = input.legacyTurnLimits?.[key];
    if (fromConfig !== undefined) {
      turnLimits[key] = fromConfig;
      sources[key] = "config";
    } else if (fromLegacy !== undefined) {
      turnLimits[key] = fromLegacy;
      sources[key] = "legacy";
    } else {
      sources[key] = "code";
    }
  }

  // Šių raktų legacy sluoksnis neturi: preflight-limits wall-clock aritmetikos neapibrėžė.
  const perTurnOverride = input.override?.perTurnWallclockAllowanceMs;
  const perTurnWallclockAllowanceMs = perTurnOverride ?? PER_TURN_WALLCLOCK_ALLOWANCE_MS;
  sources.perTurnWallclockAllowanceMs = perTurnOverride !== undefined ? "config" : "code";

  const overheadOverride = input.override?.dispatchTimeoutOverheadMs;
  const dispatchTimeoutOverheadMs = overheadOverride ?? DISPATCH_TIMEOUT_OVERHEAD_MS;
  sources.dispatchTimeoutOverheadMs = overheadOverride !== undefined ? "config" : "code";

  const dispatchTokensOverride = input.override?.maxDispatchTokens;
  const maxDispatchTokens = dispatchTokensOverride ?? DEFAULT_MAX_DISPATCH_TOKENS;
  sources.maxDispatchTokens = dispatchTokensOverride !== undefined ? "config" : "code";

  const dispatchBillableOverride = input.override?.maxDispatchBillableTokens;
  const maxDispatchBillableTokens = dispatchBillableOverride ?? DEFAULT_MAX_DISPATCH_BILLABLE_TOKENS;
  sources.maxDispatchBillableTokens = dispatchBillableOverride !== undefined ? "config" : "code";

  assertWithinCeilings({
    turnLimits,
    perTurnWallclockAllowanceMs,
    dispatchTimeoutOverheadMs,
    maxDispatchTokens,
    maxDispatchBillableTokens,
    sources,
  });

  return {
    turnLimits,
    perTurnWallclockAllowanceMs,
    dispatchTimeoutOverheadMs,
    maxDispatchTokens,
    maxDispatchBillableTokens,
    sources,
  };
}

function assertWithinCeilings(resolved: ResolvedTokenBudget): void {
  const {
    turnLimits,
    perTurnWallclockAllowanceMs,
    dispatchTimeoutOverheadMs,
    maxDispatchTokens,
    maxDispatchBillableTokens,
    sources,
  } = resolved;

  for (const key of TURN_LIMIT_KEYS) {
    const value = turnLimits[key];
    if (!Number.isInteger(value) || value < 1) {
      fail(
        `turnLimits.${key}: ${show(value)} is not an allowed value (integer >= 1); ` +
          `"0 = no limit" lives only in vq/config/preflight-limits.json#dispatchMaxTurns ` +
          `(source: ${sources[key]})`,
      );
    }
    if (value > MAX_CONFIGURABLE_TURNS) {
      fail(
        `turnLimits.${key}: ${value} exceeds the hard ceiling ${MAX_CONFIGURABLE_TURNS} ` +
          ceilingAttribution("MAX_CONFIGURABLE_TURNS", sources[key]),
      );
    }
  }

  // Negriežtas monotoniškumas: lygybė — sąmoningas suplokštinimas; apsivertusi tvarka
  // reikštų, kad maža užduotis gauna platesnį langą už didelę.
  if (turnLimits.small > turnLimits.medium) {
    fail(`turnLimits: small (${turnLimits.small}) must not exceed medium (${turnLimits.medium})`);
  }
  if (turnLimits.medium > turnLimits.large) {
    fail(`turnLimits: medium (${turnLimits.medium}) must not exceed large (${turnLimits.large})`);
  }

  if (!Number.isInteger(perTurnWallclockAllowanceMs) || perTurnWallclockAllowanceMs < 1) {
    fail(`perTurnWallclockAllowanceMs: ${show(perTurnWallclockAllowanceMs)} is not an allowed value (integer >= 1)`);
  }
  if (perTurnWallclockAllowanceMs > MAX_CONFIGURABLE_PER_TURN_WALLCLOCK_MS) {
    fail(
      `perTurnWallclockAllowanceMs: ${perTurnWallclockAllowanceMs} exceeds the hard ceiling ` +
        `${MAX_CONFIGURABLE_PER_TURN_WALLCLOCK_MS} ` +
        ceilingAttribution("MAX_CONFIGURABLE_PER_TURN_WALLCLOCK_MS", sources.perTurnWallclockAllowanceMs),
    );
  }

  if (!Number.isInteger(dispatchTimeoutOverheadMs) || dispatchTimeoutOverheadMs < 0) {
    fail(`dispatchTimeoutOverheadMs: ${show(dispatchTimeoutOverheadMs)} is not an allowed value (integer >= 0)`);
  }
  if (dispatchTimeoutOverheadMs > MAX_CONFIGURABLE_OVERHEAD_MS) {
    fail(
      `dispatchTimeoutOverheadMs: ${dispatchTimeoutOverheadMs} exceeds the hard ceiling ` +
        `${MAX_CONFIGURABLE_OVERHEAD_MS} ` +
        ceilingAttribution("MAX_CONFIGURABLE_OVERHEAD_MS", sources.dispatchTimeoutOverheadMs),
    );
  }

  // Vieno dispatch'o token ribos turi DVI kietas puses (dekoracija vs self-DoS).
  if (!Number.isInteger(maxDispatchTokens) || maxDispatchTokens < MIN_CONFIGURABLE_DISPATCH_TOKENS) {
    fail(
      `maxDispatchTokens: ${show(maxDispatchTokens)} is below the hard floor ${MIN_CONFIGURABLE_DISPATCH_TOKENS} ` +
        ceilingAttribution("MIN_CONFIGURABLE_DISPATCH_TOKENS", sources.maxDispatchTokens),
    );
  }
  if (maxDispatchTokens > MAX_CONFIGURABLE_DISPATCH_TOKENS) {
    fail(
      `maxDispatchTokens: ${maxDispatchTokens} exceeds the hard ceiling ${MAX_CONFIGURABLE_DISPATCH_TOKENS} ` +
        ceilingAttribution("MAX_CONFIGURABLE_DISPATCH_TOKENS", sources.maxDispatchTokens),
    );
  }

  if (
    !Number.isInteger(maxDispatchBillableTokens) ||
    maxDispatchBillableTokens < MIN_CONFIGURABLE_DISPATCH_BILLABLE_TOKENS
  ) {
    fail(
      `maxDispatchBillableTokens: ${show(maxDispatchBillableTokens)} is below the hard floor ` +
        `${MIN_CONFIGURABLE_DISPATCH_BILLABLE_TOKENS} ` +
        ceilingAttribution("MIN_CONFIGURABLE_DISPATCH_BILLABLE_TOKENS", sources.maxDispatchBillableTokens),
    );
  }
  if (maxDispatchBillableTokens > MAX_CONFIGURABLE_DISPATCH_BILLABLE_TOKENS) {
    fail(
      `maxDispatchBillableTokens: ${maxDispatchBillableTokens} exceeds the hard ceiling ` +
        `${MAX_CONFIGURABLE_DISPATCH_BILLABLE_TOKENS} ` +
        ceilingAttribution("MAX_CONFIGURABLE_DISPATCH_BILLABLE_TOKENS", sources.maxDispatchBillableTokens),
    );
  }

  // Kompozicinės lubos matuojamos TA PAČIA funkcija, kuri langą realiai išveda.
  const derived = [
    { label: "tier=large", ms: derive("implementation", resolved) },
    { label: "phase=repair", ms: derive("repair", resolved) },
    { label: "phase=semantic-review", ms: derive("semantic-review", resolved) },
  ];
  const widest = derived.reduce((current, candidate) => (candidate.ms > current.ms ? candidate : current));
  if (widest.ms > MAX_DERIVED_DISPATCH_TIMEOUT_MS) {
    fail(
      `derived dispatch window for ${widest.label} is ${widest.ms} ms, above the hard ceiling ` +
        `${MAX_DERIVED_DISPATCH_TIMEOUT_MS} ms (code constant MAX_DERIVED_DISPATCH_TIMEOUT_MS)`,
    );
  }
}

export type MidDispatchLimitSource = "dispatch-ceiling" | "task-remaining";

/**
 * Efektyvi šio dispatch'o token riba = min(vieno dispatch'o billable lubos, likęs whole-task
 * biudžetas). `null` remaining = whole-task riba nesukonfigūruota → lieka vien lubos;
 * neigiamas remaining suspaudžiamas iki 0. Task 1215: abu nariai matuoja BILLABLE bazę —
 * mid-dispatch RAW apsaugos SĄMONINGAI nebelieka (raw perviršis — tik diagnostinis notice).
 */
export function resolveMidDispatchTokenLimit(input: {
  maxDispatchBillableTokens: number;
  remainingTaskTokens: number | null;
}): { limit: number; source: MidDispatchLimitSource } {
  if (input.remainingTaskTokens === null) {
    return { limit: input.maxDispatchBillableTokens, source: "dispatch-ceiling" };
  }
  const remaining = Math.max(0, input.remainingTaskTokens);
  return remaining < input.maxDispatchBillableTokens
    ? { limit: remaining, source: "task-remaining" }
    : { limit: input.maxDispatchBillableTokens, source: "dispatch-ceiling" };
}

function derive(phase: "implementation" | "repair" | "semantic-review", resolved: ResolvedTokenBudget): number {
  return resolveDispatchTimeoutMs({
    tier: "large",
    phase,
    limits: resolved.turnLimits,
    perTurnAllowanceMs: resolved.perTurnWallclockAllowanceMs,
    overheadMs: resolved.dispatchTimeoutOverheadMs,
  });
}

/**
 * Nuskaito ir validuoja `vq/config/token-budget.json`: failo nėra / tuščias → kodo
 * default'ai (plius legacyTurnLimits); blogas JSON / schemos ar semantinis pažeidimas →
 * fail-fast klaida (tylus default'as reikštų nepastebimai kitokį dispatch langą).
 */
export async function loadTokenBudgetConfig(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
  options?: { legacyTurnLimits?: LegacyTurnLimits },
): Promise<ResolvedTokenBudget> {
  const raw = (await fs.readTextFileIfExists(tokenBudgetConfigPath(runtimeRoot))) ?? "";
  if (!raw.trim()) {
    return resolveTokenBudgetConfig(
      options?.legacyTurnLimits === undefined ? {} : { legacyTurnLimits: options.legacyTurnLimits },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${CONFIG_LABEL} is not valid JSON: ${message}`, { cause: error });
  }

  const override = parseWithSchema(tokenBudgetConfigSchema, parsed, CONFIG_LABEL);
  return resolveTokenBudgetConfig({
    override,
    ...(options?.legacyTurnLimits === undefined ? {} : { legacyTurnLimits: options.legacyTurnLimits }),
  });
}
