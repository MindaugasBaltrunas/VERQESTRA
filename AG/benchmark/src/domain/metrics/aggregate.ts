import type { BenchmarkMetrics, CostMetrics, ModeMetrics } from "../metrics.js";
import type { BenchmarkSample, CheckKind, CheckStatus, ExecutionMode } from "../result.js";
import { EXECUTION_MODES } from "../result.js";
import {
  measure,
  totalOf,
  type MetricValue,
  type UnmeasuredCause,
} from "./metric-value.js";

/**
 * Benchmark aggregation (BENCH-7).
 *
 * A pure fold from stored samples to the rates and per-change costs a report
 * publishes. It reads nothing, times nothing and randomises nothing: the same
 * samples in any order produce the identical result, because a benchmark whose
 * aggregate depends on the order its runner happened to finish in cannot be
 * compared against itself across runs (BENCH-9).
 *
 * ## What may enter a denominator
 *
 * An `inconclusive` sample is one the verifier could not decide — evidence that
 * never arrived, a check that crashed, a scope pattern it cannot read. BENCH-5
 * forbids dropping such a sample silently, and counting it as a failure would
 * flatter the numbers exactly when the harness was least reliable. So it enters
 * no numerator and no denominator, and is reported as `inconclusiveCount` beside
 * every rate it was excluded from. The cost totals exclude it too: a record
 * incomplete enough to be unverifiable is not a record its token count can be
 * trusted from. Reported cost is therefore a lower bound whenever
 * `inconclusiveCount` is above zero, which is the number's own warning label.
 *
 * ## Accepted versus verified accepted
 *
 * The two cost metrics deliberately count different changes, as
 * `domain/metrics.ts` states: `perAcceptedChange` divides by the changes the
 * agent itself claimed, `perVerifiedAcceptedChange` by the ones an independent
 * verifier granted (BENCH-6). An agent that claims success generously makes the
 * first look cheap and leaves the second untouched, so the gap between them is
 * itself a measurement. Every *rate*, including `acceptedRate`, is the
 * verifier's: an agent's word is evidence of nothing but its own claim.
 *
 * ## Cost per change, not cost of a change
 *
 * `perAcceptedChange` divides the cost of the *whole population* by the number
 * of accepted changes, not the cost of accepted samples by their own count. What
 * a benchmark comparison needs to know is what one usable change costs including
 * the runs that produced none — a mode that burns four rejected attempts to land
 * one change costs five runs per change, and averaging only over the successful
 * run would report it as costing one.
 *
 * ## What a measured zero does and does not say
 *
 * `repairRate` and `humanReviewRate` describe loops only the `ag-loop` mode has:
 * the other two modes are structurally incapable of a repair or a human review,
 * so their rate there is a measured `0` rather than an absent value, and
 * `firstPassRate` in those modes is the same number as `acceptedRate`. That is
 * the floor the comparison rests on and not a claim that those modes avoided
 * something — a report presenting the modes side by side has to say so (BENCH-10
 * limitations, BENCH-11). Whether such a rate should instead be reported as
 * inapplicable is a contract question for the report layer, not something this
 * fold may decide by omitting a number the samples do support.
 */

/** The BENCH-7 rates, in report order. Exported so a reader — or a test — can enumerate them rather than restate the list. */
export const RATE_METRIC_KEYS = [
  "acceptedRate",
  "firstPassRate",
  "repairRate",
  "humanReviewRate",
  "outOfScopeRate",
  "testFailureRate",
  "architectureFailureRate",
  "securityFailureRate",
] as const;

export type RateMetricKey = (typeof RATE_METRIC_KEYS)[number];

/** The BENCH-7 per-change cost metrics, in report order. */
export const COST_METRIC_KEYS = ["tokens", "durationMs", "llmCalls"] as const;

export type CostMetricKey = (typeof COST_METRIC_KEYS)[number];

/** The two populations a cost is reported per, in report order. */
export const COST_BASIS_KEYS = ["perAcceptedChange", "perVerifiedAcceptedChange"] as const;

export type CostBasisKey = (typeof COST_BASIS_KEYS)[number];

export type CostMetricsReport = Readonly<Record<CostMetricKey, MetricValue>>;

/**
 * The aggregate, with every metric carrying the counts and the reason behind it.
 * {@link toBenchmarkMetrics} narrows it to the published {@link BenchmarkMetrics}
 * contract for consumers that only want the numbers.
 */
export type BenchmarkMetricsReport = Readonly<Record<RateMetricKey, MetricValue>> &
  Readonly<Record<CostBasisKey, CostMetricsReport>> & {
    readonly sampleCount: number;
    /** Samples the verifier reached a decision on; the denominator of every rate. */
    readonly conclusiveCount: number;
    /** Samples excluded from every numerator and denominator, reported so the exclusion is visible (BENCH-5). */
    readonly inconclusiveCount: number;
  };

/** An aggregate and the mode it describes. Modes are never averaged together — that would hide the comparison BENCH-3 exists for. */
export interface ModeMetricsReport {
  readonly mode: ExecutionMode;
  readonly report: BenchmarkMetricsReport;
}

/** A check that reached a verdict. `skipped` and `errored` are evidence of nothing and count neither way. */
const DECIDED_CHECK_STATUSES: ReadonlySet<CheckStatus> = Object.freeze(
  new Set<CheckStatus>(["passed", "failed"]),
);

function isConclusive(sample: BenchmarkSample): boolean {
  return sample.acceptance.verdict !== "inconclusive";
}

function isVerifiedAccepted(sample: BenchmarkSample): boolean {
  return sample.acceptance.verdict === "verified-accepted";
}

/**
 * Accepted on the first attempt: verified accepted, reached without a second
 * attempt and without a repair dispatch. The repair counter is read too, though
 * a validated sample keeps repairs below attempts and so cannot report one
 * against a single attempt: the aggregate is also handed records that were never
 * stored, and reading only the attempt count would call such a record first-pass
 * on the strength of a field it contradicts.
 */
function isFirstPass(sample: BenchmarkSample): boolean {
  return (
    isVerifiedAccepted(sample) && sample.telemetry.attempts <= 1 && sample.telemetry.repairs === 0
  );
}

function neededRepair(sample: BenchmarkSample): boolean {
  return sample.telemetry.repairs > 0;
}

function reachedHumanReview(sample: BenchmarkSample): boolean {
  return sample.telemetry.humanReviewEvents > 0;
}

function changedOutOfScope(sample: BenchmarkSample): boolean {
  return sample.workspace.outOfScopeFiles.length > 0;
}

function hasDecidedCheckOfKind(sample: BenchmarkSample, kind: CheckKind): boolean {
  return sample.checks.some(
    (check) => check.kind === kind && DECIDED_CHECK_STATUSES.has(check.status),
  );
}

function hasFailedCheckOfKind(sample: BenchmarkSample, kind: CheckKind): boolean {
  return sample.checks.some((check) => check.kind === kind && check.status === "failed");
}

function sampleTokens(sample: BenchmarkSample): number {
  return sample.telemetry.inputTokens + sample.telemetry.outputTokens;
}

/**
 * Why a rate over the whole conclusive population has no value. The distinction
 * matters: nothing ran, versus everything ran and none of it could be verified.
 *
 * Exported because a second fold over the same population — the compression
 * aggregate — has to say the same thing about an empty one. Two spellings of
 * "nothing was measured here" would read as two different findings.
 */
export function emptyPopulationCause(sampleCount: number): UnmeasuredCause {
  if (sampleCount === 0) {
    return { reason: "no-samples", detail: "no sample was recorded for this population" };
  }
  return {
    reason: "no-conclusive-samples",
    detail:
      `all ${sampleCount} recorded sample(s) were inconclusive, ` +
      "so none of them may enter a denominator",
  };
}

function countOf(samples: readonly BenchmarkSample[], holds: (sample: BenchmarkSample) => boolean) {
  return samples.reduce((count, sample) => (holds(sample) ? count + 1 : count), 0);
}

/** A rate over every conclusive sample. */
function rateOverPopulation(
  conclusive: readonly BenchmarkSample[],
  sampleCount: number,
  holds: (sample: BenchmarkSample) => boolean,
): MetricValue {
  return measure(countOf(conclusive, holds), conclusive.length, emptyPopulationCause(sampleCount));
}

/**
 * A failure rate for one class of check.
 *
 * The denominator is the conclusive samples that actually carry a decided check
 * of that kind, not every conclusive sample: a run whose architecture gate never
 * reported cannot testify that the architecture held, and counting it as a
 * passing denominator entry would dilute the rate toward zero with samples that
 * measured nothing. When no sample carries such a check the rate is unmeasured
 * rather than `0` — the difference between "nothing failed" and "nothing was
 * checked" is the whole point of BENCH-7's zero-denominator rule.
 */
function failureRateForKind(
  conclusive: readonly BenchmarkSample[],
  sampleCount: number,
  kind: CheckKind,
): MetricValue {
  const applicable = conclusive.filter((sample) => hasDecidedCheckOfKind(sample, kind));
  const cause: UnmeasuredCause =
    conclusive.length === 0
      ? emptyPopulationCause(sampleCount)
      : {
          reason: "no-applicable-samples",
          detail:
            `none of the ${conclusive.length} conclusive sample(s) carries a ${kind} check ` +
            "that reached a verdict, so no failure rate can be stated for it",
        };
  return measure(
    countOf(applicable, (sample) => hasFailedCheckOfKind(sample, kind)),
    applicable.length,
    cause,
  );
}

/**
 * Cost of the whole conclusive population divided by the number of changes of
 * one class. `cause` names the class, so a report can say which change was
 * missing rather than only that a denominator was empty.
 */
function costPerChange(
  conclusive: readonly BenchmarkSample[],
  sampleCount: number,
  changeCount: number,
  cause: UnmeasuredCause,
): CostMetricsReport {
  const emptyCause = conclusive.length === 0 ? emptyPopulationCause(sampleCount) : cause;
  return {
    tokens: measure(totalOf(conclusive.map(sampleTokens)), changeCount, emptyCause),
    durationMs: measure(
      totalOf(conclusive.map((sample) => sample.durationMs)),
      changeCount,
      emptyCause,
    ),
    llmCalls: measure(
      totalOf(conclusive.map((sample) => sample.telemetry.llmCalls)),
      changeCount,
      emptyCause,
    ),
  };
}

/**
 * The BENCH-7 aggregate over one population of samples.
 *
 * Callers pass one mode's samples; {@link aggregateSamplesByMode} does the
 * grouping. Passing a mixed population is allowed and produces a defined result,
 * but a report must not publish it as a comparison.
 */
export function aggregateSamples(samples: readonly BenchmarkSample[]): BenchmarkMetricsReport {
  const sampleCount = samples.length;
  const conclusive = samples.filter(isConclusive);
  const acceptedChanges = countOf(conclusive, (sample) => sample.acceptance.agentClaimedDone);
  const verifiedAcceptedChanges = countOf(conclusive, isVerifiedAccepted);

  return {
    sampleCount,
    conclusiveCount: conclusive.length,
    inconclusiveCount: sampleCount - conclusive.length,

    acceptedRate: rateOverPopulation(conclusive, sampleCount, isVerifiedAccepted),
    firstPassRate: rateOverPopulation(conclusive, sampleCount, isFirstPass),
    repairRate: rateOverPopulation(conclusive, sampleCount, neededRepair),
    humanReviewRate: rateOverPopulation(conclusive, sampleCount, reachedHumanReview),
    outOfScopeRate: rateOverPopulation(conclusive, sampleCount, changedOutOfScope),
    testFailureRate: failureRateForKind(conclusive, sampleCount, "test"),
    architectureFailureRate: failureRateForKind(conclusive, sampleCount, "architecture"),
    securityFailureRate: failureRateForKind(conclusive, sampleCount, "security"),

    perAcceptedChange: costPerChange(conclusive, sampleCount, acceptedChanges, {
      reason: "no-accepted-change",
      detail:
        `none of the ${conclusive.length} conclusive sample(s) produced a change the agent claimed done, ` +
        "so there is no accepted change to divide the cost by",
    }),
    perVerifiedAcceptedChange: costPerChange(conclusive, sampleCount, verifiedAcceptedChanges, {
      reason: "no-verified-accepted-change",
      detail:
        `none of the ${conclusive.length} conclusive sample(s) was verified accepted, ` +
        "so there is no verified accepted change to divide the cost by",
    }),
  };
}

/**
 * One aggregate per execution mode.
 *
 * Modes come out in the order {@link EXECUTION_MODES} declares them, not the
 * order samples arrived in, so two runs of the same suite produce byte-identical
 * reports. A mode no sample was recorded for is omitted rather than reported as
 * an empty aggregate: BENCH-3 compares the modes that were run, and a report
 * layer that wants to show a missing mode can see it is absent.
 */
export function aggregateSamplesByMode(
  samples: readonly BenchmarkSample[],
): readonly ModeMetricsReport[] {
  return EXECUTION_MODES.map((mode) => ({
    mode,
    samples: samples.filter((sample) => sample.mode === mode),
  }))
    .filter((group) => group.samples.length > 0)
    .map((group) => ({ mode: group.mode, report: aggregateSamples(group.samples) }));
}

function toCostMetrics(report: CostMetricsReport): CostMetrics {
  return {
    tokens: report.tokens.value,
    durationMs: report.durationMs.value,
    llmCalls: report.llmCalls.value,
  };
}

/**
 * The published {@link BenchmarkMetrics} view of a report: the numbers without
 * the counts and reasons. Narrowing is one-way — a consumer that needs to know
 * why a metric is absent reads the report, not this.
 */
export function toBenchmarkMetrics(report: BenchmarkMetricsReport): BenchmarkMetrics {
  return {
    sampleCount: report.sampleCount,
    inconclusiveCount: report.inconclusiveCount,
    acceptedRate: report.acceptedRate.value,
    firstPassRate: report.firstPassRate.value,
    repairRate: report.repairRate.value,
    humanReviewRate: report.humanReviewRate.value,
    outOfScopeRate: report.outOfScopeRate.value,
    testFailureRate: report.testFailureRate.value,
    architectureFailureRate: report.architectureFailureRate.value,
    securityFailureRate: report.securityFailureRate.value,
    perAcceptedChange: toCostMetrics(report.perAcceptedChange),
    perVerifiedAcceptedChange: toCostMetrics(report.perVerifiedAcceptedChange),
  };
}

export function toModeMetrics(reports: readonly ModeMetricsReport[]): readonly ModeMetrics[] {
  return reports.map((entry) => ({
    mode: entry.mode,
    metrics: toBenchmarkMetrics(entry.report),
  }));
}
