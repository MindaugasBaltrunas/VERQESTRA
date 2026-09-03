// Task 159 (modelių auditas R1–R3): turn lubų kalibracija ir eskaluoto bandymo turn langas.
// Šis failas pina TIK tai, ką auditas nusprendė: default'ų reikšmes, template konfigo ir kodo
// lentelės sutapimą bei `escalated` šaką `resolveDispatchTurnTier` viduje. Likusią biudžeto
// plano mechaniką dengia `interfaces-cli-dispatch-plan.test.ts`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_TURN_LIMITS, resolveMaxTurns } from "../application/token-governance/turn-budget.js";
import { resolveDispatchTurnTier } from "../application/token-governance/token-budget-optimizer.js";
import { DEFAULT_PREFLIGHT_LIMITS } from "../application/policy-governance/preflight-limits-policy.js";
import { resolveDispatchBudgetPlan } from "../interfaces/cli/dispatch/claude-dispatch/dispatch-budget-plan.js";

const TEMPLATE_TOKEN_BUDGET = path.join(process.cwd(), "templates", "vq", "config", "token-budget.json");

const metrics = { lines: 10, allowedPaths: 1, domains: 1, actionBullets: 1, domainNames: ["src"] };
const emptyFs = { readTextFileIfExists: async (): Promise<string | undefined> => undefined };

test("turn-budget: 2026-09-03 kalibracija — medium 90, repair 45, likusios pakopos nekinta", () => {
  // 15 dispatch'ų baigė tiksliai 61 turn'u (13 failed), o visos 4 repair nesėkmės sustojo
  // ties lubomis (31/31/31/61). Skaičiai pinami literalais: tyliai grįžti prie 60/30 negalima.
  assert.equal(DEFAULT_TURN_LIMITS.medium, 90);
  assert.equal(DEFAULT_TURN_LIMITS.repair, 45);
  assert.equal(DEFAULT_TURN_LIMITS.small, 20);
  assert.equal(DEFAULT_TURN_LIMITS.large, 180);
  assert.equal(DEFAULT_TURN_LIMITS.semanticReview, 12);

  assert.equal(resolveMaxTurns({ phase: "implementation", tier: "medium" }), 90);
  assert.equal(resolveMaxTurns({ phase: "repair", tier: "medium" }), 45);
  // Fazė nugali tier'ą: repair ant `large` lieka repair langas.
  assert.equal(resolveMaxTurns({ phase: "repair", tier: "large" }), 45);
});

test("turn-budget: template konfigas skelbia TĄ PAČIĄ lentelę kaip kodo fail-safe bazė", () => {
  // `verqestra install` sėja būtent šį failą; išsiskyręs template'as duotų naujiems diegimams
  // senas lubas, o auditas matuotų ne tai, ką sukasi ciklas.
  const template = JSON.parse(readFileSync(TEMPLATE_TOKEN_BUDGET, "utf8")) as { turnLimits: unknown };
  assert.deepEqual(template.turnLimits, { ...DEFAULT_TURN_LIMITS });
});

test("resolveDispatchTurnTier: eskaluotas bandymas paveldi large turn langą", () => {
  const escalated = resolveDispatchTurnTier({ publishedTier: "medium", metrics, escalated: true });
  assert.equal(escalated.tier, "large");
  assert.equal(escalated.source, "escalated");
  assert.equal(escalated.sourceLabel, "escalated");
  assert.equal(escalated.baseTier, "medium", "bazinis tier'as išlieka matomas");
  assert.equal(escalated.baseSource, "token-budget");
  assert.ok(
    escalated.reasons.some((reason) => reason.includes("base tier=medium")),
    "priežastis vardija bazinį tier'ą",
  );

  // Eskalacija be preflight sprendimo remiasi struktūriniu baziniu tier'u.
  const structural = resolveDispatchTurnTier({ metrics, escalated: true });
  assert.equal(structural.tier, "large");
  assert.equal(structural.baseSource, "structural");
});

test("resolveDispatchTurnTier: eskalacija nugali soft biudžeto nuleidimą", () => {
  // Soft kelias nuleistų `medium` -> `small`; eskalacija jau yra sprendimas leisti daugiau,
  // tad tam pačiam bandymui langas nekarpomas — soft priežastys lieka tik įraše.
  const decision = resolveDispatchTurnTier({
    publishedTier: "medium",
    metrics,
    reduceContextReasons: ["task tokens near limit"],
    escalated: true,
  });
  assert.equal(decision.tier, "large");
  assert.equal(decision.source, "escalated");
  assert.ok(decision.reasons.some((reason) => reason.includes("task tokens near limit")));
});

test("resolveDispatchTurnTier: be eskalacijos elgsena nepakitusi", () => {
  const published = resolveDispatchTurnTier({ publishedTier: "medium", metrics });
  assert.deepEqual(published, {
    tier: "medium",
    source: "token-budget",
    baseTier: "medium",
    baseSource: "token-budget",
    sourceLabel: "token-budget",
    reasons: ["preflight published token budget tier=medium"],
  });

  // `escalated: false` yra tas pats kelias kaip lauko nebuvimas.
  assert.deepEqual(resolveDispatchTurnTier({ publishedTier: "medium", metrics, escalated: false }), published);

  const reduced = resolveDispatchTurnTier({
    publishedTier: "large",
    metrics,
    reduceContextReasons: ["task tokens near limit"],
  });
  assert.equal(reduced.tier, "medium");
  assert.equal(reduced.source, "reduced");
  assert.equal(reduced.sourceLabel, "reduced(soft-budget)");
});

test("dispatch-budget-plan: eskaluotas bandymas gauna 180 turn'ų ir source=escalated įraše", async () => {
  const base = {
    runtimeRoot: "/repo/vq",
    taskId: "0159",
    taskMetrics: metrics,
    phase: "implementation" as const,
    reduceContextReasons: [] as readonly string[],
    remainingTaskTokens: null,
    policyFs: emptyFs,
    env: {},
    decision: { task_id: "0159", token_budget_tier: "medium" as const },
  };

  const plain = await resolveDispatchBudgetPlan(base);
  assert.equal(plain.dispatchMaxTurns, DEFAULT_TURN_LIMITS.medium);
  assert.match(plain.turnLog, /tier=medium source=token-budget/);

  const escalated = await resolveDispatchBudgetPlan({ ...base, escalated: true });
  // Lubos (`dispatchMaxTurns`) dengia pilną `large` langą, tad min(180, 180) = 180.
  assert.equal(escalated.dispatchMaxTurns, DEFAULT_TURN_LIMITS.large);
  assert.ok(
    DEFAULT_PREFLIGHT_LIMITS.dispatchMaxTurns >= DEFAULT_TURN_LIMITS.large,
    "lubos negali tyliai nukirpti eskaluoto lango",
  );
  assert.match(escalated.turnLog, /tier=large source=escalated base_tier=medium base_source=token-budget/);
  assert.ok(escalated.dispatchTimeoutMs > plain.dispatchTimeoutMs, "platesnis turn langas plečia ir wall-clock");
});
