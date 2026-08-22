import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_MODEL_ID } from "../application/ports/execution-plan.js";
import {
  aggregateSamples,
  aggregateSamplesByMode,
  toBenchmarkMetrics,
  toModeMetrics,
  COST_BASIS_KEYS,
  COST_METRIC_KEYS,
  RATE_METRIC_KEYS,
  type BenchmarkMetricsReport,
  type CostMetricKey,
} from "../domain/metrics/aggregate.js";
import {
  billableTokens,
  cacheReadTokens,
  totalTokens,
} from "../domain/metrics/token-cost.js";
import type { MetricValue, UnmeasuredReason } from "../domain/metrics/metric-value.js";
import { isMeasured, UNMEASURED_REASONS } from "../domain/metrics/metric-value.js";
import type {
  AcceptanceVerdict,
  BenchmarkSample,
  CheckResult,
  ExecutionMode,
} from "../domain/result.js";
import { validateBenchmarkSample } from "../domain/schema-validation.js";
import { validSample } from "./sample-fixtures.js";

/**
 * BENCH-7 aggregation tests.
 *
 * Every metric the aggregate publishes is asserted twice by construction: once
 * on its boundary — the populations where its denominator is empty — and once
 * for determinism under reordering. Both suites are generated from the exported
 * metric key lists, and a separate test binds those lists to the shape the
 * aggregate actually returns, so a metric added later without its own boundary
 * and determinism case fails here instead of shipping unmeasured.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SampleShape {
  readonly sampleId?: string;
  readonly mode?: ExecutionMode;
  readonly model?: string;
  readonly verdict?: AcceptanceVerdict;
  readonly claimedDone?: boolean;
  readonly attempts?: number;
  readonly repairs?: number;
  readonly humanReviewEvents?: number;
  readonly outOfScopeFiles?: readonly string[];
  readonly checks?: readonly CheckResult[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  /** `false` publishes a usage block whose accounting failed — the model ran and the tokens are unknown. */
  readonly usageCaptured?: boolean;
  readonly llmCalls?: number;
  readonly durationMs?: number;
}

const BASE = validSample();

/** A verdict carries the class of reason that produced it; the aggregate reads the verdict, a reader reads these. */
const REASONS_BY_VERDICT: Readonly<Record<AcceptanceVerdict, readonly string[]>> = {
  "verified-accepted": [],
  rejected: ["check-failed"],
  inconclusive: ["evidence-missing"],
};

/**
 * A sample stating only the fields a case is about.
 *
 * Two invariants the stored schema enforces are kept here rather than left to
 * each case: an out-of-scope file is also a changed file, and every repair is
 * one of the attempts, so stating `repairs` alone raises the attempt count with
 * it. A fixture that broke either would exercise the aggregate on a record no
 * store would ever hand it, which proves nothing about the metric — the two
 * cases that deliberately want such a record state the contradiction outright.
 */
function sample(shape: SampleShape = {}): BenchmarkSample {
  const verdict = shape.verdict ?? "verified-accepted";
  const outOfScopeFiles = shape.outOfScopeFiles ?? BASE.workspace.outOfScopeFiles;
  const repairs = shape.repairs ?? BASE.telemetry.repairs;
  return validSample({
    sampleId: shape.sampleId ?? BASE.sampleId,
    mode: shape.mode ?? BASE.mode,
    durationMs: shape.durationMs ?? BASE.durationMs,
    telemetry: {
      ...BASE.telemetry,
      model: shape.model ?? BASE.telemetry.model,
      inputTokens: shape.inputTokens ?? BASE.telemetry.inputTokens,
      outputTokens: shape.outputTokens ?? BASE.telemetry.outputTokens,
      llmCalls: shape.llmCalls ?? BASE.telemetry.llmCalls,
      attempts: shape.attempts ?? Math.max(BASE.telemetry.attempts, repairs + 1),
      repairs,
      humanReviewEvents: shape.humanReviewEvents ?? BASE.telemetry.humanReviewEvents,
    },
    checks: shape.checks ?? BASE.checks,
    workspace: {
      ...BASE.workspace,
      changedFiles: [...new Set([...BASE.workspace.changedFiles, ...outOfScopeFiles])],
      outOfScopeFiles,
    },
    acceptance: {
      verdict,
      reasons: REASONS_BY_VERDICT[verdict],
      agentClaimedDone: shape.claimedDone ?? verdict === "verified-accepted",
    },
    ...(shape.cacheCreationInputTokens === undefined &&
    shape.cacheReadInputTokens === undefined &&
    shape.usageCaptured === undefined
      ? {}
      : {
          usage: {
            source: "envelope" as const,
            captured: shape.usageCaptured ?? true,
            cacheCreationInputTokens: shape.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: shape.cacheReadInputTokens ?? 0,
          },
        }),
  });
}

function check(kind: CheckResult["kind"], status: CheckResult["status"]): CheckResult {
  return { id: `${kind}-${status}`, kind, status, durationMs: 1_000 };
}

/**
 * Six conclusive samples and one inconclusive one, chosen so every rate lands on
 * a different fraction where its denominator allows — a numerator swapped
 * between two metrics would otherwise still produce the expected number.
 */
const CORPUS: readonly BenchmarkSample[] = [
  sample({ sampleId: "s-1", checks: [check("test", "passed"), check("architecture", "passed")] }),
  sample({ sampleId: "s-2", repairs: 2, checks: [check("test", "passed")] }),
  sample({
    sampleId: "s-3",
    verdict: "rejected",
    claimedDone: true,
    checks: [check("test", "failed"), check("architecture", "failed")],
  }),
  sample({
    sampleId: "s-4",
    verdict: "rejected",
    claimedDone: false,
    outOfScopeFiles: ["src/elsewhere.mjs"],
    checks: [check("security", "failed")],
  }),
  sample({ sampleId: "s-5", humanReviewEvents: 1, checks: [check("security", "passed")] }),
  sample({ sampleId: "s-6", verdict: "rejected", claimedDone: false, checks: [] }),
  sample({ sampleId: "s-7", verdict: "inconclusive", claimedDone: true, repairs: 5 }),
];

const MIXED_MODES: readonly BenchmarkSample[] = [
  // The control calls no model, so a control sample reporting model cost is not one.
  sample({
    sampleId: "d-1",
    mode: "deterministic-control",
    model: CONTROL_MODEL_ID,
    inputTokens: 0,
    outputTokens: 0,
    llmCalls: 0,
  }),
  sample({ sampleId: "a-1", mode: "agent-solo", verdict: "rejected", claimedDone: false }),
  sample({ sampleId: "l-1", mode: "ag-loop" }),
  sample({ sampleId: "a-2", mode: "agent-solo" }),
];

/**
 * A population where some metrics are measured and others are not, so the
 * determinism suite also covers the reasons and details of the absent ones —
 * both are report content BENCH-10 requires to be reproducible.
 */
const MIXED_MEASURABILITY: readonly BenchmarkSample[] = [
  sample({ sampleId: "m-1", claimedDone: false, checks: [check("test", "passed")] }),
  sample({ sampleId: "m-2", verdict: "rejected", claimedDone: false, checks: [] }),
  sample({ sampleId: "m-3", verdict: "inconclusive", claimedDone: true }),
];

const STORABLE_FIXTURES: readonly BenchmarkSample[] = [
  ...CORPUS,
  ...MIXED_MODES,
  ...MIXED_MEASURABILITY,
];

// ---------------------------------------------------------------------------
// Reading a report
// ---------------------------------------------------------------------------

/** Every BENCH-7 metric of a report, keyed by the name a failure message should show. */
function metricsOf(report: BenchmarkMetricsReport): ReadonlyMap<string, MetricValue> {
  const entries: [string, MetricValue][] = RATE_METRIC_KEYS.map((key) => [key, report[key]]);
  for (const basis of COST_BASIS_KEYS) {
    for (const cost of COST_METRIC_KEYS) {
      entries.push([`${basis}.${cost}`, report[basis][cost]]);
    }
  }
  return new Map(entries);
}

const EMPTY = aggregateSamples([]);
const ALL_INCONCLUSIVE = aggregateSamples([
  sample({ sampleId: "i-1", verdict: "inconclusive" }),
  sample({ sampleId: "i-2", verdict: "inconclusive", claimedDone: true }),
]);
const IN_ORDER = aggregateSamples(CORPUS);

const METRIC_NAMES = [...metricsOf(EMPTY)].map(([name]) => name);

function assertUnmeasured(metric: MetricValue, reason: UnmeasuredReason, name: string): void {
  assert.equal(metric.value, undefined, `${name} reported a value it could not measure`);
  assert.ok(!isMeasured(metric), `${name} claims to be measured`);
  if (metric.value === undefined) {
    assert.equal(metric.reason, reason, `${name} gave the wrong reason`);
    // A detail that only restates the code tells a reader nothing the code did not.
    assert.notEqual(metric.detail, metric.reason, `${name} restates its code as its detail`);
    assert.ok(metric.detail.length > 20, `${name} explains itself in ${metric.detail.length} chars`);
  }
}

// ---------------------------------------------------------------------------
// The metric set itself
// ---------------------------------------------------------------------------

test("BENCH-7 publishes exactly the metrics the specification names", () => {
  assert.deepEqual(METRIC_NAMES, [
    "acceptedRate",
    "firstPassRate",
    "repairRate",
    "humanReviewRate",
    "outOfScopeRate",
    "testFailureRate",
    "architectureFailureRate",
    "securityFailureRate",
    "perAcceptedChange.billableTokens",
    "perAcceptedChange.cacheReadTokens",
    "perAcceptedChange.durationMs",
    "perAcceptedChange.llmCalls",
    "perVerifiedAcceptedChange.billableTokens",
    "perVerifiedAcceptedChange.cacheReadTokens",
    "perVerifiedAcceptedChange.durationMs",
    "perVerifiedAcceptedChange.llmCalls",
  ]);
});

test("the exported key lists cover every metric the report actually publishes", () => {
  // The boundary and determinism suites are generated from the key lists. A
  // metric added to the report but not to a list would be published with no
  // coverage at all, and every generated test would still pass.
  const bookkeeping = new Set(["sampleCount", "conclusiveCount", "inconclusiveCount"]);
  assert.deepEqual(
    Object.keys(EMPTY).filter((key) => !bookkeeping.has(key)),
    [...RATE_METRIC_KEYS, ...COST_BASIS_KEYS],
  );
  for (const basis of COST_BASIS_KEYS) {
    assert.deepEqual(Object.keys(EMPTY[basis]), [...COST_METRIC_KEYS]);
  }
});

// ---------------------------------------------------------------------------
// Boundary: the populations where a denominator is empty
// ---------------------------------------------------------------------------

for (const [name, metric] of metricsOf(EMPTY)) {
  test(`${name} is undefined with reason no-samples over an empty suite`, () => {
    assertUnmeasured(metric, "no-samples", name);
    assert.equal(metric.denominator, 0);
  });
}

for (const [name, metric] of metricsOf(ALL_INCONCLUSIVE)) {
  test(`${name} is undefined with reason no-conclusive-samples when nothing could be verified`, () => {
    assertUnmeasured(metric, "no-conclusive-samples", name);
  });
}

test("inconclusive samples are counted, not dropped", () => {
  assert.equal(ALL_INCONCLUSIVE.sampleCount, 2);
  assert.equal(ALL_INCONCLUSIVE.conclusiveCount, 0);
  assert.equal(ALL_INCONCLUSIVE.inconclusiveCount, 2);
});

/** The check kinds BENCH-7 reports a failure rate for, paired with the rate each one feeds. */
const FAILURE_RATES = [
  { kind: "test", metric: "testFailureRate" },
  { kind: "architecture", metric: "architectureFailureRate" },
  { kind: "security", metric: "securityFailureRate" },
] as const;

for (const { kind, metric } of FAILURE_RATES) {
  test(`${metric} is unmeasured when no conclusive sample carries a decided ${kind} check`, () => {
    const other = FAILURE_RATES.filter((entry) => entry.kind !== kind);
    const report = aggregateSamples([
      sample({
        verdict: "rejected",
        checks: other.map((entry) => check(entry.kind, "failed")),
      }),
    ]);
    assertUnmeasured(report[metric], "no-applicable-samples", metric);
    for (const entry of other) {
      assert.equal(report[entry.metric].value, 1, `${entry.metric} should have been measured`);
    }
  });
}

test("a check that never reached a verdict is neither a failure nor a passing denominator entry", () => {
  const report = aggregateSamples([
    sample({
      verdict: "rejected",
      checks: [check("architecture", "errored"), check("security", "skipped")],
    }),
  ]);
  assertUnmeasured(
    report.architectureFailureRate,
    "no-applicable-samples",
    "architectureFailureRate",
  );
  assertUnmeasured(report.securityFailureRate, "no-applicable-samples", "securityFailureRate");
});

test("the verifier gates that are neither test, architecture nor security enter no rate", () => {
  const report = aggregateSamples([
    sample({ verdict: "rejected", checks: [check("other", "failed"), check("build", "failed")] }),
  ]);
  for (const { metric } of FAILURE_RATES) {
    assertUnmeasured(report[metric], "no-applicable-samples", metric);
  }
});

for (const cost of COST_METRIC_KEYS) {
  test(`perAcceptedChange.${cost} is unmeasured when the agent claimed nothing`, () => {
    const report = aggregateSamples([sample({ verdict: "rejected", claimedDone: false })]);
    assertUnmeasured(
      report.perAcceptedChange[cost],
      "no-accepted-change",
      `perAcceptedChange.${cost}`,
    );
    assertUnmeasured(
      report.perVerifiedAcceptedChange[cost],
      "no-verified-accepted-change",
      `perVerifiedAcceptedChange.${cost}`,
    );
  });
}

test("a claim the verifier refused still counts as an accepted change and never as a verified one", () => {
  const report = aggregateSamples([
    sample({ verdict: "rejected", claimedDone: true, inputTokens: 900, outputTokens: 100 }),
  ]);
  assert.equal(report.perAcceptedChange.billableTokens.value, 1_000);
  assertUnmeasured(
    report.perVerifiedAcceptedChange.billableTokens,
    "no-verified-accepted-change",
    "perVerifiedAcceptedChange.billableTokens",
  );
  assert.equal(report.acceptedRate.value, 0, "the verifier accepted none of one conclusive sample");
});

test("a change the verifier granted but the agent never claimed leaves the claimed basis empty", () => {
  // The mirror image of the case above, and the reason the two bases exist: the
  // gap between what agents claim and what they achieve runs in both directions.
  const report = aggregateSamples([
    sample({ claimedDone: false, inputTokens: 900, outputTokens: 100 }),
  ]);
  assertUnmeasured(
    report.perAcceptedChange.billableTokens,
    "no-accepted-change",
    "perAcceptedChange.billableTokens",
  );
  assert.equal(report.perVerifiedAcceptedChange.billableTokens.value, 1_000);
  assert.equal(report.acceptedRate.value, 1);
});

test("a claim on a sample nobody could verify is not an accepted change", () => {
  const report = aggregateSamples([
    sample({ sampleId: "s-1", verdict: "inconclusive", claimedDone: true }),
    sample({ sampleId: "s-2", verdict: "rejected", claimedDone: false }),
  ]);
  assertUnmeasured(
    report.perAcceptedChange.billableTokens,
    "no-accepted-change",
    "perAcceptedChange.billableTokens",
  );
  assert.equal(report.conclusiveCount, 1);
  assert.equal(report.inconclusiveCount, 1);
});

// ---------------------------------------------------------------------------
// Boundary: a total that cannot be trusted
// ---------------------------------------------------------------------------

/** One way to make each cost total unusable: an overflow, and a term that is not a whole number. */
const UNUSABLE_COST: Readonly<Record<CostMetricKey, SampleShape>> = {
  billableTokens: {
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: Number.MAX_SAFE_INTEGER,
  },
  cacheReadTokens: { cacheReadInputTokens: Number.MAX_SAFE_INTEGER },
  durationMs: { durationMs: 0.5 },
  llmCalls: { llmCalls: Number.MAX_SAFE_INTEGER },
};

for (const cost of COST_METRIC_KEYS) {
  for (const basis of COST_BASIS_KEYS) {
    test(`${basis}.${cost} refuses a total arithmetic can no longer be trusted on`, () => {
      // Fractional terms sum to a whole number, and to a different one depending
      // on the order they were added in; an overflow leaves exact arithmetic
      // altogether. Neither may be reported as a measurement.
      const report = aggregateSamples([
        sample({ sampleId: "s-1", ...UNUSABLE_COST[cost] }),
        sample({ sampleId: "s-2", ...UNUSABLE_COST[cost] }),
      ]);
      assertUnmeasured(report[basis][cost], "unreliable-total", `${basis}.${cost}`);
      assert.equal(report.acceptedRate.value, 1, "an unusable total does not disturb the rates");
    });
  }
}

test("an untrustworthy total outranks the empty denominator it would also have had", () => {
  const report = aggregateSamples([
    sample({ verdict: "rejected", claimedDone: false, durationMs: 0.5 }),
  ]);
  assertUnmeasured(
    report.perAcceptedChange.durationMs,
    "unreliable-total",
    "perAcceptedChange.durationMs",
  );
  assert.equal(report.perAcceptedChange.durationMs.denominator, 0);
  assertUnmeasured(
    report.perAcceptedChange.billableTokens,
    "no-accepted-change",
    "perAcceptedChange.billableTokens",
  );
});

/**
 * Reasons the vocabulary declares for another fold over the same samples.
 * `no-captured-usage` belongs to the compression aggregate, which refuses a
 * token total whose population did not all report captured usage; it is produced
 * and asserted in `compression-aggregate.test.ts`. Listed here rather than
 * dropped from the property, so a reason that becomes dead everywhere still
 * fails a test.
 */
const REASONS_OF_ANOTHER_FOLD: readonly UnmeasuredReason[] = ["no-captured-usage"];

test("every declared unmeasured reason is one this aggregate actually produces", () => {
  const produced = new Set<UnmeasuredReason>();
  const populations: readonly (readonly BenchmarkSample[])[] = [
    [],
    [sample({ verdict: "inconclusive" })],
    [sample({ verdict: "rejected", claimedDone: false, checks: [] })],
    [sample({ durationMs: 0.5 })],
  ];
  for (const population of populations) {
    for (const [, metric] of metricsOf(aggregateSamples(population))) {
      if (metric.value === undefined) produced.add(metric.reason);
    }
  }
  assert.deepEqual(
    UNMEASURED_REASONS.filter(
      (reason) => !produced.has(reason) && !REASONS_OF_ANOTHER_FOLD.includes(reason),
    ),
    [],
    "a declared reason no population reaches is either dead or untested",
  );
});

test("a measurement exists only where a denominator does", () => {
  const reports = [
    EMPTY,
    ALL_INCONCLUSIVE,
    IN_ORDER,
    aggregateSamples(MIXED_MEASURABILITY),
    aggregateSamples([sample({ durationMs: 0.5 })]),
  ];
  for (const report of reports) {
    for (const [name, metric] of metricsOf(report)) {
      if (metric.denominator <= 0) {
        assert.ok(!isMeasured(metric), `${name} reported a value over an empty denominator`);
      }
      if (isMeasured(metric)) {
        assert.ok(Number.isFinite(metric.value), `${name} reported ${metric.value}`);
        assert.ok(metric.denominator > 0, `${name} measured over ${metric.denominator}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Rates over a stated population
// ---------------------------------------------------------------------------

test("every fixture this suite measures is a record the store would accept", () => {
  for (const entry of STORABLE_FIXTURES) {
    const validated = validateBenchmarkSample(entry);
    assert.ok(
      validated.ok,
      `${entry.sampleId} is not a storable sample: ${
        validated.ok ? "" : validated.problems.map((problem) => problem.message).join("; ")
      }`,
    );
  }
});

test("the fixtures that exercise the unusable-total path are ones no store would have written", () => {
  // The guard exists for records that were only ever held in memory; stating
  // that here keeps the two classes of fixture from being confused later.
  assert.equal(validateBenchmarkSample(sample({ durationMs: 0.5 })).ok, false);
  assert.equal(validateBenchmarkSample(sample({ attempts: 1, repairs: 1 })).ok, false);
});

test("every rate divides its own numerator by the conclusive population", () => {
  assert.equal(IN_ORDER.conclusiveCount, 6);
  assert.equal(IN_ORDER.inconclusiveCount, 1);

  // s-1, s-2, s-5 were verified accepted; s-2 needed a repair, so it is not first pass.
  assert.equal(IN_ORDER.acceptedRate.value, 3 / 6);
  assert.equal(IN_ORDER.firstPassRate.value, 2 / 6);
  // s-7 repaired five times and is inconclusive, so it enters no numerator.
  assert.equal(IN_ORDER.repairRate.value, 1 / 6);
  assert.equal(IN_ORDER.humanReviewRate.value, 1 / 6);
  assert.equal(IN_ORDER.outOfScopeRate.value, 1 / 6);
  // Only s-1, s-2 and s-3 carry a decided test check; one of them failed.
  assert.equal(IN_ORDER.testFailureRate.value, 1 / 3);
  assert.equal(IN_ORDER.architectureFailureRate.value, 1 / 2);
  assert.equal(IN_ORDER.securityFailureRate.value, 1 / 2);
});

test("a second attempt is not a first pass even when nothing had to be repaired", () => {
  const report = aggregateSamples([sample({ attempts: 2 })]);
  assert.equal(report.acceptedRate.value, 1);
  assert.equal(report.firstPassRate.value, 0);
});

test("a repair reported against a single attempt is not a first pass either", () => {
  // A record no store would accept; the aggregate still refuses to call it
  // first-pass on the strength of the attempt count it contradicts.
  const report = aggregateSamples([sample({ attempts: 1, repairs: 1 })]);
  assert.equal(report.acceptedRate.value, 1);
  assert.equal(report.firstPassRate.value, 0);
});

test("a failure rate counts samples, not checks: two failed checks in one run are one failure", () => {
  // Every check a scenario declares is stored under the `test` kind, so several
  // of them in one sample is the ordinary case rather than a contrived one.
  const report = aggregateSamples([
    sample({
      sampleId: "s-1",
      verdict: "rejected",
      checks: [check("test", "failed"), { ...check("test", "failed"), id: "unit-tests" }],
    }),
    sample({ sampleId: "s-2", checks: [check("test", "passed")] }),
  ]);
  assert.equal(report.testFailureRate.value, 1 / 2);
  assert.equal(report.testFailureRate.numerator, 1);
});

test("a sample with both a passed and a failed check of one kind counts as a failure once", () => {
  const report = aggregateSamples([
    sample({
      verdict: "rejected",
      checks: [check("architecture", "passed"), check("architecture", "failed")],
    }),
  ]);
  assert.equal(report.architectureFailureRate.value, 1);
  assert.deepEqual(
    {
      numerator: report.architectureFailureRate.numerator,
      denominator: report.architectureFailureRate.denominator,
    },
    { numerator: 1, denominator: 1 },
  );
});

test("cost per change divides the whole population's cost by the changes it produced", () => {
  const report = aggregateSamples([
    sample({
      sampleId: "s-1",
      inputTokens: 800,
      outputTokens: 200,
      llmCalls: 4,
      durationMs: 10_000,
    }),
    sample({
      sampleId: "s-2",
      verdict: "rejected",
      claimedDone: true,
      inputTokens: 400,
      outputTokens: 100,
      llmCalls: 2,
      durationMs: 6_000,
    }),
  ]);
  // Both runs were paid for; the agent claimed two changes and the verifier granted one.
  assert.equal(report.perAcceptedChange.billableTokens.value, 1_500 / 2);
  assert.equal(report.perAcceptedChange.llmCalls.value, 6 / 2);
  assert.equal(report.perAcceptedChange.durationMs.value, 16_000 / 2);
  assert.equal(report.perVerifiedAcceptedChange.billableTokens.value, 1_500);
  assert.equal(report.perVerifiedAcceptedChange.llmCalls.value, 6);
  assert.equal(report.perVerifiedAcceptedChange.durationMs.value, 16_000);
});

test("an inconclusive sample is excluded from the cost totals as well as from the rates", () => {
  const report = aggregateSamples([
    sample({ sampleId: "s-1", inputTokens: 100, outputTokens: 0, llmCalls: 1 }),
    sample({
      sampleId: "s-2",
      verdict: "inconclusive",
      inputTokens: 9_000,
      outputTokens: 9_000,
      llmCalls: 99,
    }),
  ]);
  assert.equal(report.perVerifiedAcceptedChange.billableTokens.value, 100);
  assert.equal(report.inconclusiveCount, 1);
});

test("a measured metric carries the counts it was computed from", () => {
  assert.deepEqual(
    { numerator: IN_ORDER.acceptedRate.numerator, denominator: IN_ORDER.acceptedRate.denominator },
    { numerator: 3, denominator: 6 },
  );
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** A fixed reordering: reversed and rotated, so no sample keeps its position. */
function reordered(samples: readonly BenchmarkSample[]): readonly BenchmarkSample[] {
  const reversed = [...samples].reverse();
  return [...reversed.slice(3), ...reversed.slice(0, 3)];
}

const OUT_OF_ORDER = aggregateSamples(reordered(CORPUS));

for (const name of METRIC_NAMES) {
  test(`${name} does not depend on the order samples were recorded in`, () => {
    assert.deepEqual(
      metricsOf(OUT_OF_ORDER).get(name),
      metricsOf(IN_ORDER).get(name),
      `${name} changed when the same samples arrived in another order`,
    );
  });

  test(`${name} keeps its reason and detail under reordering`, () => {
    // The same suite over a population where some metrics have no value: the
    // reason and the detail are report content too, and both interpolate counts.
    assert.deepEqual(
      metricsOf(aggregateSamples(reordered(MIXED_MEASURABILITY))).get(name),
      metricsOf(aggregateSamples(MIXED_MEASURABILITY)).get(name),
    );
  });
}

test("aggregating the same samples twice produces the same report", () => {
  assert.deepEqual(aggregateSamples(CORPUS), IN_ORDER);
});

test("a report serialises identically whatever order it was aggregated from", () => {
  // `deepEqual` would accept two reports whose keys are emitted in different
  // orders; BENCH-10 requires the serialised report itself to be reproducible.
  assert.equal(JSON.stringify(OUT_OF_ORDER), JSON.stringify(IN_ORDER));
  assert.equal(
    JSON.stringify(aggregateSamplesByMode(reordered(MIXED_MODES))),
    JSON.stringify(aggregateSamplesByMode(MIXED_MODES)),
  );
});

test("aggregation does not mutate its input", () => {
  const before = structuredClone(CORPUS);
  aggregateSamples(CORPUS);
  aggregateSamplesByMode(CORPUS);
  assert.deepEqual(CORPUS, before);
});

// ---------------------------------------------------------------------------
// Per-mode aggregation
// ---------------------------------------------------------------------------

test("modes are reported separately, in the declared order, never averaged together", () => {
  const reports = aggregateSamplesByMode(MIXED_MODES);
  assert.deepEqual(
    reports.map((entry) => entry.mode),
    ["ag-loop", "agent-solo", "deterministic-control"],
  );
  assert.equal(reports[0]?.report.acceptedRate.value, 1);
  assert.equal(reports[1]?.report.acceptedRate.value, 1 / 2);
});

test("a mode no sample was recorded for is absent rather than reported as zero", () => {
  assert.deepEqual(
    aggregateSamplesByMode([sample({ mode: "ag-loop" })]).map((entry) => entry.mode),
    ["ag-loop"],
  );
  assert.deepEqual(aggregateSamplesByMode([]), []);
  assert.deepEqual(toModeMetrics([]), []);
});

test("a mode with no repair or human-review loop reports a measured zero, not an absent value", () => {
  // Those loops exist only in `ag-loop`; the other modes cannot reach them, so
  // their zero is the floor the comparison rests on rather than a gap.
  const reports = aggregateSamplesByMode(MIXED_MODES).filter((entry) => entry.mode !== "ag-loop");
  assert.equal(reports.length, 2);
  for (const entry of reports) {
    for (const key of ["repairRate", "humanReviewRate"] as const) {
      assert.ok(isMeasured(entry.report[key]), `${entry.mode}.${key} is absent where 0 is a fact`);
      assert.equal(entry.report[key].value, 0);
    }
    assert.equal(entry.report.firstPassRate.value, entry.report.acceptedRate.value);
  }
});

// ---------------------------------------------------------------------------
// The published contract
// ---------------------------------------------------------------------------

test("the published metrics view keeps undefined where the report has no value", () => {
  const metrics = toBenchmarkMetrics(EMPTY);
  assert.equal(metrics.sampleCount, 0);
  assert.equal(metrics.inconclusiveCount, 0);
  for (const key of RATE_METRIC_KEYS) {
    assert.equal(metrics[key], undefined, `${key} is not undefined in the published view`);
  }
  for (const basis of COST_BASIS_KEYS) {
    for (const cost of COST_METRIC_KEYS) {
      assert.equal(metrics[basis][cost], undefined, `${basis}.${cost} is not undefined`);
    }
  }
});

test("the published metrics view maps every metric to its own value", () => {
  // A report whose fourteen values are all different, so a field-by-field
  // mapping that swapped two of them cannot still look correct.
  let next = 0;
  const distinct = (): MetricValue => {
    next += 1;
    return { value: next, numerator: next, denominator: 1 };
  };
  const report: BenchmarkMetricsReport = {
    sampleCount: 41,
    conclusiveCount: 40,
    inconclusiveCount: 1,
    acceptedRate: distinct(),
    firstPassRate: distinct(),
    repairRate: distinct(),
    humanReviewRate: distinct(),
    outOfScopeRate: distinct(),
    testFailureRate: distinct(),
    architectureFailureRate: distinct(),
    securityFailureRate: distinct(),
    perAcceptedChange: {
      billableTokens: distinct(),
      cacheReadTokens: distinct(),
      durationMs: distinct(),
      llmCalls: distinct(),
    },
    perVerifiedAcceptedChange: {
      billableTokens: distinct(),
      cacheReadTokens: distinct(),
      durationMs: distinct(),
      llmCalls: distinct(),
    },
  };

  const metrics = toBenchmarkMetrics(report);
  assert.equal(metrics.sampleCount, 41);
  assert.equal(metrics.inconclusiveCount, 1);
  for (const key of RATE_METRIC_KEYS) {
    assert.equal(metrics[key], report[key].value, key);
  }
  for (const basis of COST_BASIS_KEYS) {
    for (const cost of COST_METRIC_KEYS) {
      assert.equal(metrics[basis][cost], report[basis][cost].value, `${basis}.${cost}`);
    }
  }
});

test("per-mode metrics narrow to the published contract mode by mode", () => {
  const reports = aggregateSamplesByMode(MIXED_MODES);
  assert.deepEqual(
    toModeMetrics(reports).map((entry) => entry.mode),
    reports.map((entry) => entry.mode),
  );
  assert.equal(toModeMetrics(reports)[1]?.metrics.acceptedRate, 1 / 2);
});

// ---------------------------------------------------------------------------
// What the cost metric counts (MODE_COST_KPI_VERSION 2)
// ---------------------------------------------------------------------------

test("billableTokens counts cache creation, because the provider bills for it", () => {
  // Version 1 of this metric summed `input + output` alone. On a real VERQESTRA loop that saw
  // 2 690 tokens where 47 361 were billable: `usage.input_tokens` excludes cached prefixes by
  // definition, so the omission grew with the reused prefix — the very thing the `ag-loop` mode
  // has and `agent-solo` does not.
  const report = aggregateSamples([
    sample({ inputTokens: 16, outputTokens: 674, cacheCreationInputTokens: 1_310 }),
  ]);
  assert.equal(report.perVerifiedAcceptedChange.billableTokens.value, 2_000);
});

test("cache reads are reported beside the bill, never folded into it", () => {
  // They are charged at a fraction of input. Adding them would overstate the bill by about the
  // margin omitting cache creation understated it, and hiding them would leave the mode that
  // reuses a large prefix looking free.
  const report = aggregateSamples([
    sample({
      inputTokens: 100,
      outputTokens: 100,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 9_000,
    }),
  ]);
  assert.equal(report.perVerifiedAcceptedChange.billableTokens.value, 500);
  assert.equal(report.perVerifiedAcceptedChange.cacheReadTokens.value, 9_000);
});

test("a sample whose accounting broke refuses the token metrics and only those", () => {
  // The tokens were spent; summing the samples that did report leaves them out and understates
  // exactly the mode whose accounting failed (`domain/result.ts`). Duration and call count rest
  // on nothing the usage block carries, so refusing them would claim a wider failure.
  const report = aggregateSamples([
    sample({ sampleId: "s-1", inputTokens: 100, outputTokens: 100, durationMs: 4_000 }),
    sample({ sampleId: "s-2", usageCaptured: false, durationMs: 4_000 }),
  ]);
  assertUnmeasured(
    report.perVerifiedAcceptedChange.billableTokens,
    "no-captured-usage",
    "perVerifiedAcceptedChange.billableTokens",
  );
  assert.equal(
    report.perVerifiedAcceptedChange.billableTokens.denominator,
    2,
    "the refusal keeps the real denominator; a zero there would be untraceable",
  );
  assert.equal(report.perVerifiedAcceptedChange.durationMs.value, 4_000);
  assert.equal(report.perVerifiedAcceptedChange.llmCalls.value !== undefined, true);
});

test("an absent usage block is not a broken one", () => {
  // A version 1 telemetry envelope had no cache dimension, and `deterministic-control` calls no
  // model at all. In both cases the cache terms are genuinely zero, and refusing would report a
  // failure that did not happen.
  const report = aggregateSamples([sample({ inputTokens: 100, outputTokens: 100 })]);
  assert.equal(report.perVerifiedAcceptedChange.billableTokens.value, 200);
  assert.equal(report.perVerifiedAcceptedChange.cacheReadTokens.value, 0);
});

test("one definition of the bill, not four spellings of it", () => {
  // The reason this test exists: `input + output` survived in the mode fold for months after the
  // compression fold had been corrected, because each restated the arithmetic. The folds now read
  // one function, and a caller that starts restating it again is what this assertion catches.
  const terms = { inputTokens: 140, outputTokens: 50, cacheCreationInputTokens: 10 } as const;
  assert.equal(billableTokens(terms), 200);
  assert.equal(cacheReadTokens({ ...terms, cacheReadInputTokens: 9_000 }), 9_000);
  assert.equal(totalTokens({ ...terms, cacheReadInputTokens: 9_000 }), 9_200);

  const report = aggregateSamples([
    sample({ inputTokens: 140, outputTokens: 50, cacheCreationInputTokens: 10 }),
  ]);
  assert.equal(
    report.perVerifiedAcceptedChange.billableTokens.value,
    billableTokens(terms),
    "the mode fold and the shared definition are the same number by construction",
  );
});
