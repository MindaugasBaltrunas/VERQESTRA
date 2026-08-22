import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPRESSION_COST_KPI_VERSION,
  aggregateCompressionCohort,
  aggregateCompressionSamples,
  type CompressionAggregate,
} from "../domain/compression/aggregate.js";
import { COMPRESSION_COHORT, baselineVariant, variantById } from "../domain/compression/cohort.js";
import {
  COMPRESSION_VERDICTS,
  judgeCompressionCohort,
  judgeCompressionVariant,
} from "../domain/compression/compression-verdict.js";
import type { CompressionVariant } from "../domain/compression/variant.js";
import {
  COST_MATERIAL_RELATIVE_DELTA,
  RAW_TOKENS_SAFETY_RELATIVE_DELTA,
  SUCCESS_RATE_MATERIAL_DELTA,
} from "../domain/comparison/thresholds.js";
import { IDENTIFIER_PATTERN } from "../domain/validation.js";
import { compressionSample, type CompressionSampleInput } from "./compression-fixtures.js";

/**
 * The rollout decision (task 0029).
 *
 * `accepted` means one thing and has to keep meaning it: this variant spent
 * materially fewer tokens per verified-accepted task, and made nothing worse.
 * Every test here pushes on one of the ways that claim could be weakened —
 * incomplete evidence, a regression somewhere else, a saving inside the noise
 * floor, or a character count standing in for a token count.
 */

const BASELINE = baselineVariant();
const VARIANT = variantById("worker-task-ir") as CompressionVariant;

/**
 * A population of `count` accepted samples, each costing `tokens`.
 *
 * A decided security check is present by default, because without one the
 * security predicate is unmeasured and *every* verdict is `not_measured` — which
 * is the correct fail-closed behaviour and would make every other case here
 * untestable. The tests that are about a missing predicate state that themselves.
 */
function population(
  variant: CompressionVariant,
  count: number,
  tokens: number,
  overrides: Partial<CompressionSampleInput> = {},
): CompressionAggregate {
  return aggregateCompressionSamples(
    variant,
    Array.from({ length: count }, () =>
      compressionSample({ variant, tokens, securityCheck: "passed", ...overrides }),
    ),
  );
}

/** A population whose accepted share is `accepted / count`, with a fixed cost per run. */
function mixedPopulation(
  variant: CompressionVariant,
  count: number,
  accepted: number,
  tokens: number,
  overrides: Partial<CompressionSampleInput> = {},
): CompressionAggregate {
  return aggregateCompressionSamples(
    variant,
    Array.from({ length: count }, (_unused, index) =>
      compressionSample({
        variant,
        tokens,
        securityCheck: "passed",
        verdict: index < accepted ? "verified-accepted" : "rejected",
        ...overrides,
      }),
    ),
  );
}

test("a variant that is materially cheaper and regressed nothing is accepted", () => {
  const verdict = judgeCompressionVariant(
    population(BASELINE, 4, 1_000),
    population(VARIANT, 4, 700),
  );

  assert.equal(verdict.verdict, "accepted");
  assert.ok(verdict.reasons.includes("billable-tokens-per-accepted-task-lower"));
  assert.ok(verdict.reasons.includes("quality-non-regressed"));
  assert.equal(verdict.variantId, VARIANT.id);
  assert.equal(verdict.variantIdentity, VARIANT.identity);
  assert.equal(verdict.evidence.baselineBillableTokensPerAcceptedTask, 1_000);
  assert.equal(verdict.evidence.variantBillableTokensPerAcceptedTask, 700);
  assert.equal(verdict.evidence.billableTokensPerAcceptedTaskDelta, -300);
  assert.equal(verdict.evidence.costKpiVersion, COMPRESSION_COST_KPI_VERSION);
  assert.equal(verdict.evidence.rawTokensSafetyRelativeDelta, RAW_TOKENS_SAFETY_RELATIVE_DELTA);
});

test("the cost KPI version and the safety bound are the values this change declared", () => {
  // Pinned to literals, not to the imported constants: comparing a published
  // value against the constant it was published from is a tautology, and both
  // numbers are policy. Reverting COMPRESSION_COST_KPI_VERSION to 1 would make
  // reports from two different objectives look mutually comparable again, and
  // moving the safety bound changes which variants past runs would have blocked.
  // Either change is legitimate; making it silently is not.
  assert.equal(COMPRESSION_COST_KPI_VERSION, 2, "version 1 was the raw-total objective");
  assert.equal(RAW_TOKENS_SAFETY_RELATIVE_DELTA, 0.5);
  assert.equal(COST_MATERIAL_RELATIVE_DELTA, 0.1);
  assert.ok(
    RAW_TOKENS_SAFETY_RELATIVE_DELTA > COST_MATERIAL_RELATIVE_DELTA,
    "the safety bound is looser than the cost threshold on purpose: every shift into a cached " +
      "prefix inflates the raw stream, so a bound near the noise floor would reject the variants " +
      "judging on billable tokens exists to admit",
  );
});

test("a saving inside the declared noise floor is not a saving", () => {
  const justInside = 1_000 * (1 - COST_MATERIAL_RELATIVE_DELTA) + 1;
  const verdict = judgeCompressionVariant(
    population(BASELINE, 4, 1_000),
    population(VARIANT, 4, justInside),
  );

  assert.equal(verdict.verdict, "rejected");
  assert.ok(verdict.reasons.includes("billable-tokens-per-accepted-task-not-lower"));
});

test("a variant that costs the same is rejected rather than reported as harmless", () => {
  const verdict = judgeCompressionVariant(
    population(BASELINE, 4, 1_000),
    population(VARIANT, 4, 1_000),
  );
  assert.equal(verdict.verdict, "rejected");
  assert.ok(verdict.reasons.includes("billable-tokens-per-accepted-task-not-lower"));
});

/**
 * A cache read large enough that the raw stream grows while the bill falls, and
 * small enough to stay inside the safety bound.
 *
 * Used by the quality-predicate tests so each of them asserts what its name
 * claims: that a *billable* saving does not buy back a regression. Built on the
 * raw total instead, the same fixtures would pass unchanged if the verdict
 * regressed to the pre-0040 objective, and would prove nothing about this KPI.
 */
const CACHE_SHIFT_READ_TOKENS = 1_200;

test("a new security failure rejects the variant however much it saved", () => {
  const cheaper = { tokens: 100, cacheReadInputTokens: CACHE_SHIFT_READ_TOKENS } as const;
  const verdict = judgeCompressionVariant(
    population(BASELINE, 4, 1_000, { securityCheck: "passed" }),
    aggregateCompressionSamples(VARIANT, [
      compressionSample({ variant: VARIANT, ...cheaper, securityCheck: "passed" }),
      compressionSample({ variant: VARIANT, ...cheaper, securityCheck: "passed" }),
      compressionSample({ variant: VARIANT, ...cheaper, securityCheck: "passed" }),
      compressionSample({ variant: VARIANT, ...cheaper, securityCheck: "failed" }),
    ]),
  );

  assert.equal(verdict.verdict, "rejected");
  assert.ok(verdict.reasons.includes("security-failure-rate-regressed"));
  assert.equal(verdict.evidence.variantBillableTokensPerAcceptedTask, 100);
  assert.equal(verdict.evidence.variantRawTokensPerAcceptedTask, 1_300);
  assert.ok(
    verdict.reasons.includes("billable-tokens-per-accepted-task-lower"),
    "the bill really did fall",
  );
  assert.ok(
    !verdict.reasons.includes("raw-tokens-per-accepted-task-safety-exceeded"),
    "and the raw growth was inside the bound, so security is the only thing rejecting it",
  );
});

test("a forbidden edit of any size rejects the variant", () => {
  const cheaper = { tokens: 100, cacheReadInputTokens: CACHE_SHIFT_READ_TOKENS } as const;
  const verdict = judgeCompressionVariant(
    population(BASELINE, 4, 1_000),
    aggregateCompressionSamples(VARIANT, [
      compressionSample({ variant: VARIANT, ...cheaper }),
      compressionSample({ variant: VARIANT, ...cheaper }),
      compressionSample({ variant: VARIANT, ...cheaper }),
      compressionSample({ variant: VARIANT, ...cheaper, outOfScope: true }),
    ]),
  );

  assert.equal(verdict.verdict, "rejected");
  assert.ok(verdict.reasons.includes("out-of-scope-rate-regressed"));
  assert.ok(verdict.reasons.includes("billable-tokens-per-accepted-task-lower"));
  assert.ok(!verdict.reasons.includes("raw-tokens-per-accepted-task-safety-exceeded"));
});

test("an accepted-rate drop inside the noise floor is not a regression, and beyond it is", () => {
  const baseline = mixedPopulation(BASELINE, 10, 10, 1_000);
  const withinNoise = mixedPopulation(VARIANT, 10, 10 - Math.round(SUCCESS_RATE_MATERIAL_DELTA * 10), 100);
  const beyondNoise = mixedPopulation(VARIANT, 10, 5, 100);

  assert.equal(judgeCompressionVariant(baseline, withinNoise).verdict, "accepted");
  const regressed = judgeCompressionVariant(baseline, beyondNoise);
  assert.equal(regressed.verdict, "rejected");
  assert.ok(regressed.reasons.includes("accepted-rate-regressed"));
});

test("a population nobody ran is not measured, never accepted and never zero", () => {
  const verdict = judgeCompressionVariant(
    aggregateCompressionSamples(BASELINE, []),
    aggregateCompressionSamples(VARIANT, []),
  );

  assert.equal(verdict.verdict, "not_measured");
  assert.deepEqual(
    verdict.reasons.filter((reason) => reason.endsWith("-not-conclusive")),
    ["baseline-not-conclusive", "variant-not-conclusive"],
  );
  assert.equal(verdict.evidence.variantBillableTokensPerAcceptedTask, undefined);
  assert.equal(verdict.evidence.billableTokensPerAcceptedTaskDelta, undefined);
  assert.equal(verdict.evidence.variantRawTokensPerAcceptedTask, undefined);
  assert.equal(verdict.evidence.rawTokensPerAcceptedTaskDelta, undefined);
});

test("usage nobody captured is not measured, and the verdict says which gap it was", () => {
  const verdict = judgeCompressionVariant(
    population(BASELINE, 2, 1_000),
    population(VARIANT, 2, 100, { captured: false }),
  );

  assert.equal(verdict.verdict, "not_measured");
  assert.ok(verdict.reasons.includes("billable-tokens-per-accepted-task-not-measured"));
  assert.ok(
    verdict.reasons.includes("raw-tokens-per-accepted-task-not-measured"),
    "the safety bound is unmeasured too, and a gap in it is stated rather than passed",
  );
  assert.ok(verdict.reasons.includes("usage-no-captured-usage"));
});

// ---------------------------------------------------------------------------
// The billable objective and the raw safety bound (task 0040)
// ---------------------------------------------------------------------------

test("a variant that shifts tokens into the cache is judged on the bill, not the raw stream", () => {
  // The proposal's case: input falls, cache reads rise by more, so the raw total
  // grows while the invoice shrinks. Before task 0040 this was rejected for
  // getting cheaper.
  const verdict = judgeCompressionVariant(
    population(BASELINE, 4, 1_000),
    population(VARIANT, 4, 800, { cacheReadInputTokens: 300 }),
  );

  assert.equal(verdict.evidence.baselineBillableTokensPerAcceptedTask, 1_000);
  assert.equal(verdict.evidence.variantBillableTokensPerAcceptedTask, 800);
  assert.equal(verdict.evidence.baselineRawTokensPerAcceptedTask, 1_000);
  assert.equal(
    verdict.evidence.variantRawTokensPerAcceptedTask,
    1_100,
    "the raw stream really did grow",
  );
  assert.equal(verdict.verdict, "accepted");
  assert.ok(verdict.reasons.includes("billable-tokens-per-accepted-task-lower"));
  assert.ok(!verdict.reasons.includes("raw-tokens-per-accepted-task-safety-exceeded"));
});

test("raw growth past the safety bound rejects the variant however much the bill fell", () => {
  const baseline = population(BASELINE, 4, 1_000);
  const overBound = judgeCompressionVariant(
    baseline,
    population(VARIANT, 4, 800, { cacheReadInputTokens: 800 }),
  );

  assert.equal(overBound.evidence.variantBillableTokensPerAcceptedTask, 800);
  assert.equal(overBound.evidence.variantRawTokensPerAcceptedTask, 1_600);
  assert.equal(overBound.evidence.rawTokensPerAcceptedTaskRelativeDelta, 0.6);
  assert.equal(overBound.verdict, "rejected");
  assert.ok(overBound.reasons.includes("raw-tokens-per-accepted-task-safety-exceeded"));
  assert.ok(
    overBound.reasons.includes("billable-tokens-per-accepted-task-lower"),
    "it really was cheaper, and that did not save it",
  );
});

test("the safety bound fires above the declared threshold, not at it", () => {
  const baseline = population(BASELINE, 4, 1_000);
  const atBound = 1_000 * (1 + RAW_TOKENS_SAFETY_RELATIVE_DELTA);
  const justOver = judgeCompressionVariant(
    baseline,
    population(VARIANT, 4, 800, { cacheReadInputTokens: atBound - 800 + 1 }),
  );
  const exactly = judgeCompressionVariant(
    baseline,
    population(VARIANT, 4, 800, { cacheReadInputTokens: atBound - 800 }),
  );

  assert.equal(exactly.evidence.variantRawTokensPerAcceptedTask, atBound);
  assert.equal(exactly.verdict, "accepted", "growth exactly at the bound is within it");
  assert.equal(justOver.verdict, "rejected");
  assert.ok(justOver.reasons.includes("raw-tokens-per-accepted-task-safety-exceeded"));
});

test("an accepted-rate regression rejects a variant whose bill fell", () => {
  // Cache-shifted, so the rejection cannot be read as the old raw objective
  // firing: on raw tokens this variant is *worse*, on billable it is far cheaper,
  // and it is rejected on neither.
  const verdict = judgeCompressionVariant(
    mixedPopulation(BASELINE, 10, 10, 1_000),
    mixedPopulation(VARIANT, 10, 5, 100, { cacheReadInputTokens: 500 }),
  );

  assert.equal(verdict.evidence.variantBillableTokensPerAcceptedTask, 200);
  assert.equal(verdict.evidence.variantRawTokensPerAcceptedTask, 1_200);
  assert.equal(verdict.verdict, "rejected");
  assert.ok(verdict.reasons.includes("accepted-rate-regressed"));
  assert.ok(
    verdict.reasons.includes("billable-tokens-per-accepted-task-lower"),
    "a token saving does not buy back a quality regression",
  );
  assert.ok(!verdict.reasons.includes("raw-tokens-per-accepted-task-safety-exceeded"));
});

test("the proposal's own case — raw −100k on the prompt, +300k on the cache — is accepted", () => {
  // The numbers the change was argued from, run through the gate that used to
  // reject them: 100k moved off the prompt, 200k more read back out of the
  // cache. The bill falls a quarter, the raw stream grows a quarter, and the
  // margin against the safety bound is the thing worth watching — a future
  // tightening of RAW_TOKENS_SAFETY_RELATIVE_DELTA would start rejecting the
  // very case this task exists to admit, and this test is where that shows up.
  const verdict = judgeCompressionVariant(
    population(BASELINE, 4, 400_000),
    population(VARIANT, 4, 300_000, { cacheReadInputTokens: 200_000 }),
  );

  assert.equal(verdict.evidence.baselineBillableTokensPerAcceptedTask, 400_000);
  assert.equal(verdict.evidence.variantBillableTokensPerAcceptedTask, 300_000);
  assert.equal(verdict.evidence.baselineRawTokensPerAcceptedTask, 400_000);
  assert.equal(verdict.evidence.variantRawTokensPerAcceptedTask, 500_000);
  assert.equal(verdict.evidence.rawTokensPerAcceptedTaskRelativeDelta, 0.25);
  assert.equal(verdict.verdict, "accepted");
  assert.ok(verdict.reasons.includes("billable-tokens-per-accepted-task-lower"));
  assert.ok(!verdict.reasons.includes("raw-tokens-per-accepted-task-safety-exceeded"));
});

test("a price nobody gated on cannot move a verdict", () => {
  const baseline = population(BASELINE, 4, 1_000);
  const variant = population(VARIANT, 4, 700);
  const priced = judgeCompressionVariant(baseline, variant, { baseline: 12.5, variant: 8.25 });
  const unpriced = judgeCompressionVariant(baseline, variant);

  assert.deepEqual(priced.evidence.actualCostUsdPerVerifiedAcceptedTask, {
    baseline: 12.5,
    variant: 8.25,
  });
  assert.equal(unpriced.evidence.actualCostUsdPerVerifiedAcceptedTask, undefined);
  assert.equal(priced.verdict, unpriced.verdict);
  assert.deepEqual(priced.reasons, unpriced.reasons);
});

test("evidence of harm outranks evidence that is merely incomplete", () => {
  const verdict = judgeCompressionVariant(
    population(BASELINE, 4, 1_000, { securityCheck: "passed" }),
    aggregateCompressionSamples(VARIANT, [
      compressionSample({ variant: VARIANT, securityCheck: "failed", captured: false }),
      compressionSample({ variant: VARIANT, securityCheck: "passed", captured: false }),
    ]),
  );

  assert.equal(verdict.verdict, "rejected", "a measured regression is not softened by a missing total");
  assert.ok(verdict.reasons.includes("security-failure-rate-regressed"));
  assert.ok(verdict.reasons.includes("billable-tokens-per-accepted-task-not-measured"));
});

test("character counters cannot move a verdict", () => {
  const baseline = population(BASELINE, 3, 1_000, {
    diagnostics: { rawTaskChars: 10_000, compiledTaskChars: 9_000, toolRawChars: 4_000 },
  });
  const spartan = population(VARIANT, 3, 1_000, {
    diagnostics: { rawTaskChars: 10_000, compiledTaskChars: 40, toolRawChars: 12 },
  });
  const verbose = population(VARIANT, 3, 1_000, {
    diagnostics: { rawTaskChars: 10_000, compiledTaskChars: 99_000, toolRawChars: 88_000 },
  });

  const compressed = judgeCompressionVariant(baseline, spartan);
  assert.notDeepEqual(
    spartan.diagnostics.compiledTaskChars,
    verbose.diagnostics.compiledTaskChars,
    "the two populations really do differ in their diagnostics",
  );
  assert.deepEqual(
    compressed,
    judgeCompressionVariant(baseline, verbose),
    "a prompt shrunk to a fortieth of its size is not evidence that anything got cheaper",
  );
  assert.equal(compressed.verdict, "rejected");
});

test("a variant judged against itself measures nothing", () => {
  const baseline = population(BASELINE, 3, 1_000);
  const verdict = judgeCompressionVariant(baseline, baseline);

  assert.equal(verdict.verdict, "not_measured");
  assert.deepEqual(verdict.reasons, ["variant-is-baseline"]);
});

test("reasons are kebab-case codes, deduplicated and in a fixed order", () => {
  const verdicts = [
    judgeCompressionVariant(population(BASELINE, 2, 1_000), population(VARIANT, 2, 100)),
    judgeCompressionVariant(
      aggregateCompressionSamples(BASELINE, []),
      aggregateCompressionSamples(VARIANT, []),
    ),
  ];
  for (const verdict of verdicts) {
    for (const reason of verdict.reasons) assert.match(reason, IDENTIFIER_PATTERN);
    assert.equal(new Set(verdict.reasons).size, verdict.reasons.length);
    assert.deepEqual(verdict.reasons, [...verdict.reasons].sort());
    assert.ok((COMPRESSION_VERDICTS as readonly string[]).includes(verdict.verdict));
  }
});

test("the same evidence always produces the same verdict", () => {
  const baseline = population(BASELINE, 3, 1_000);
  const variant = population(VARIANT, 3, 500);
  assert.deepEqual(
    judgeCompressionVariant(baseline, variant),
    judgeCompressionVariant(baseline, variant),
  );
});

test("the cohort is judged in declaration order, and the baseline is not judged against itself", () => {
  const samples = [
    ...Array.from({ length: 3 }, () =>
      compressionSample({ variant: BASELINE, tokens: 1_000, securityCheck: "passed" }),
    ),
    ...Array.from({ length: 3 }, () =>
      compressionSample({ variant: VARIANT, tokens: 400, securityCheck: "passed" }),
    ),
  ];
  const verdicts = judgeCompressionCohort(aggregateCompressionCohort(COMPRESSION_COHORT, samples));

  assert.deepEqual(
    verdicts.map((verdict) => verdict.variantId),
    COMPRESSION_COHORT.filter((entry) => entry.id !== BASELINE.id).map((entry) => entry.id),
  );
  assert.equal(verdicts.find((verdict) => verdict.variantId === VARIANT.id)?.verdict, "accepted");
  for (const verdict of verdicts.filter((entry) => entry.variantId !== VARIANT.id)) {
    assert.equal(
      verdict.verdict,
      "not_measured",
      `${verdict.variantId} was judged without having been run`,
    );
  }
});
