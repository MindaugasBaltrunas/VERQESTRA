import {
  aggregateSamples,
  emptyPopulationCause,
  type BenchmarkMetricsReport,
} from "../metrics/aggregate.js";
import {
  measure,
  totalOf,
  unmeasured,
  type MetricValue,
  type UnmeasuredCause,
} from "../metrics/metric-value.js";
import type { BenchmarkSample, SampleCompressionDiagnostics } from "../result.js";
import type { CompressionVariant } from "./variant.js";

/**
 * The fold from stored samples to one compression variant's numbers (task 0029).
 *
 * The quality half of the aggregate is the existing BENCH-7 fold, called and not
 * copied: a variant judged by a second implementation of `acceptedRate` would be
 * judged against a baseline computed by the first, and the two would eventually
 * disagree for reasons that have nothing to do with compression. What this
 * module adds is the economic half — the tokens a variant spent per task a
 * verifier accepted — and the diagnostics beside it.
 *
 * ## What a variant's population is
 *
 * The samples whose `compression.variantIdentity` equals this variant's, and
 * nothing else. Identity rather than id, because an id is a label somebody could
 * reuse. A sample carrying no compression record belongs to no variant and is
 * excluded from every aggregate — never folded into the baseline, which would
 * make the baseline the dumping ground for every unattributed run.
 *
 * ## Why a token total is refused so easily
 *
 * A token total is measured only when *every* conclusive sample in the
 * population carries `usage.captured === true`. Summing the captured subset
 * would understate the variant that failed to report — which is exactly the
 * variant a compression change is most likely to have broken — and the
 * understated variant would then look like the cheap one. So partial capture is
 * `no-captured-usage` rather than a smaller number, and the counts behind the
 * refusal are stated in the metric's detail.
 *
 * ## What counts as a token (task 0040)
 *
 * Two totals, because the run has two costs and they move independently.
 *
 * `billableTokens = input + output + cacheCreation` is what the bill is computed
 * from — a cache *read* is charged at a fraction the provider decides, and this
 * package holds no price list, so it is excluded rather than weighted. This is
 * the same formula the live orchestrator uses for `billable_tokens`
 * (`src/application/context-pack/context-pack-schema.ts`), and it is the same formula on purpose:
 * an offline verdict computed against a different objective than the one the
 * live economics optimise would reject the compression that made the real
 * invoice smaller.
 *
 * `totalTokens = input + output + cacheRead + cacheCreation` is the raw stream —
 * what the context window, the dispatch turn budget and the provider's rate
 * limit see. It stays, and it is still published, but it is now a *safety*
 * quantity rather than the objective: a variant that halves the bill by
 * quadrupling the context has bought something nobody wanted.
 *
 * `nonCachedTokens` is reported alongside both so a reader can see the shift; it
 * decides nothing.
 */

/**
 * The version of the primary cost KPI's *definition*.
 *
 * Bumped whenever the quantity `billableTokensPerAcceptedTask` measures changes,
 * so a report can say out loud that a baseline stamped with an earlier version
 * is not comparable on the primary KPI rather than silently subtracting two
 * different quantities. Version 1 was the raw-total era, when the objective was
 * `input + output + cacheRead + cacheCreation`; version 2 is the billable
 * objective introduced with task 0040.
 */
export const COMPRESSION_COST_KPI_VERSION = 2;

/** Token and turn totals, each per conclusive sample of this variant. */
export interface CompressionUsageTotals {
  /** The raw stream: input + output + cacheRead + cacheCreation. Safety quantity, not the objective. */
  readonly totalTokens: MetricValue;
  /** What the bill is computed from: input + output + cacheCreation. */
  readonly billableTokens: MetricValue;
  readonly nonCachedTokens: MetricValue;
  readonly cacheReadTokens: MetricValue;
  readonly cacheCreationTokens: MetricValue;
  readonly turnsPerTask: MetricValue;
}

/** Character counters per conclusive sample. Diagnostics; never an input to a verdict. */
export interface CompressionDiagnosticTotals {
  readonly rawTaskChars: MetricValue;
  readonly compiledTaskChars: MetricValue;
  readonly workerPromptChars: MetricValue;
  readonly symbolSourceChars: MetricValue;
  readonly symbolSignatureChars: MetricValue;
  readonly toolRawChars: MetricValue;
  readonly toolDigestChars: MetricValue;
}

/** The diagnostic counters, in report order. Exported so a reader can enumerate them rather than restate the list. */
export const COMPRESSION_DIAGNOSTIC_KEYS = [
  "rawTaskChars",
  "compiledTaskChars",
  "workerPromptChars",
  "symbolSourceChars",
  "symbolSignatureChars",
  "toolRawChars",
  "toolDigestChars",
] as const;

export type CompressionDiagnosticKey = (typeof COMPRESSION_DIAGNOSTIC_KEYS)[number];

export interface CompressionAggregate {
  readonly variant: CompressionVariant;
  /** The BENCH-7 fold over this variant's samples, unchanged and unduplicated. */
  readonly quality: BenchmarkMetricsReport;
  /**
   * The primary economic KPI: billable tokens over the tasks a verifier
   * accepted. This is the number the rollout verdict is taken on.
   */
  readonly billableTokensPerAcceptedTask: MetricValue;
  /**
   * The safety KPI: the raw token stream over the same denominator. Published
   * beside the primary one and gated on its own threshold, so a variant cannot
   * buy a cheaper bill with a context nobody bounded.
   */
  readonly rawTokensPerAcceptedTask: MetricValue;
  /**
   * Repairs and human reviews *per task*, which is not what `quality.repairRate`
   * and `quality.humanReviewRate` measure: those are the share of samples that
   * needed any. Both are reported, because a variant that halves the number of
   * runs needing a repair while doubling the repairs inside them has moved one
   * number and not the other.
   */
  readonly repairsPerTask: MetricValue;
  readonly humanReviewEventsPerTask: MetricValue;
  readonly usage: CompressionUsageTotals;
  readonly diagnostics: CompressionDiagnosticTotals;
  /** Conclusive samples whose usage was captured — the KPI's precondition, published so a refusal is checkable. */
  readonly capturedUsageCount: number;
}

function isConclusive(sample: BenchmarkSample): boolean {
  return sample.acceptance.verdict !== "inconclusive";
}

function hasCapturedUsage(sample: BenchmarkSample): boolean {
  return sample.usage?.captured === true;
}

/** `telemetry` holds what the model was billed for; `usage` holds what the cache absorbed. */
function sampleTotalTokens(sample: BenchmarkSample): number {
  return (
    sample.telemetry.inputTokens +
    sample.telemetry.outputTokens +
    (sample.usage?.cacheReadInputTokens ?? 0) +
    (sample.usage?.cacheCreationInputTokens ?? 0)
  );
}

/**
 * What one sample cost, on the same basis the live orchestrator bills at.
 *
 * Cache *reads* are excluded and cache *creation* is not: writing a prefix into
 * the cache is charged like input, re-reading it is charged at a fraction. The formula is
 * restated here rather than imported — BENCH-1 forbids this package from reaching into
 * orchestrator internals.
 *
 * ## What actually protects the pair
 *
 * Two tests, one on each side, pinning the SAME arithmetic on the same illustrative numbers
 * (140 input + 50 output + 10 cache creation = 200):
 *
 * - here: `tests/compression-aggregate.test.ts`, "the restated formula matches the orchestrator";
 * - there: `src/tests/analytics-cohorts.test.ts`, "summarizeUsageByTask: billable be cache_read".
 *
 * Neither test can see the other module, so neither proves agreement by itself. What they do
 * guarantee is that NEITHER side can drift silently: changing a formula fails its own test, and
 * the failing test names its counterpart, so the person updating one is told where the other is.
 *
 * This wording is deliberate. Until 2026-08-22 the comment here claimed the orchestrator's test
 * "fails from the other side if the two restatements ever disagree" — it does not and cannot,
 * since it exercises only `summarizeUsageByTask`. A comment describing a guard that does not
 * exist is worse than no comment: it is the reason nobody goes looking for the real one.
 */
export function sampleBillableTokens(sample: BenchmarkSample): number {
  return (
    sample.telemetry.inputTokens +
    sample.telemetry.outputTokens +
    (sample.usage?.cacheCreationInputTokens ?? 0)
  );
}

function sampleNonCachedTokens(sample: BenchmarkSample): number {
  return sample.telemetry.inputTokens + sample.telemetry.outputTokens;
}

/**
 * Why no token total may be stated for this population.
 *
 * `undefined` means one may. The counts published on the refused metric are the
 * capture counts the refusal rests on rather than a token total, because the
 * point of the refusal is that no honest token total exists to publish.
 */
function usageRefusal(
  sampleCount: number,
  conclusiveCount: number,
  capturedCount: number,
): UnmeasuredCause | undefined {
  if (conclusiveCount === 0) return emptyPopulationCause(sampleCount);
  if (capturedCount < conclusiveCount) {
    return {
      reason: "no-captured-usage",
      detail:
        `only ${capturedCount} of the ${conclusiveCount} conclusive sample(s) recorded captured token usage, ` +
        "so summing the captured ones would understate what this variant spent",
    };
  }
  return undefined;
}

/** A total over the conclusive population, refused whole whenever its usage was not captured. */
function usageTotal(
  conclusive: readonly BenchmarkSample[],
  refusal: UnmeasuredCause | undefined,
  denominator: number,
  emptyCause: UnmeasuredCause,
  read: (sample: BenchmarkSample) => number,
): MetricValue {
  if (refusal !== undefined) {
    return unmeasured(refusal, { numerator: 0, denominator });
  }
  return measure(totalOf(conclusive.map(read)), denominator, emptyCause);
}

/**
 * Turns per task.
 *
 * A turn count is optional even on a captured usage record — not every producer
 * reports one — so a population where some sample is silent about turns is
 * `no-applicable-samples` rather than an average over the ones that answered.
 */
function turnsPerTask(
  conclusive: readonly BenchmarkSample[],
  refusal: UnmeasuredCause | undefined,
  emptyCause: UnmeasuredCause,
): MetricValue {
  if (refusal !== undefined) {
    return unmeasured(refusal, { numerator: 0, denominator: conclusive.length });
  }
  const reported = conclusive.filter((sample) => sample.usage?.numTurns !== undefined);
  if (reported.length < conclusive.length) {
    return unmeasured(
      {
        reason: "no-applicable-samples",
        detail:
          `only ${reported.length} of the ${conclusive.length} conclusive sample(s) report a turn count, ` +
          "so no turns-per-task figure covers this population",
      },
      { numerator: 0, denominator: conclusive.length },
    );
  }
  return measure(
    totalOf(reported.map((sample) => sample.usage?.numTurns ?? 0)),
    conclusive.length,
    emptyCause,
  );
}

/**
 * One character counter, averaged over the conclusive population.
 *
 * Refused unless every conclusive sample carries it, on the same grounds as the
 * token totals: an average over the samples that happened to report a counter
 * describes a population nobody chose.
 */
function diagnosticTotal(
  conclusive: readonly BenchmarkSample[],
  emptyCause: UnmeasuredCause,
  key: CompressionDiagnosticKey,
): MetricValue {
  const read = (sample: BenchmarkSample): number | undefined =>
    (sample.compression?.diagnostics as SampleCompressionDiagnostics | undefined)?.[key];
  const reported = conclusive.filter((sample) => read(sample) !== undefined);
  if (conclusive.length > 0 && reported.length < conclusive.length) {
    return unmeasured(
      {
        reason: "no-applicable-samples",
        detail:
          `only ${reported.length} of the ${conclusive.length} conclusive sample(s) report ${key}, ` +
          "so no average over this population can be stated",
      },
      { numerator: 0, denominator: conclusive.length },
    );
  }
  return measure(
    totalOf(reported.map((sample) => read(sample) ?? 0)),
    conclusive.length,
    emptyCause,
  );
}

/**
 * The aggregate of one variant over a set of stored samples.
 *
 * Pure and total: the samples may be given in any order and may belong to any
 * variant, and the result depends only on the ones that belong to this one.
 */
export function aggregateCompressionSamples(
  variant: CompressionVariant,
  samples: readonly BenchmarkSample[],
): CompressionAggregate {
  const mine = samples.filter(
    (sample) => sample.compression?.variantIdentity === variant.identity,
  );
  const conclusive = mine.filter(isConclusive);
  const capturedUsageCount = conclusive.filter(hasCapturedUsage).length;
  const verifiedAccepted = conclusive.filter(
    (sample) => sample.acceptance.verdict === "verified-accepted",
  ).length;

  const emptyCause = emptyPopulationCause(mine.length);
  const refusal = usageRefusal(mine.length, conclusive.length, capturedUsageCount);
  const noAcceptedTask: UnmeasuredCause = {
    reason: "no-verified-accepted-change",
    detail:
      `none of the ${conclusive.length} conclusive sample(s) of variant "${variant.id}" was verified accepted, ` +
      "so there is no accepted task to divide the token total by",
  };

  return {
    variant,
    quality: aggregateSamples(mine),
    billableTokensPerAcceptedTask: usageTotal(
      conclusive,
      refusal,
      verifiedAccepted,
      conclusive.length === 0 ? emptyCause : noAcceptedTask,
      sampleBillableTokens,
    ),
    rawTokensPerAcceptedTask: usageTotal(
      conclusive,
      refusal,
      verifiedAccepted,
      conclusive.length === 0 ? emptyCause : noAcceptedTask,
      sampleTotalTokens,
    ),
    repairsPerTask: measure(
      totalOf(conclusive.map((sample) => sample.telemetry.repairs)),
      conclusive.length,
      emptyCause,
    ),
    humanReviewEventsPerTask: measure(
      totalOf(conclusive.map((sample) => sample.telemetry.humanReviewEvents)),
      conclusive.length,
      emptyCause,
    ),
    usage: {
      totalTokens: usageTotal(
        conclusive,
        refusal,
        conclusive.length,
        emptyCause,
        sampleTotalTokens,
      ),
      billableTokens: usageTotal(
        conclusive,
        refusal,
        conclusive.length,
        emptyCause,
        sampleBillableTokens,
      ),
      nonCachedTokens: usageTotal(
        conclusive,
        refusal,
        conclusive.length,
        emptyCause,
        sampleNonCachedTokens,
      ),
      cacheReadTokens: usageTotal(
        conclusive,
        refusal,
        conclusive.length,
        emptyCause,
        (sample) => sample.usage?.cacheReadInputTokens ?? 0,
      ),
      cacheCreationTokens: usageTotal(
        conclusive,
        refusal,
        conclusive.length,
        emptyCause,
        (sample) => sample.usage?.cacheCreationInputTokens ?? 0,
      ),
      turnsPerTask: turnsPerTask(conclusive, refusal, emptyCause),
    },
    diagnostics: Object.fromEntries(
      COMPRESSION_DIAGNOSTIC_KEYS.map((key) => [
        key,
        diagnosticTotal(conclusive, emptyCause, key),
      ]),
    ) as unknown as CompressionDiagnosticTotals,
    capturedUsageCount,
  };
}

/** One aggregate per declared variant, in the cohort's declaration order. */
export function aggregateCompressionCohort(
  cohort: readonly CompressionVariant[],
  samples: readonly BenchmarkSample[],
): readonly CompressionAggregate[] {
  return cohort.map((variant) => aggregateCompressionSamples(variant, samples));
}

/**
 * Samples belonging to no declared variant.
 *
 * Reported rather than absorbed: the same treatment `benchmark-comparison.ts`
 * gives a sample naming an undeclared scenario. It is also what lets a reader
 * tell a baseline nobody ran apart from a set of runs nobody attributed.
 */
export function unattributedSampleCount(
  cohort: readonly CompressionVariant[],
  samples: readonly BenchmarkSample[],
): number {
  const declared = new Set(cohort.map((variant) => variant.identity));
  return samples.filter(
    (sample) =>
      sample.compression === undefined || !declared.has(sample.compression.variantIdentity),
  ).length;
}
