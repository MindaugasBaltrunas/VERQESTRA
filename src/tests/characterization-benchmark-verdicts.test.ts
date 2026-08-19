// VQ-204 characterization (PAR-1): compareBenchmarkRuns verdiktų matrica +
// canDeclareOptimizationSuccess prieš pažodinę AG_loop fixture kopiją. Comparable įvestys:
// scalar overrides dedami ant emptyUsageTotals()-pagrįsto skeleto (buildComparable) —
// fixture pin'ina TIK laukus, kurie keičia verdiktą. Record režimo NĖRA (PAR-1).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  canDeclareOptimizationSuccess,
  compareBenchmarkRuns,
  emptyUsageTotals,
  type BenchmarkComparable,
  type BenchmarkTotals,
  type TokensPerAcceptedChange,
} from "../domain/metrics/index.js";

type ComparableOverrides = {
  config_hash?: string;
  case_ids?: string[];
  integrity_ok?: boolean;
  task_count?: number;
  measured_tasks?: number;
  total_tokens?: number;
  accepted_changes?: number;
  tokens_status?: TokensPerAcceptedChange["status"];
  first_pass_tasks?: number;
  human_review_total?: number;
  out_of_scope_file_total?: number;
};

type VerdictCase = { id: string; current: ComparableOverrides; expect: Record<string, unknown> };

type VerdictFixture = {
  schema_version: number;
  record?: boolean;
  regression_limit_pct: number;
  baseline_defaults: ComparableOverrides;
  cases: VerdictCase[];
};

const fixturePath = path.resolve(
  process.cwd(),
  "src",
  "tests",
  "fixtures",
  "characterization",
  "benchmark-verdicts.json",
);

const fixture: VerdictFixture = JSON.parse(await readFile(fixturePath, "utf8"));

function buildComparable(overrides: ComparableOverrides): BenchmarkComparable {
  const merged = { ...fixture.baseline_defaults, ...overrides };
  const taskCount = merged.task_count ?? 10;
  const acceptedChanges = merged.accepted_changes ?? 0;
  const totalTokens = merged.total_tokens ?? 0;
  const status = merged.tokens_status ?? "computed";
  const totals: BenchmarkTotals = {
    measured_tasks: merged.measured_tasks ?? taskCount,
    task_count: taskCount,
    usage: { ...emptyUsageTotals(), total_tokens: totalTokens },
    llm_calls: taskCount,
    turns: taskCount * 10,
    first_pass_tasks: merged.first_pass_tasks ?? 0,
    first_pass_rate: taskCount > 0 ? (merged.first_pass_tasks ?? 0) / taskCount : null,
    repair_total: 0,
    human_review_total: merged.human_review_total ?? 0,
    out_of_scope_file_total: merged.out_of_scope_file_total ?? 0,
    accepted_changes: acceptedChanges,
  };
  const tokensPerAccepted: TokensPerAcceptedChange = {
    total_tokens: totalTokens,
    accepted_changes: acceptedChanges,
    value: status === "computed" && acceptedChanges > 0 ? totalTokens / acceptedChanges : null,
    status,
    note: "fixture",
  };
  return {
    config_hash: merged.config_hash ?? "cfg-1",
    case_ids: merged.case_ids ?? ["case-a"],
    integrity_ok: merged.integrity_ok ?? true,
    totals,
    tokens_per_verified_accepted_change: tokensPerAccepted,
  };
}

function runCase(verdictCase: VerdictCase): unknown {
  const baseline = buildComparable({});
  const current = buildComparable(verdictCase.current);
  const comparison = compareBenchmarkRuns(baseline, current, {
    maxTokenRegressionPct: fixture.regression_limit_pct,
  });
  const declaration = canDeclareOptimizationSuccess(comparison);
  return { comparison, declaration };
}

test("benchmark-verdicts fixture is well-formed (schema v1, unique ids)", () => {
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length >= 9, "fixture must keep its recorded coverage");
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
});

for (const verdictCase of fixture.cases) {
  test(`benchmark verdict contract: ${verdictCase.id}`, () => {
    const actual = JSON.parse(JSON.stringify(runCase(verdictCase)));
    assert.deepStrictEqual(actual, verdictCase.expect, verdictCase.id);
  });
}
