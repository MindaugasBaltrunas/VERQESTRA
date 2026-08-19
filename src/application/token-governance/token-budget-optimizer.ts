// Token biudžeto optimizatorius: struktūrinis tier'as + rizikos balsai → konteksto ribos,
// modelio hint'as ir turn langas VIENAME verdikte (task 0941: tier'as yra VIENAS — tas pats
// laukas maitina ir kontekstą, ir turn langą). Behaviour etalon: AG_loop
// policy/token-budget-optimizer.ts (optimizatoriaus pusė; WBR VQ-302 skaidymas).
// Pure: no IO, no clock.

import type { TaskClassification } from "../../domain/policies/task-classification.js";
import type { TaskSizeMetrics } from "../../domain/tasks/size.js";
import type { ContextBudgetSettings } from "../policy-governance/context-budget.js";
import { reduceTier, type TokenBudgetTier } from "./tiers.js";
import { resolveMaxTurns, type TurnLimits } from "./turn-budget.js";

export type { TokenBudgetTier } from "./tiers.js";

/** Struktūrinis human-review gate rezultato vaizdas (pilnas gate'as — VQ-305). */
export type HumanReviewGateView = {
  requires_human_review: boolean;
} & Record<string, unknown>;

export type TokenBudgetDecision = {
  tier: TokenBudgetTier;
  max_context_chars: number;
  max_files: number;
  max_spec_fragments: number;
  max_file_fragments: number;
  model_policy_hint: "haiku" | "sonnet" | "opus";
  /** TOK-3: implementacijos sesijos turn limitas šiam tier'ui (0 = be ribos). */
  max_turns: number;
  reasons: string[];
};

export type TokenBudgetInput = {
  metrics: TaskSizeMetrics;
  classification: TaskClassification;
  baseBudget: ContextBudgetSettings;
  humanReview?: HumanReviewGateView;
  splitRequired?: boolean;
  /** Nenurodžius imami turn-budget DEFAULT_TURN_LIMITS. */
  turnLimits?: TurnLimits;
};

/**
 * Iš kur gautas dispatch turn lango tier'as:
 * - `token-budget` — preflight paskelbtas `optimizeTokenBudget` verdiktas (kanoninis kelias);
 * - `structural` — preflight sprendimo nėra arba jis priklauso kitam task'ui;
 * - `reduced` — bazinis tier'as nuleistas vienu laipteliu per soft biudžeto kelią.
 */
export type TurnTierSource = "token-budget" | "structural" | "reduced";

export type DispatchTurnTierDecision = {
  /** Tier'as, kuriuo skaičiuojamas `--max-turns`. */
  tier: TokenBudgetTier;
  source: TurnTierSource;
  /** Tier'as prieš `reduced` nuleidimą (be nuleidimo — lygus `tier`). */
  baseTier: TokenBudgetTier;
  /** Bazinio tier'o šaltinis; `reduced` atveju rodo, KĄ nuleido. */
  baseSource: Exclude<TurnTierSource, "reduced">;
  /** `DISPATCH TURN BUDGET: ... source=` laukas — be tarpų, kad log liktų parsinamas. */
  sourceLabel: string;
  reasons: string[];
};

/**
 * Vienintelė vieta, kuri nusprendžia dispatch sesijos turn lango tier'ą (task 0941).
 * Kanoninis šaltinis — preflight paskelbtas token biudžeto tier'as; be jo grįžtama prie
 * struktūrinių metrikų. Griežtinti tier'ą galima TIK soft biudžeto keliu, vienu laipteliu.
 */
export function resolveDispatchTurnTier(input: {
  /** Preflight `decision.token_budget_tier`; `undefined` → struktūrinis atsarginis kelias. */
  publishedTier?: TokenBudgetTier;
  metrics: TaskSizeMetrics;
  /** Soft biudžeto priežastys, kai `reduce_context` aktyvus; kitu atveju tuščia. */
  reduceContextReasons?: readonly string[];
}): DispatchTurnTierDecision {
  const structural = structuralTaskTier(input.metrics);
  const baseTier = input.publishedTier ?? structural.tier;
  const baseSource: Exclude<TurnTierSource, "reduced"> = input.publishedTier ? "token-budget" : "structural";
  const baseReasons = input.publishedTier
    ? [`preflight published token budget tier=${input.publishedTier}`]
    : structural.reasons.length > 0
      ? structural.reasons
      : ["structurally small task by default"];

  const softReasons = (input.reduceContextReasons ?? []).map((reason) => reason.trim()).filter(Boolean);
  if (softReasons.length === 0) {
    return { tier: baseTier, source: baseSource, baseTier, baseSource, sourceLabel: baseSource, reasons: baseReasons };
  }

  return {
    tier: reduceTier(baseTier),
    source: "reduced",
    baseTier,
    baseSource,
    // Pilnos soft priežastys jau eina į soft-limit eilutę; čia lieka trumpas, be tarpų,
    // priežasties vardas, kad `source=` laukas būtų vientisas.
    sourceLabel: "reduced(soft-budget)",
    reasons: [...baseReasons, ...softReasons],
  };
}

export type StructuralTierDecision = { tier: TokenBudgetTier; reasons: string[] };

/**
 * Vien iš struktūrinių metrikų išvestas dydžio tier'as — VIENINTELĖ šio sprendimo vieta.
 * Ją naudoja ir `optimizeTokenBudget` (kaip pradinį balsą), ir turn biudžeto skaičiavimas
 * dispatch'e, todėl „kas yra maža/vidutinė/didelė užduotis" negali išsiskirti.
 */
export function structuralTaskTier(metrics: TaskSizeMetrics): StructuralTierDecision {
  const reasons: string[] = [];
  let tier: TokenBudgetTier = "small";

  if (metrics.allowedPaths > 2 || metrics.actionBullets > 2 || metrics.domains > 1) {
    tier = "medium";
    reasons.push("task spans multiple paths, actions, or domains");
  }

  // 2026-07-29 (GeoGravity token auditas): struktūrinis dydis (daug failų/eilučių) reiškia
  // didelį KONTEKSTĄ, ne opus lygio sudėtingumą — 10 failų UI įvielinimas yra sonnet darbas.
  // Opus balsą palieka tik rizikos signalai `optimizeTokenBudget`.
  if (metrics.allowedPaths > 6 || metrics.actionBullets > 5 || metrics.domains > 2 || metrics.lines > 100) {
    tier = "large";
    reasons.push("task is structurally large");
  }

  return { tier, reasons };
}

const tierRank: Record<TokenBudgetTier, number> = { small: 0, medium: 1, large: 2 };
const modelRank: Record<"haiku" | "sonnet" | "opus", number> = { haiku: 0, sonnet: 1, opus: 2 };

export function optimizeTokenBudget(input: TokenBudgetInput): TokenBudgetDecision {
  // Struktūrinis tier'as yra pirmas balsas; rizikos signalai žemiau gali jį tik kelti.
  const structural = structuralTaskTier(input.metrics);
  const reasons: string[] = [...structural.reasons];
  const tierVotes: TokenBudgetTier[] = ["small", structural.tier];
  const modelVotes: Array<"haiku" | "sonnet" | "opus"> = [input.classification.model_policy_hint];
  if (structural.tier !== "small") {
    modelVotes.push("sonnet");
  }

  if (input.classification.sensitivity === "medium") {
    tierVotes.push("medium");
    modelVotes.push("sonnet");
    reasons.push("classification sensitivity is medium");
  }

  if (input.classification.sensitivity === "high") {
    tierVotes.push("large");
    modelVotes.push("opus");
    reasons.push("classification sensitivity is high");
  }

  if (input.humanReview?.requires_human_review) {
    tierVotes.push("large");
    modelVotes.push("opus");
    reasons.push("human-review gate requires extra planning context");
  }

  if (input.splitRequired) {
    tierVotes.push("large");
    modelVotes.push("opus");
    reasons.push("split plan required for oversized task");
  }

  const tier = highestTier(tierVotes);
  const model = highestModel(modelVotes);
  return {
    tier,
    max_context_chars: tierContextChars(input.baseBudget.max_context_chars, tier),
    max_files: tierFiles(input.baseBudget.max_files, tier),
    max_spec_fragments: tierFragments(input.baseBudget.max_spec_fragments, tier),
    max_file_fragments: tierFragments(input.baseBudget.max_file_fragments, tier),
    model_policy_hint: model,
    // Task 0941: turn langas remiasi TUO PAČIU `tier` lauku, kurį šis sprendimas
    // paskelbia kontekstui ir modeliui.
    max_turns: resolveMaxTurns({
      phase: "implementation",
      tier,
      ...(input.turnLimits === undefined ? {} : { limits: input.turnLimits }),
    }),
    reasons: reasons.length > 0 ? reasons : ["small routine task by default"],
  };
}

function highestTier(values: TokenBudgetTier[]): TokenBudgetTier {
  return values.slice().sort((a, b) => tierRank[b] - tierRank[a] || a.localeCompare(b))[0] ?? "small";
}

function highestModel(values: Array<"haiku" | "sonnet" | "opus">): "haiku" | "sonnet" | "opus" {
  return values.slice().sort((a, b) => modelRank[b] - modelRank[a] || a.localeCompare(b))[0] ?? "haiku";
}

function tierContextChars(base: number, tier: TokenBudgetTier): number {
  if (tier === "small") return Math.min(base, 6000);
  if (tier === "medium") return Math.min(base, 12000);
  return base;
}

function tierFiles(base: number, tier: TokenBudgetTier): number {
  if (tier === "small") return Math.min(base, 4);
  if (tier === "medium") return Math.min(base, 8);
  return base;
}

function tierFragments(base: number, tier: TokenBudgetTier): number {
  if (tier === "small") return Math.min(base, 4);
  if (tier === "medium") return Math.min(base, 8);
  return base;
}
