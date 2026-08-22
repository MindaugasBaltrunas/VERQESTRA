import {
  COMPRESSION_COST_KPI_VERSION,
  COMPRESSION_DIAGNOSTIC_KEYS,
  aggregateCompressionCohort,
  unattributedSampleCount,
  type CompressionAggregate,
} from "../../domain/compression/aggregate.js";
import {
  ALL_FEATURES_VARIANT_ID,
  BASELINE_VARIANT_ID,
  COMPRESSION_COHORT,
} from "../../domain/compression/cohort.js";
import {
  judgeCompressionVariant,
  type CompressionVerdict,
} from "../../domain/compression/compression-verdict.js";
import { CONTEXT_COMPRESSION_REGISTRY_VERSION } from "../../domain/compression/features.js";
import type { CompressionFeature } from "../../domain/compression/features.js";
import type { CompressionVariant } from "../../domain/compression/variant.js";
import type { BenchmarkSample } from "../../domain/result.js";
import {
  canonicalReportNumber,
  toMetricRow,
  type ReportMetricRow,
} from "./benchmark-report-model.js";

/**
 * The compression section of a report (task 0029, BENCH-10, BENCH-11).
 *
 * Every number here is folded once, in the domain, and this module only shapes
 * the result into rows the two renderers print. The report never recomputes a
 * number it was handed, so the JSON and the Markdown cannot disagree about a
 * verdict, and a reader who re-runs the fold gets what the report says.
 *
 * ## What this section may claim
 *
 * A contribution belongs to a feature only when that feature's own
 * single-feature variant was run. Contributions are not additive: the residual
 * between the combination's observed saving and the sum of the individual ones
 * is a measured fact about the combination and is attributable to no feature.
 * And a feature that was never run individually is `n/a` — never derived by
 * subtracting the others from the combination, which would publish an arithmetic
 * identity as a measurement.
 *
 * ## Why an empty ledger produces no number
 *
 * With no compression sample recorded, every aggregate is empty, every verdict
 * is `not_measured` and every KPI is `undefined` — which the JSON rendering
 * writes as an absent key and the Markdown as `n/a`. Nothing in this module can
 * produce a token figure without a sample carrying one.
 */

/** One variant's row, in the cohort's declaration order. */
/**
 * The token totals the two KPIs are built from, per conclusive sample.
 *
 * Published because demoting the raw stream to a safety bound must not make the
 * counters behind it invisible: a reader who can see only the two per-accepted-
 * task figures cannot tell a variant that shrank the prompt from one that moved
 * the prompt into the cache, and those are different facts about a compression.
 * Every component the sample ledger records has a column here.
 */
export interface ReportCompressionUsageTotals {
  /** The raw stream: input + output + cache read + cache creation. */
  readonly totalTokens: number | undefined;
  /** What the bill is computed from: input + output + cache creation. */
  readonly billableTokens: number | undefined;
  readonly nonCachedTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheCreationTokens: number | undefined;
  readonly turnsPerTask: number | undefined;
}

export interface ReportCompressionVariantRow {
  readonly variantId: string;
  readonly variantIdentity: string;
  readonly features: readonly string[];
  readonly hookProfile: string;
  readonly sampleCount: number;
  readonly conclusiveCount: number;
  /** Conclusive samples whose token usage was actually captured; below `conclusiveCount` the KPI is refused. */
  readonly capturedUsageCount: number;
  readonly verdict: CompressionVerdict;
  readonly reasons: readonly string[];
  /** The primary KPI the verdict was taken on: billable tokens per verified-accepted task. */
  readonly billableTokensPerAcceptedTask: number | undefined;
  /** Movement against the baseline, `variant - baseline`: negative is cheaper. */
  readonly billableTokensPerAcceptedTaskDelta: number | undefined;
  readonly billableTokensPerAcceptedTaskRelativeDelta: number | undefined;
  /** The safety KPI: the raw stream over the same denominator, gated on its own threshold. */
  readonly rawTokensPerAcceptedTask: number | undefined;
  readonly rawTokensPerAcceptedTaskDelta: number | undefined;
  readonly rawTokensPerAcceptedTaskRelativeDelta: number | undefined;
  readonly acceptedRate: number | undefined;
  readonly securityFailureRate: number | undefined;
  readonly outOfScopeRate: number | undefined;
  readonly repairsPerTask: number | undefined;
  readonly humanReviewEventsPerTask: number | undefined;
  /** The token components behind both KPIs, so no telemetry field is folded away unseen. */
  readonly usage: ReportCompressionUsageTotals;
  /** Character counters against the baseline's. Diagnostics: they decide no verdict. */
  readonly diagnostics: readonly ReportMetricRow[];
}

/**
 * What one feature contributed, measured on its own single-feature variant.
 *
 * Stated as a saving — `baseline - variant` — so a positive number is money not
 * spent. The row deltas above use the report's usual `variant - baseline`
 * movement; the two signs are opposite on purpose and each is named for what it
 * is, because a "contribution" that went negative when a feature helped would be
 * read backwards by every reader.
 */
export interface ReportCompressionFeatureContribution {
  readonly feature: string;
  /** The single-feature variant the contribution was measured on, or `""` when the cohort declares none. */
  readonly variantId: string;
  readonly contribution: number | undefined;
  readonly relativeContribution: number | undefined;
}

export interface ReportCompressionCombination {
  readonly variantId: string;
  readonly featureContributions: readonly ReportCompressionFeatureContribution[];
  /**
   * The sum of the contributions that were measured. A lower bound whenever some
   * single-feature variant was not run, which is why the residual below is
   * computed only when every one of them was.
   */
  readonly sumOfSingleFeatureContributions: number | undefined;
  readonly observedCombinationContribution: number | undefined;
  /** Observed minus sum. A fact about the combination, attributable to no single feature. */
  readonly interactionResidual: number | undefined;
}

export interface ReportCompressionSection {
  readonly registryVersion: number;
  /**
   * The version of the primary KPI's definition. Published so a reader comparing
   * two reports can see whether the headline numbers measure the same quantity.
   */
  readonly costKpiVersion: number;
  readonly baselineVariantId: string;
  readonly variants: readonly ReportCompressionVariantRow[];
  readonly combination: ReportCompressionCombination | undefined;
  /** Samples belonging to no declared variant. They entered no aggregate and were never folded into the baseline. */
  readonly unattributedSampleCount: number;
  /** What this section may not be read as claiming. Rendered in both formats. */
  readonly limitations: readonly string[];
}

function optional(value: number | undefined): number | undefined {
  return value === undefined ? undefined : canonicalReportNumber(value);
}

function diagnosticRows(
  baseline: CompressionAggregate,
  variant: CompressionAggregate,
): readonly ReportMetricRow[] {
  return COMPRESSION_DIAGNOSTIC_KEYS.map((key) =>
    toMetricRow(key, "cost", {
      baseline: baseline.diagnostics[key].value,
      current: variant.diagnostics[key].value,
    }),
  );
}

/** Carried across unchanged: an unmeasured total stays absent rather than becoming a zero. */
function usageTotals(aggregate: CompressionAggregate): ReportCompressionUsageTotals {
  return {
    totalTokens: optional(aggregate.usage.totalTokens.value),
    billableTokens: optional(aggregate.usage.billableTokens.value),
    nonCachedTokens: optional(aggregate.usage.nonCachedTokens.value),
    cacheReadTokens: optional(aggregate.usage.cacheReadTokens.value),
    cacheCreationTokens: optional(aggregate.usage.cacheCreationTokens.value),
    turnsPerTask: optional(aggregate.usage.turnsPerTask.value),
  };
}

function variantRow(
  baseline: CompressionAggregate,
  aggregate: CompressionAggregate,
): ReportCompressionVariantRow {
  const judgement = judgeCompressionVariant(baseline, aggregate);
  return {
    variantId: aggregate.variant.id,
    variantIdentity: aggregate.variant.identity,
    features: [...aggregate.variant.features],
    hookProfile: aggregate.variant.hookProfile,
    sampleCount: aggregate.quality.sampleCount,
    conclusiveCount: aggregate.quality.conclusiveCount,
    capturedUsageCount: aggregate.capturedUsageCount,
    verdict: judgement.verdict,
    reasons: judgement.reasons,
    billableTokensPerAcceptedTask: optional(aggregate.billableTokensPerAcceptedTask.value),
    billableTokensPerAcceptedTaskDelta: optional(
      judgement.evidence.billableTokensPerAcceptedTaskDelta,
    ),
    billableTokensPerAcceptedTaskRelativeDelta: optional(
      judgement.evidence.billableTokensPerAcceptedTaskRelativeDelta,
    ),
    rawTokensPerAcceptedTask: optional(aggregate.rawTokensPerAcceptedTask.value),
    rawTokensPerAcceptedTaskDelta: optional(judgement.evidence.rawTokensPerAcceptedTaskDelta),
    rawTokensPerAcceptedTaskRelativeDelta: optional(
      judgement.evidence.rawTokensPerAcceptedTaskRelativeDelta,
    ),
    acceptedRate: optional(aggregate.quality.acceptedRate.value),
    securityFailureRate: optional(aggregate.quality.securityFailureRate.value),
    outOfScopeRate: optional(aggregate.quality.outOfScopeRate.value),
    repairsPerTask: optional(aggregate.repairsPerTask.value),
    humanReviewEventsPerTask: optional(aggregate.humanReviewEventsPerTask.value),
    usage: usageTotals(aggregate),
    diagnostics: diagnosticRows(baseline, aggregate),
  };
}

/**
 * The variant a feature's contribution is measured on.
 *
 * A feature can appear in more than one single-feature variant —
 * `bash_output_digest` does, once as the shadow observer and once wired through
 * the hook handler — and those two are not the same measurement. The one that
 * belongs beside the combination is the one wired the way the combination was;
 * the unwired variant is the fallback for the features no hook profile affects.
 * The other single-feature variant keeps its own row and is simply not summed,
 * because counting one feature twice would inflate the sum it is subtracted from.
 */
function representativeVariant(
  cohort: readonly CompressionVariant[],
  feature: CompressionFeature,
  hookProfile: string,
): CompressionVariant | undefined {
  const candidates = cohort.filter(
    (variant) => variant.features.length === 1 && variant.features[0] === feature,
  );
  return (
    candidates.find((variant) => variant.hookProfile === hookProfile) ??
    candidates.find((variant) => variant.hookProfile === "unwired")
  );
}

/**
 * A contribution is measured on the primary KPI, because it is the KPI a rollout
 * decision is taken on: a per-feature attribution computed against the safety
 * quantity would rank the features by something no verdict reads.
 */
function contributionOf(
  baseline: CompressionAggregate,
  aggregate: CompressionAggregate | undefined,
): number | undefined {
  const baselineValue = baseline.billableTokensPerAcceptedTask.value;
  const variantValue = aggregate?.billableTokensPerAcceptedTask.value;
  if (baselineValue === undefined || variantValue === undefined) return undefined;
  return baselineValue - variantValue;
}

function combinationOf(
  cohort: readonly CompressionVariant[],
  aggregates: readonly CompressionAggregate[],
  baseline: CompressionAggregate,
): ReportCompressionCombination | undefined {
  const combinationVariant = cohort.find((variant) => variant.id === ALL_FEATURES_VARIANT_ID);
  if (combinationVariant === undefined) return undefined;
  const byIdentity = new Map(
    aggregates.map((aggregate) => [aggregate.variant.identity, aggregate] as const),
  );
  const combination = byIdentity.get(combinationVariant.identity);

  const featureContributions: readonly ReportCompressionFeatureContribution[] =
    combinationVariant.features.map((feature) => {
      const representative = representativeVariant(
        cohort,
        feature,
        combinationVariant.hookProfile,
      );
      const contribution =
        representative === undefined
          ? undefined
          : contributionOf(baseline, byIdentity.get(representative.identity));
      const baselineValue = baseline.billableTokensPerAcceptedTask.value;
      return {
        feature,
        variantId: representative?.id ?? "",
        contribution: optional(contribution),
        relativeContribution:
          contribution === undefined || baselineValue === undefined || baselineValue === 0
            ? undefined
            : canonicalReportNumber(contribution / Math.abs(baselineValue)),
      };
    });

  const measured = featureContributions
    .map((entry) => entry.contribution)
    .filter((contribution): contribution is number => contribution !== undefined);
  const sum =
    measured.length === 0
      ? undefined
      : canonicalReportNumber(measured.reduce((total, contribution) => total + contribution, 0));
  const observed = optional(contributionOf(baseline, combination));
  const everyFeatureMeasured = measured.length === featureContributions.length;

  return {
    variantId: combinationVariant.id,
    featureContributions,
    sumOfSingleFeatureContributions: sum,
    observedCombinationContribution: observed,
    interactionResidual:
      observed === undefined || sum === undefined || !everyFeatureMeasured
        ? undefined
        : canonicalReportNumber(observed - sum),
  };
}

function limitationsOf(
  rows: readonly ReportCompressionVariantRow[],
  unattributed: number,
): readonly string[] {
  const limitations: string[] = [];
  const recorded = rows.reduce((total, row) => total + row.sampleCount, 0);
  if (recorded === 0) {
    limitations.push(
      "no compression sample has been recorded, so every variant verdict is not_measured and no " +
        "compression claim may be made from this package",
    );
  }
  if (unattributed > 0) {
    limitations.push(
      `${unattributed} recorded sample(s) carry no declared compression variant; they entered no ` +
        "compression aggregate and were not folded into the baseline",
    );
  }
  limitations.push(
    "a contribution is attributable to a feature only from that feature's own single-feature " +
      "variant, and contributions are not additive: the interaction residual is a fact about the " +
      "combination and belongs to no individual feature",
  );
  limitations.push(
    "a feature that was never run on its own is reported as not measured; it is never derived by " +
      "subtracting the other features from the combination",
  );
  limitations.push(
    "the character counters in this section are diagnostics: they say how much text a path " +
      "removed, not how many tokens it saved, and no verdict here is computed from them",
  );
  limitations.push(
    `the primary KPI is billable tokens per verified-accepted task (input + output + cache ` +
      `creation, excluding cache reads) under costKpiVersion ${COMPRESSION_COST_KPI_VERSION}; a ` +
      "baseline recorded under an earlier costKpiVersion measured the raw token stream instead " +
      "and is not comparable against these numbers on the primary KPI",
  );
  limitations.push(
    "the raw token stream is reported as a safety bound, not as the objective: it gates the " +
      "verdict on its own threshold and is never the number a saving is claimed from",
  );
  return limitations;
}

/**
 * The compression section over a set of stored samples.
 *
 * Pure and deterministic: the cohort's declaration order decides the row order,
 * never the order samples arrived in, so two reports of one ledger are
 * byte-identical.
 */
export function summarizeCompressionCohort(
  samples: readonly BenchmarkSample[],
  cohort: readonly CompressionVariant[] = COMPRESSION_COHORT,
): ReportCompressionSection {
  const aggregates = aggregateCompressionCohort(cohort, samples);
  const baseline = aggregates.find(
    (aggregate) => aggregate.variant.id === BASELINE_VARIANT_ID,
  );
  if (baseline === undefined) {
    throw new TypeError(
      `The cohort declares no "${BASELINE_VARIANT_ID}" variant, so no variant can be reported against one.`,
    );
  }

  const variants = aggregates.map((aggregate) => variantRow(baseline, aggregate));
  const unattributed = unattributedSampleCount(cohort, samples);
  return {
    registryVersion: CONTEXT_COMPRESSION_REGISTRY_VERSION,
    costKpiVersion: COMPRESSION_COST_KPI_VERSION,
    baselineVariantId: baseline.variant.id,
    variants,
    combination: combinationOf(cohort, aggregates, baseline),
    unattributedSampleCount: unattributed,
    limitations: limitationsOf(variants, unattributed),
  };
}
