import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCompressionCohort,
  aggregateCompressionSamples,
  sampleBillableTokens,
  unattributedSampleCount,
  type CompressionAggregate,
} from "../domain/compression/aggregate.js";
import { COMPRESSION_COHORT, baselineVariant, variantById } from "../domain/compression/cohort.js";
import type { CompressionVariant } from "../domain/compression/variant.js";
import { validateBenchmarkSample } from "../domain/schema-validation.js";
import type { BenchmarkSample } from "../domain/result.js";
import type { MetricValue } from "../domain/metrics/metric-value.js";
import { compressionSample, compressionSamples } from "./compression-fixtures.js";
import { validSample } from "./sample-fixtures.js";

/**
 * The compression fold (task 0029).
 *
 * The property under test throughout is that a number appears only where the
 * evidence for it is complete. A population that half-reported its usage yields
 * no token total, an inconclusive sample enters no denominator, and a sample
 * belonging to another variant — or to none — never reaches this variant's
 * numbers.
 */

const BASELINE = baselineVariant();
const WORKER_TASK_IR = variantById("worker-task-ir") as CompressionVariant;

function assertUnmeasured(metric: MetricValue, reason: string, name: string): void {
  assert.equal(metric.value, undefined, `${name} reported a value`);
  assert.equal(metric.value === undefined ? metric.reason : "", reason, name);
}

/** Every metric the aggregate publishes, named, so a property can be asserted over all of them. */
function metricsOf(aggregate: CompressionAggregate): readonly (readonly [string, MetricValue])[] {
  return [
    ["billableTokensPerAcceptedTask", aggregate.billableTokensPerAcceptedTask],
    ["rawTokensPerAcceptedTask", aggregate.rawTokensPerAcceptedTask],
    ["repairsPerTask", aggregate.repairsPerTask],
    ["humanReviewEventsPerTask", aggregate.humanReviewEventsPerTask],
    ...Object.entries(aggregate.usage),
    ...Object.entries(aggregate.diagnostics),
  ];
}

test("every fixture this suite folds is a record the store would accept", () => {
  const samples = [
    compressionSample({ variant: BASELINE, tokens: 10 }),
    compressionSample({ variant: WORKER_TASK_IR, tokens: 10, captured: false }),
    compressionSample({ variant: WORKER_TASK_IR, withoutUsage: true, tokens: 10 }),
    compressionSample({ variant: WORKER_TASK_IR, verdict: "inconclusive" }),
    compressionSample({ variant: WORKER_TASK_IR, verdict: "rejected", outOfScope: true }),
    compressionSample({ variant: WORKER_TASK_IR, repairs: 2, humanReviewEvents: 1 }),
    compressionSample({
      variant: WORKER_TASK_IR,
      securityCheck: "failed",
      diagnostics: { rawTaskChars: 10, compiledTaskChars: 4 },
    }),
  ];
  for (const sample of samples) {
    const result = validateBenchmarkSample(JSON.parse(JSON.stringify(sample)) as unknown);
    assert.ok(result.ok, `${sample.sampleId}: ${JSON.stringify(result.ok ? [] : result.problems)}`);
  }
});

test("an empty population measures nothing and says so with no-samples", () => {
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, []);

  assert.equal(aggregate.quality.sampleCount, 0);
  assert.equal(aggregate.capturedUsageCount, 0);
  for (const [name, metric] of metricsOf(aggregate)) {
    assertUnmeasured(metric, "no-samples", name);
  }
});

test("samples of another variant, and samples of none, enter no aggregate", () => {
  const foreign = [
    compressionSample({ variant: BASELINE, tokens: 1_000 }),
    validSample({ sampleId: "unattributed-0001" }),
  ];
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, foreign);

  assert.equal(aggregate.quality.sampleCount, 0);
  assertUnmeasured(aggregate.billableTokensPerAcceptedTask, "no-samples", "billableTokensPerAcceptedTask");
  assert.equal(unattributedSampleCount(COMPRESSION_COHORT, foreign), 1);
});

test("an inconclusive sample enters no numerator and no denominator", () => {
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({ variant: WORKER_TASK_IR, tokens: 100, numTurns: 4 }),
    compressionSample({ variant: WORKER_TASK_IR, verdict: "inconclusive", tokens: 900 }),
  ]);

  assert.equal(aggregate.quality.sampleCount, 2);
  assert.equal(aggregate.quality.conclusiveCount, 1);
  assert.equal(aggregate.quality.inconclusiveCount, 1);
  assert.equal(
    aggregate.billableTokensPerAcceptedTask.value,
    100,
    "an unverifiable record is not a record its token count can be trusted from",
  );
});

test("partial usage capture refuses the token total rather than summing what was reported", () => {
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({ variant: WORKER_TASK_IR, tokens: 100 }),
    compressionSample({ variant: WORKER_TASK_IR, tokens: 900, captured: false }),
  ]);

  assert.equal(aggregate.capturedUsageCount, 1);
  assertUnmeasured(aggregate.billableTokensPerAcceptedTask, "no-captured-usage", "billableTokensPerAcceptedTask");
  assertUnmeasured(aggregate.rawTokensPerAcceptedTask, "no-captured-usage", "rawTokensPerAcceptedTask");
  assertUnmeasured(aggregate.usage.totalTokens, "no-captured-usage", "usage.totalTokens");
  assertUnmeasured(aggregate.usage.billableTokens, "no-captured-usage", "usage.billableTokens");
  assertUnmeasured(aggregate.usage.nonCachedTokens, "no-captured-usage", "usage.nonCachedTokens");
  assert.match(
    aggregate.billableTokensPerAcceptedTask.value === undefined
      ? aggregate.billableTokensPerAcceptedTask.detail
      : "",
    /1 of the 2 conclusive sample\(s\)/,
    "the refusal states the counts it rests on",
  );
});

test("a sample that reports no usage at all is not a captured one", () => {
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({ variant: WORKER_TASK_IR, tokens: 100, withoutUsage: true }),
  ]);

  assert.equal(aggregate.capturedUsageCount, 0);
  assertUnmeasured(aggregate.billableTokensPerAcceptedTask, "no-captured-usage", "billableTokensPerAcceptedTask");
});

test("the raw total counts the cache read and the billable total does not", () => {
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({
      variant: WORKER_TASK_IR,
      tokens: 100,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 50,
    }),
  ]);

  assert.equal(aggregate.usage.totalTokens.value, 550, "the raw stream: 100 + 400 + 50");
  assert.equal(
    aggregate.usage.billableTokens.value,
    150,
    "what the bill is computed from: 100 + 50, the cache read excluded",
  );
  assert.equal(aggregate.usage.nonCachedTokens.value, 100, "reported beside it, deciding nothing");
  assert.equal(aggregate.usage.cacheReadTokens.value, 400);
  assert.equal(aggregate.usage.cacheCreationTokens.value, 50);
  assert.equal(aggregate.rawTokensPerAcceptedTask.value, 550);
  assert.equal(
    aggregate.billableTokensPerAcceptedTask.value,
    150,
    "the primary KPI follows the invoice, not the context window",
  );
});

test("every one of the four telemetry components stays visible in the report totals", () => {
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({
      variant: WORKER_TASK_IR,
      tokens: 700,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 40,
    }),
  ]);

  // Demoting the raw stream to a safety bound must not quietly delete the
  // counters a reader needs to see where the tokens went.
  assert.equal(aggregate.usage.totalTokens.value, 1_040);
  assert.equal(aggregate.usage.billableTokens.value, 740);
  assert.equal(aggregate.usage.nonCachedTokens.value, 700);
  assert.equal(aggregate.usage.cacheReadTokens.value, 300);
  assert.equal(aggregate.usage.cacheCreationTokens.value, 40);
});

test("the KPI divides by the tasks a verifier accepted, not by the runs it took", () => {
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({ variant: WORKER_TASK_IR, tokens: 100 }),
    compressionSample({ variant: WORKER_TASK_IR, tokens: 100, verdict: "rejected" }),
    compressionSample({ variant: WORKER_TASK_IR, tokens: 100, verdict: "rejected" }),
  ]);

  assert.equal(
    aggregate.billableTokensPerAcceptedTask.value,
    300,
    "one usable change cost every run it took to get there",
  );
});

test("a population that accepted nothing has no accepted task to divide by", () => {
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({ variant: WORKER_TASK_IR, tokens: 100, verdict: "rejected" }),
  ]);
  assertUnmeasured(
    aggregate.billableTokensPerAcceptedTask,
    "no-verified-accepted-change",
    "billableTokensPerAcceptedTask",
  );
});

test("repairs and human reviews are counted per conclusive task", () => {
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({ variant: WORKER_TASK_IR, repairs: 3, humanReviewEvents: 1 }),
    compressionSample({ variant: WORKER_TASK_IR, repairs: 1, humanReviewEvents: 0 }),
    compressionSample({ variant: WORKER_TASK_IR, verdict: "inconclusive", repairs: 9 }),
  ]);

  assert.equal(aggregate.repairsPerTask.value, 2, "(3 + 1) / 2 conclusive samples");
  assert.equal(aggregate.humanReviewEventsPerTask.value, 0.5);
  assert.equal(
    aggregate.quality.repairRate.value,
    1,
    "the share that needed any repair is a different number, and both are reported",
  );
});

test("turns are averaged only when every conclusive sample reports one", () => {
  const complete = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({ variant: WORKER_TASK_IR, numTurns: 10 }),
    compressionSample({ variant: WORKER_TASK_IR, numTurns: 20 }),
  ]);
  assert.equal(complete.usage.turnsPerTask.value, 15);

  const partial = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({ variant: WORKER_TASK_IR, numTurns: 10 }),
    compressionSample({ variant: WORKER_TASK_IR }),
  ]);
  assertUnmeasured(partial.usage.turnsPerTask, "no-applicable-samples", "usage.turnsPerTask");
});

test("a character counter is averaged only over a population that all reported it", () => {
  const complete = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({ variant: WORKER_TASK_IR, diagnostics: { rawTaskChars: 100 } }),
    compressionSample({ variant: WORKER_TASK_IR, diagnostics: { rawTaskChars: 300 } }),
  ]);
  assert.equal(complete.diagnostics.rawTaskChars.value, 200);
  assertUnmeasured(
    complete.diagnostics.toolDigestChars,
    "no-applicable-samples",
    "diagnostics.toolDigestChars",
  );

  const partial = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({ variant: WORKER_TASK_IR, diagnostics: { rawTaskChars: 100 } }),
    compressionSample({ variant: WORKER_TASK_IR }),
  ]);
  assertUnmeasured(
    partial.diagnostics.rawTaskChars,
    "no-applicable-samples",
    "diagnostics.rawTaskChars",
  );
});

test("a diagnostic that was never captured cannot rescue a refused token total", () => {
  const aggregate = aggregateCompressionSamples(WORKER_TASK_IR, [
    compressionSample({
      variant: WORKER_TASK_IR,
      tokens: 100,
      captured: false,
      diagnostics: { rawTaskChars: 10, compiledTaskChars: 1 },
    }),
  ]);

  assertUnmeasured(aggregate.billableTokensPerAcceptedTask, "no-captured-usage", "billableTokensPerAcceptedTask");
  assert.equal(
    aggregate.diagnostics.rawTaskChars.value,
    10,
    "chars are still reported; they are simply not tokens",
  );
});

test("the fold does not depend on the order samples arrived in", () => {
  const samples: readonly BenchmarkSample[] = [
    compressionSample({ variant: WORKER_TASK_IR, tokens: 100, numTurns: 3 }),
    compressionSample({ variant: WORKER_TASK_IR, tokens: 300, numTurns: 9, verdict: "rejected" }),
    compressionSample({ variant: BASELINE, tokens: 700 }),
    compressionSample({ variant: WORKER_TASK_IR, verdict: "inconclusive" }),
  ];
  const forwards = aggregateCompressionSamples(WORKER_TASK_IR, samples);
  const backwards = aggregateCompressionSamples(WORKER_TASK_IR, [...samples].reverse());

  assert.deepEqual(forwards, backwards);
});

test("the cohort fold produces one aggregate per declared variant, in declaration order", () => {
  const aggregates = aggregateCompressionCohort(COMPRESSION_COHORT, [
    compressionSample({ variant: WORKER_TASK_IR, tokens: 100 }),
  ]);

  assert.deepEqual(
    aggregates.map((aggregate) => aggregate.variant.id),
    COMPRESSION_COHORT.map((variant) => variant.id),
  );
  assert.equal(aggregates[1]?.quality.sampleCount, 1);
  assert.equal(aggregates[0]?.quality.sampleCount, 0, "the baseline absorbs nothing it did not run");
});

test("a variant with several repetitions folds them into one population", () => {
  const aggregate = aggregateCompressionSamples(
    WORKER_TASK_IR,
    compressionSamples(3, { variant: WORKER_TASK_IR, tokens: 100 }),
  );
  assert.equal(aggregate.quality.sampleCount, 3);
  assert.equal(aggregate.billableTokensPerAcceptedTask.value, 100, "300 tokens over 3 accepted tasks");
});

// The formula is restated in this package rather than imported: BENCH-1 forbids reaching into
// orchestrator internals. Neither side can see the other, so neither test proves agreement by
// itself — what the pair guarantees is that neither side drifts SILENTLY, and each failing test
// names its counterpart so whoever changes one is told where the other lives.
//
// Counterpart: `src/tests/analytics-cohorts.test.ts`,
// "summarizeUsageByTask: billable be cache_read, turnsMeasured ir repair formos" — same numbers.
test("the restated formula matches the orchestrator: 140 input + 50 output + 10 cache creation = 200", () => {
  const sample = validSample({
    telemetry: {
      model: "claude-opus-5",
      inputTokens: 140,
      outputTokens: 50,
      llmCalls: 1,
      attempts: 1,
      repairs: 0,
      humanReviewEvents: 0,
    },
    usage: { captured: true, source: "envelope", cacheCreationInputTokens: 10, cacheReadInputTokens: 9_999 },
  });

  assert.equal(sampleBillableTokens(sample), 200);
});
