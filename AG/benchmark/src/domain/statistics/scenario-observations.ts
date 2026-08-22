import {
  billableTokens,
  cacheReadTokens,
  type TokenCostTerms,
} from "../metrics/token-cost.js";
import type { BenchmarkSample } from "../result.js";
import type { DistributionStatistics } from "../verdict.js";
import { DISTRIBUTION_REFUSAL_REASONS, summarizeDistribution } from "./distribution.js";

/**
 * From samples to one comparable distribution (BENCH-9).
 *
 * This is the step between the stored records and the statistics a verdict is
 * drawn from: it decides which samples may enter the distribution, which number
 * each of them contributes, and whether there were enough of them to say
 * anything at all.
 *
 * ## What may enter the distribution
 *
 * Only conclusive samples, for the reason `metrics/aggregate.ts` states: a
 * record too incomplete to be verified is not a record its token count can be
 * trusted from. BENCH-5 forbids dropping such a sample silently, so the number
 * excluded is reported beside the distribution as `inconclusiveCount` rather
 * than left for a reader to reconstruct.
 *
 * ## What counts as enough repetitions
 *
 * BENCH-9 requires a nondeterministic scenario to be run at least
 * {@link MINIMUM_NONDETERMINISTIC_OBSERVATIONS} times. The requirement is
 * applied to the observations that survive the filter above, not to the samples
 * that were recorded: three runs of which two were unverifiable carry the
 * evidence of one, and letting the recorded count satisfy the rule would let a
 * flaky harness buy a verdict by failing more often.
 *
 * ## Why violations are counted over every sample
 *
 * `securityFailureCount` and `outOfScopeCount` deliberately count inconclusive
 * samples too, unlike everything else here. A failed security check and a write
 * outside the declared scope are things that *happened*; the verifier's
 * inability to decide the run's outcome does not un-happen them, and BENCH-9
 * makes a new one a regression regardless of what the cost metrics did. The
 * asymmetry is the point: an excluded sample may not lend a benchmark evidence
 * of success, but it may still testify against it.
 */

/** What a distribution measures. Same cost dimensions `metrics/aggregate.ts` reports, in report order. */
export const SCENARIO_MEASURE_KEYS = [
  "billableTokens",
  "cacheReadTokens",
  "durationMs",
  "llmCalls",
] as const;

export type ScenarioMeasureKey = (typeof SCENARIO_MEASURE_KEYS)[number];

/** Billable tokens, because it is the dimension that is comparable across machines — wall clock is not. */
export const DEFAULT_SCENARIO_MEASURE: ScenarioMeasureKey = "billableTokens";

/** BENCH-9's floor for a scenario whose result varies between runs. */
export const MINIMUM_NONDETERMINISTIC_OBSERVATIONS = 3;

/**
 * Why a scenario has no distribution. The distribution's own reasons are
 * forwarded unchanged so a caller sees why the numbers were refused, not only
 * that they were.
 */
export const SCENARIO_SUMMARY_REFUSAL_REASONS = [
  "insufficient-repetitions",
  ...DISTRIBUTION_REFUSAL_REASONS,
] as const;

export type ScenarioSummaryRefusalReason = (typeof SCENARIO_SUMMARY_REFUSAL_REASONS)[number];

/**
 * What the samples showed apart from their numbers. Carried on both members of
 * {@link ScenarioSummary}, because a refused distribution still has violations
 * worth reporting and counts worth showing (BENCH-5, BENCH-10).
 */
export interface ScenarioEvidence {
  /** Every sample of this `scenario × mode`, including the excluded ones. */
  readonly sampleCount: number;
  /** Samples excluded from the distribution, reported so the exclusion is visible. */
  readonly inconclusiveCount: number;
  /** Samples with a failed security check, counted over `sampleCount`. */
  readonly securityFailureCount: number;
  /** Samples that changed a file outside the scenario's allowed paths, counted over `sampleCount`. */
  readonly outOfScopeCount: number;
}

export interface MeasuredScenarioSummary extends ScenarioEvidence {
  readonly ok: true;
  readonly statistics: DistributionStatistics;
}

export interface RefusedScenarioSummary extends ScenarioEvidence {
  readonly ok: false;
  readonly reason: ScenarioSummaryRefusalReason;
  readonly detail: string;
}

export type ScenarioSummary = MeasuredScenarioSummary | RefusedScenarioSummary;

export interface ScenarioSummaryOptions {
  /** From the scenario declaration, never inferred from the samples: it decides how many repetitions are required. */
  readonly deterministic: boolean;
  readonly measure?: ScenarioMeasureKey;
}

function isConclusive(sample: BenchmarkSample): boolean {
  return sample.acceptance.verdict !== "inconclusive";
}

function isVerifiedAccepted(sample: BenchmarkSample): boolean {
  return sample.acceptance.verdict === "verified-accepted";
}

function hasSecurityFailure(sample: BenchmarkSample): boolean {
  return sample.checks.some((check) => check.kind === "security" && check.status === "failed");
}

function changedOutOfScope(sample: BenchmarkSample): boolean {
  return sample.workspace.outOfScopeFiles.length > 0;
}

function countOf(samples: readonly BenchmarkSample[], holds: (sample: BenchmarkSample) => boolean) {
  return samples.reduce((count, sample) => (holds(sample) ? count + 1 : count), 0);
}

/** The token terms of one sample, gathered from the two blocks that carry them. */
function costTermsOf(sample: BenchmarkSample): TokenCostTerms {
  return {
    inputTokens: sample.telemetry.inputTokens,
    outputTokens: sample.telemetry.outputTokens,
    ...(sample.usage === undefined
      ? {}
      : {
          cacheReadInputTokens: sample.usage.cacheReadInputTokens,
          cacheCreationInputTokens: sample.usage.cacheCreationInputTokens,
        }),
  };
}

/**
 * The number one sample contributes to the distribution. Every quantity is what the adapter
 * reported, never an estimate — and `billableTokens` is the same arithmetic
 * `metrics/aggregate.ts` folds, so a scenario's distribution and the mode rollup describe one
 * quantity rather than two that happen to share a name.
 */
function measureOf(sample: BenchmarkSample, measure: ScenarioMeasureKey): number {
  switch (measure) {
    case "billableTokens":
      return billableTokens(costTermsOf(sample));
    case "cacheReadTokens":
      return cacheReadTokens(costTermsOf(sample));
    case "durationMs":
      return sample.durationMs;
    case "llmCalls":
      return sample.telemetry.llmCalls;
  }
}

/**
 * The distribution of one `scenario × mode` group, or the reason it has none.
 *
 * Callers pass one group's samples; pairing scenarios with modes is the
 * comparison layer's job. A mixed population produces a defined result but not a
 * comparable one, exactly as with `aggregateSamples`.
 */
export function summarizeScenarioSamples(
  samples: readonly BenchmarkSample[],
  options: ScenarioSummaryOptions,
): ScenarioSummary {
  const conclusive = samples.filter(isConclusive);
  const evidence: ScenarioEvidence = {
    sampleCount: samples.length,
    inconclusiveCount: samples.length - conclusive.length,
    securityFailureCount: countOf(samples, hasSecurityFailure),
    outOfScopeCount: countOf(samples, changedOutOfScope),
  };

  if (!options.deterministic && conclusive.length < MINIMUM_NONDETERMINISTIC_OBSERVATIONS) {
    return {
      ...evidence,
      ok: false,
      reason: "insufficient-repetitions",
      detail:
        `a nondeterministic scenario needs at least ${MINIMUM_NONDETERMINISTIC_OBSERVATIONS} ` +
        `usable observation(s) and this group has ${conclusive.length} ` +
        `of ${samples.length} recorded sample(s)`,
    };
  }

  const measure = options.measure ?? DEFAULT_SCENARIO_MEASURE;
  const summary = summarizeDistribution(
    conclusive.map((sample) => measureOf(sample, measure)),
    countOf(conclusive, isVerifiedAccepted),
  );
  if (!summary.ok) {
    return { ...evidence, ok: false, reason: summary.reason, detail: summary.detail };
  }
  return { ...evidence, ok: true, statistics: summary.statistics };
}
