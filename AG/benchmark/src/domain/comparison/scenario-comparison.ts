import type { BenchmarkSample, ExecutionMode } from "../result.js";
import {
  summarizeScenarioSamples,
  type MeasuredScenarioSummary,
  type RefusedScenarioSummary,
  type ScenarioEvidence,
  type ScenarioMeasureKey,
  type ScenarioSummaryRefusalReason,
} from "../statistics/scenario-observations.js";
import type { ComparisonVerdict, ScenarioComparison } from "../verdict.js";
import { COST_MATERIAL_RELATIVE_DELTA, SUCCESS_RATE_MATERIAL_DELTA } from "./thresholds.js";
import { strongestVerdict } from "./verdict-priority.js";

/**
 * One scenario's verdict (BENCH-9).
 *
 * Compares the baseline and the current distribution of a single
 * `scenario × mode` and states which of `improved | stable | regressed |
 * inconclusive` the evidence supports.
 *
 * ## The priority chain
 *
 * The rules are evaluated in a fixed order:
 *
 * 1. a security failure the baseline did not have — a regression;
 * 2. an out-of-scope change the baseline did not have — a regression;
 * 3. a material move in the share of verified-accepted runs;
 * 4. a material move in the median cost;
 * 5. nothing material moved — stable.
 *
 * The order is the spec's, not a convenience: BENCH-9 makes a new security or
 * out-of-scope violation a regression *regardless of how the cost metrics
 * moved*, so an agent that learned to write outside its scope cannot buy a
 * `stable` verdict by also becoming cheaper. Correctness outranks cost for the
 * same reason: a run that stops passing is not an improvement however few tokens
 * it spent not passing.
 *
 * Which finding *decides* is then the shared `verdict-priority.ts` ranking, not
 * the rule order, so the two are not two chains that can drift apart. Rule order
 * only breaks ties. It has to be that way: a scenario that improved its success
 * rate and produced a cost change nothing could be divided by has both an
 * `improved` and an `inconclusive` finding, and publishing the first because it
 * was tested first would drop exactly the evidence the fail-closed rule exists
 * to keep — a real path, since the `deterministic-control` mode is expected to
 * baseline at zero tokens.
 *
 * Every rule that fires contributes its reason code, not only the deciding one.
 * A comparison that both regressed on scope and got cheaper says both things; a
 * reader who only saw the verdict would ask the second question anyway.
 *
 * ## Reason codes carry no numbers
 *
 * The codes are bare kebab-case identifiers so a report can group on them, the
 * same convention `application/baseline/comparability-gate.ts` follows. A code
 * with a delta spliced into it is a code no two comparisons ever share. The
 * numbers live in the statistics on the comparison, which is where a report
 * reads them from.
 */

/** Every reason code a scenario comparison can produce, in priority order. */
export const SCENARIO_COMPARISON_REASONS = [
  "new-security-failure",
  "new-out-of-scope-change",
  "success-rate-dropped",
  "success-rate-improved",
  "cost-change-undefined",
  "cost-increased",
  "cost-decreased",
  "within-thresholds",
] as const;

export type ScenarioComparisonReason = (typeof SCENARIO_COMPARISON_REASONS)[number];

export interface ScenarioComparisonInput {
  readonly scenarioId: string;
  readonly mode: ExecutionMode;
  /** From the scenario declaration; decides how many repetitions each side must carry. */
  readonly deterministic: boolean;
  readonly baselineSamples: readonly BenchmarkSample[];
  readonly currentSamples: readonly BenchmarkSample[];
  readonly measure: ScenarioMeasureKey;
}

/**
 * What the two sides showed apart from their statistics.
 *
 * Travels beside the comparison because {@link ScenarioComparison} is a fixed
 * contract that holds only the distributions, and these counts still have to
 * reach a report: a pair whose samples were mostly inconclusive, or one carrying
 * a violation that was already there in the baseline, must not be published as a
 * quiet `stable` with nothing said (BENCH-5, BENCH-10). The caller turns them
 * into limitations; they change no verdict, because a standing violation is not
 * one this comparison introduced.
 */
export interface ScenarioComparisonEvidence {
  readonly baseline: ScenarioEvidence;
  readonly current: ScenarioEvidence;
}

/**
 * A comparison, or the side that could not produce one.
 *
 * A refusal is not an error: {@link ScenarioComparison} requires statistics from
 * both sides, so a pair missing one is reported to the caller, which turns it
 * into a limitation and an `inconclusive` rollup rather than into an exception.
 * `side` names the half that refused so a caller does not have to parse prose to
 * find out; when both halves refused, `side` is the baseline — a baseline that
 * cannot be summarised makes the current run's numbers unjudgeable whatever else
 * is wrong — while `detail` carries both diagnoses, so the reader does not lose
 * half the problem to the choice of which half to name.
 */
export type ScenarioComparisonOutcome =
  | {
      readonly ok: true;
      readonly comparison: ScenarioComparison;
      readonly evidence: ScenarioComparisonEvidence;
    }
  | {
      readonly ok: false;
      readonly side: "baseline" | "current";
      readonly reason: ScenarioSummaryRefusalReason;
      readonly detail: string;
    };

interface Finding {
  readonly code: ScenarioComparisonReason;
  readonly verdict: ComparisonVerdict;
}

/** A new violation: present now, absent in the baseline. Present in both is a standing problem, not a regression this comparison introduced. */
function isNewViolation(baselineCount: number, currentCount: number): boolean {
  return currentCount > 0 && baselineCount === 0;
}

/**
 * The evidence half of a summary, projected field by field rather than passed
 * through: a summary is assignable to {@link ScenarioEvidence} but carries the
 * statistics too, and a report serialising it would publish the distribution
 * twice under two names.
 */
function toEvidence(summary: MeasuredScenarioSummary): ScenarioEvidence {
  return {
    sampleCount: summary.sampleCount,
    inconclusiveCount: summary.inconclusiveCount,
    securityFailureCount: summary.securityFailureCount,
    outOfScopeCount: summary.outOfScopeCount,
  };
}

/** The share of runs the verifier accepted. The denominator is positive: a distribution with no observations refuses instead of being summarised. */
function successRate(summary: MeasuredScenarioSummary): number {
  return summary.statistics.successCount / summary.statistics.count;
}

function successRateFinding(
  baseline: MeasuredScenarioSummary,
  current: MeasuredScenarioSummary,
): Finding | undefined {
  const delta = successRate(current) - successRate(baseline);
  if (delta < -SUCCESS_RATE_MATERIAL_DELTA) {
    return { code: "success-rate-dropped", verdict: "regressed" };
  }
  if (delta > SUCCESS_RATE_MATERIAL_DELTA) {
    return { code: "success-rate-improved", verdict: "improved" };
  }
  return undefined;
}

/**
 * The median cost finding.
 *
 * Equal medians are no movement at all and are answered before anything is
 * divided — that is the case where a baseline median of zero is not a problem.
 * Otherwise a zero baseline makes the relative change undefined, and BENCH-9
 * says an undefined denominator is `inconclusive`: "the cost went up by an
 * unstatable amount" is not the same claim as "the cost went up", and reporting
 * the second would put a number on a division the data does not support.
 *
 * The denominator is the magnitude of the baseline median so that a positive
 * relative change always means "costs more", independent of the baseline's sign.
 * Costs are non-negative by construction; the guard exists because this function
 * is also reachable with records that were only ever held in memory.
 */
function costFinding(
  baseline: MeasuredScenarioSummary,
  current: MeasuredScenarioSummary,
): Finding | undefined {
  const baselineMedian = baseline.statistics.median;
  const currentMedian = current.statistics.median;
  if (currentMedian === baselineMedian) return undefined;
  if (baselineMedian === 0) {
    return { code: "cost-change-undefined", verdict: "inconclusive" };
  }
  const relative = (currentMedian - baselineMedian) / Math.abs(baselineMedian);
  if (relative > COST_MATERIAL_RELATIVE_DELTA) {
    return { code: "cost-increased", verdict: "regressed" };
  }
  if (relative < -COST_MATERIAL_RELATIVE_DELTA) {
    return { code: "cost-decreased", verdict: "improved" };
  }
  return undefined;
}

function refusal(
  side: "baseline" | "current",
  summary: RefusedScenarioSummary,
  input: ScenarioComparisonInput,
  alsoRefused?: RefusedScenarioSummary,
): ScenarioComparisonOutcome {
  const both =
    alsoRefused === undefined
      ? ""
      : `; the current side was refused too (${alsoRefused.reason}): ${alsoRefused.detail}`;
  return {
    ok: false,
    side,
    reason: summary.reason,
    detail: `${input.scenarioId} (${input.mode}) ${side}: ${summary.detail}${both}`,
  };
}

/** The verdict of one scenario in one mode, or the reason there is none. */
export function compareScenario(input: ScenarioComparisonInput): ScenarioComparisonOutcome {
  const options = { deterministic: input.deterministic, measure: input.measure };
  const baseline = summarizeScenarioSamples(input.baselineSamples, options);
  const current = summarizeScenarioSamples(input.currentSamples, options);

  // Baseline first: when neither side can be summarised, the baseline is the
  // half that makes the comparison impossible in the first place. The current
  // side's reason still travels along — one repair at a time is one run at a
  // time, and the second diagnosis was already computed.
  if (!baseline.ok) return refusal("baseline", baseline, input, current.ok ? undefined : current);
  if (!current.ok) return refusal("current", current, input);

  const findings = [
    isNewViolation(baseline.securityFailureCount, current.securityFailureCount)
      ? ({ code: "new-security-failure", verdict: "regressed" } as const)
      : undefined,
    isNewViolation(baseline.outOfScopeCount, current.outOfScopeCount)
      ? ({ code: "new-out-of-scope-change", verdict: "regressed" } as const)
      : undefined,
    successRateFinding(baseline, current),
    costFinding(baseline, current),
  ].filter((finding): finding is Finding => finding !== undefined);

  // The strongest finding decides — the array is built in the documented rule
  // order, which the shared ranking then uses only to break ties — and every
  // finding is still reported.
  // Typed against the exported vocabulary rather than left as `string[]`: the
  // codes are what a report groups on, so one that drifts from the list is a
  // grouping key no reader can look up.
  const reasons: readonly ScenarioComparisonReason[] =
    findings.length === 0 ? ["within-thresholds"] : findings.map((finding) => finding.code);

  return {
    ok: true,
    comparison: {
      scenarioId: input.scenarioId,
      mode: input.mode,
      baseline: baseline.statistics,
      current: current.statistics,
      verdict: strongestVerdict(findings.map((finding) => finding.verdict)),
      reasons,
    },
    evidence: {
      baseline: toEvidence(baseline),
      current: toEvidence(current),
    },
  };
}
