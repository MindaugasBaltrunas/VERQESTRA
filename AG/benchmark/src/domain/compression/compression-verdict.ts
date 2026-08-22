import {
  COST_MATERIAL_RELATIVE_DELTA,
  RAW_TOKENS_SAFETY_RELATIVE_DELTA,
  SUCCESS_RATE_MATERIAL_DELTA,
} from "../comparison/thresholds.js";
import { isMeasured, type MetricValue } from "../metrics/metric-value.js";
import type { RateMetricKey } from "../metrics/aggregate.js";
import { BASELINE_VARIANT_ID, COMPRESSION_COHORT } from "./cohort.js";
import {
  COMPRESSION_COST_KPI_VERSION,
  aggregateCompressionSamples,
  type CompressionAggregate,
} from "./aggregate.js";
import type { CompressionVariant } from "./variant.js";

/**
 * Judging one compression variant against the baseline (task 0029).
 *
 * The question is narrow on purpose: *does this variant lower the tokens spent
 * per verified-accepted task without making acceptance, security or
 * forbidden-edit behaviour worse?* Everything here answers that and nothing
 * else. The function is pure, total, and reads no clock and no file — the same
 * two aggregates always produce the same verdict, which is what lets a report
 * state a verdict a reader can re-derive from the published numbers.
 *
 * ## Which tokens the question is about (task 0040)
 *
 * The billable ones: `input + output + cacheCreation`, the quantity the live
 * cohort analytics and the dispatch budget model already optimise. Judging on
 * the raw stream instead — the quantity this module used until task 0040 — made
 * the offline gate optimise a *different* objective from the live economics, and
 * the two genuinely conflict: a variant that moves 100k tokens out of the prompt
 * and into a cached prefix that is re-read 300k times has a smaller invoice and
 * a larger raw total, and the old gate rejected it for getting cheaper.
 *
 * The raw stream is not discarded, it is demoted. It still gates the verdict,
 * but as a safety bound with its own, looser threshold
 * (`RAW_TOKENS_SAFETY_RELATIVE_DELTA`): a cheaper bill does not buy an unbounded
 * context, because the context window, the turn budget and the rate limit are
 * charged in raw tokens whatever the invoice says.
 *
 * ## Why a separate vocabulary
 *
 * `domain/comparison/verdict-priority.ts` already ranks
 * `regressed > inconclusive > improved > stable` for a run-against-baseline
 * comparison. The rollup here has the same shape and a different vocabulary,
 * because `accepted` is a rollout decision — this variant may be turned on —
 * while `improved` is a statement that a distribution moved. Reusing the
 * comparison enum would let a report say a feature was "improved" when what was
 * measured is that it did not make anything worse.
 *
 * ## Why chars cannot appear here
 *
 * No character counter is read by any function in this module, and no argument
 * carries one that could be. That is the point: `estimateTokensFromChars` exists
 * on the orchestrator side for context-size telemetry, and a benchmark verdict
 * derived from an estimate of the thing it is supposed to measure would be
 * circular. Two aggregates differing only in their diagnostics produce the
 * identical verdict, and a test holds that.
 */

export const COMPRESSION_VERDICTS = ["accepted", "rejected", "not_measured"] as const;

export type CompressionVerdict = (typeof COMPRESSION_VERDICTS)[number];

/**
 * A quality predicate and the tolerance it is judged under.
 *
 * `acceptedRate` reuses the package's stated noise floor: agent runs vary
 * between repetitions, and a gate firing on a few points of movement would
 * report a regression every time a model took one more turn. The other two get
 * tolerance `0`, matching BENCH-9's rule that a *new* security or out-of-scope
 * violation is a regression regardless of what it saved.
 */
interface CompressionPredicate {
  /** Kebab-case, because it is spelled into the reason codes. */
  readonly code: string;
  readonly metric: RateMetricKey;
  readonly higherIsBetter: boolean;
  readonly tolerance: number;
}

const PREDICATES: readonly CompressionPredicate[] = [
  {
    code: "accepted-rate",
    metric: "acceptedRate",
    higherIsBetter: true,
    tolerance: SUCCESS_RATE_MATERIAL_DELTA,
  },
  {
    code: "security-failure-rate",
    metric: "securityFailureRate",
    higherIsBetter: false,
    tolerance: 0,
  },
  { code: "out-of-scope-rate", metric: "outOfScopeRate", higherIsBetter: false, tolerance: 0 },
];

/** One predicate as it was evaluated, so a reader can re-derive the verdict from the report. */
export interface CompressionPredicateEvidence {
  readonly code: string;
  readonly higherIsBetter: boolean;
  readonly tolerance: number;
  readonly baseline: number | undefined;
  readonly variant: number | undefined;
  /** How much *worse* the variant is; above the tolerance it is a regression. Absent when either side is unmeasured. */
  readonly delta: number | undefined;
  readonly regressed: boolean;
}

/**
 * A price per accepted task, when a caller supplied a price list.
 *
 * Informational only, and stated as such: no branch of `judgeCompressionVariant`
 * reads it, and a test holds that two aggregates differing only in this field
 * produce identical verdicts. It exists so a report can quote a currency figure
 * when one is available without anybody being tempted to gate on a number whose
 * provenance is a provider's rate card rather than this run's telemetry.
 */
export interface CompressionActualCost {
  readonly baseline: number | undefined;
  readonly variant: number | undefined;
}

export interface CompressionVerdictEvidence {
  /** The version of the primary KPI's definition these numbers were computed under. */
  readonly costKpiVersion: number;
  readonly baselineBillableTokensPerAcceptedTask: number | undefined;
  readonly variantBillableTokensPerAcceptedTask: number | undefined;
  /** Movement, `variant - baseline`: negative is cheaper. Absent when either side is unmeasured. */
  readonly billableTokensPerAcceptedTaskDelta: number | undefined;
  readonly billableTokensPerAcceptedTaskRelativeDelta: number | undefined;
  /** The relative improvement the primary KPI had to clear to count as cheaper. */
  readonly costMaterialRelativeDelta: number;
  /** The safety KPI, published beside the primary one so the block is re-derivable. */
  readonly baselineRawTokensPerAcceptedTask: number | undefined;
  readonly variantRawTokensPerAcceptedTask: number | undefined;
  readonly rawTokensPerAcceptedTaskDelta: number | undefined;
  readonly rawTokensPerAcceptedTaskRelativeDelta: number | undefined;
  /** How far the raw stream may grow before the variant is blocked whatever it saved. */
  readonly rawTokensSafetyRelativeDelta: number;
  /** Absent unless a caller supplied a price list. Never read by the verdict. */
  readonly actualCostUsdPerVerifiedAcceptedTask?: CompressionActualCost;
  readonly predicates: readonly CompressionPredicateEvidence[];
}

export interface CompressionVariantVerdict {
  readonly variantId: string;
  readonly variantIdentity: string;
  readonly verdict: CompressionVerdict;
  /** Kebab-case, deduplicated and sorted, so two runs that concluded the same thing say it identically. */
  readonly reasons: readonly string[];
  readonly evidence: CompressionVerdictEvidence;
}

function valueOf(metric: MetricValue): number | undefined {
  return metric.value;
}

/** The reason an unmeasured metric carries, for a verdict that has to say what it lacked. */
function unmeasuredReasonOf(metric: MetricValue): string | undefined {
  return isMeasured(metric) ? undefined : metric.reason;
}

/** How one KPI moved from baseline to variant. Every field is absent whenever either side is. */
interface KpiMovement {
  readonly baseline: number | undefined;
  readonly variant: number | undefined;
  readonly delta: number | undefined;
  readonly relativeDelta: number | undefined;
}

function movementOf(baselineKpi: MetricValue, variantKpi: MetricValue): KpiMovement {
  const baseline = valueOf(baselineKpi);
  const variant = valueOf(variantKpi);
  if (baseline === undefined || variant === undefined) {
    return { baseline, variant, delta: undefined, relativeDelta: undefined };
  }
  return {
    baseline,
    variant,
    delta: variant - baseline,
    relativeDelta: baseline === 0 ? undefined : (variant - baseline) / Math.abs(baseline),
  };
}

function evaluatePredicate(
  predicate: CompressionPredicate,
  baseline: CompressionAggregate,
  variant: CompressionAggregate,
): CompressionPredicateEvidence {
  const baselineValue = valueOf(baseline.quality[predicate.metric]);
  const variantValue = valueOf(variant.quality[predicate.metric]);
  if (baselineValue === undefined || variantValue === undefined) {
    return {
      code: predicate.code,
      higherIsBetter: predicate.higherIsBetter,
      tolerance: predicate.tolerance,
      baseline: baselineValue,
      variant: variantValue,
      delta: undefined,
      regressed: false,
    };
  }
  const delta = predicate.higherIsBetter
    ? baselineValue - variantValue
    : variantValue - baselineValue;
  return {
    code: predicate.code,
    higherIsBetter: predicate.higherIsBetter,
    tolerance: predicate.tolerance,
    baseline: baselineValue,
    variant: variantValue,
    delta,
    regressed: delta > predicate.tolerance,
  };
}

/**
 * The verdict for one variant against the baseline.
 *
 * The rollup order is `rejected > not_measured > accepted`, and each step of it
 * is a refusal to round an answer up:
 *
 * - **Evidence of harm wins.** A measured regression is not weakened by other
 *   evidence being incomplete; a variant that raised the security failure rate
 *   is rejected whether or not anyone could total its tokens.
 * - **"We could not tell" is never resolved into a claim.** An unmeasured
 *   population, predicate or KPI yields `not_measured`, which is the honest
 *   answer and the one that blocks a rollout.
 * - **Not cheaper is rejected, not neutral.** The cohort exists to find a saving.
 *   A variant that changes nothing measurable has not earned the complexity it
 *   costs, and reporting it as `accepted` would let it be rolled out on the
 *   strength of having done no harm.
 * - **A cheaper bill does not buy an unbounded context.** The raw-stream safety
 *   bound sits in the same `regressed` branch as the quality predicates, so a
 *   variant that blew past it is rejected however large the billable saving was.
 */
export function judgeCompressionVariant(
  baseline: CompressionAggregate,
  variant: CompressionAggregate,
  actualCostUsdPerVerifiedAcceptedTask?: CompressionActualCost,
): CompressionVariantVerdict {
  const predicates = PREDICATES.map((predicate) =>
    evaluatePredicate(predicate, baseline, variant),
  );
  const billable = movementOf(
    baseline.billableTokensPerAcceptedTask,
    variant.billableTokensPerAcceptedTask,
  );
  const raw = movementOf(baseline.rawTokensPerAcceptedTask, variant.rawTokensPerAcceptedTask);
  const evidence: CompressionVerdictEvidence = {
    costKpiVersion: COMPRESSION_COST_KPI_VERSION,
    baselineBillableTokensPerAcceptedTask: billable.baseline,
    variantBillableTokensPerAcceptedTask: billable.variant,
    billableTokensPerAcceptedTaskDelta: billable.delta,
    billableTokensPerAcceptedTaskRelativeDelta: billable.relativeDelta,
    costMaterialRelativeDelta: COST_MATERIAL_RELATIVE_DELTA,
    baselineRawTokensPerAcceptedTask: raw.baseline,
    variantRawTokensPerAcceptedTask: raw.variant,
    rawTokensPerAcceptedTaskDelta: raw.delta,
    rawTokensPerAcceptedTaskRelativeDelta: raw.relativeDelta,
    rawTokensSafetyRelativeDelta: RAW_TOKENS_SAFETY_RELATIVE_DELTA,
    ...(actualCostUsdPerVerifiedAcceptedTask === undefined
      ? {}
      : { actualCostUsdPerVerifiedAcceptedTask }),
    predicates,
  };

  // A variant compared against itself measures nothing: the two aggregates are
  // the same population, and every delta would be zero by construction.
  if (variant.variant.identity === baseline.variant.identity) {
    return {
      variantId: variant.variant.id,
      variantIdentity: variant.variant.identity,
      verdict: "not_measured",
      reasons: ["variant-is-baseline"],
      evidence,
    };
  }

  const reasons: string[] = [];
  let regressed = false;
  let unmeasuredEvidence = false;

  if (baseline.quality.conclusiveCount === 0) {
    reasons.push("baseline-not-conclusive");
    unmeasuredEvidence = true;
  }
  if (variant.quality.conclusiveCount === 0) {
    reasons.push("variant-not-conclusive");
    unmeasuredEvidence = true;
  }

  for (const predicate of predicates) {
    if (predicate.delta === undefined) {
      reasons.push(`${predicate.code}-not-measured`);
      unmeasuredEvidence = true;
    } else if (predicate.regressed) {
      reasons.push(`${predicate.code}-regressed`);
      regressed = true;
    }
  }

  // The objective. `accepted` turns on this and nothing else being cheaper.
  let cheaper = false;
  if (billable.baseline === undefined || billable.variant === undefined) {
    reasons.push("billable-tokens-per-accepted-task-not-measured");
    const missing =
      unmeasuredReasonOf(baseline.billableTokensPerAcceptedTask) ??
      unmeasuredReasonOf(variant.billableTokensPerAcceptedTask);
    if (missing !== undefined) reasons.push(`usage-${missing}`);
    unmeasuredEvidence = true;
  } else if (billable.variant < billable.baseline * (1 - COST_MATERIAL_RELATIVE_DELTA)) {
    cheaper = true;
    reasons.push("billable-tokens-per-accepted-task-lower");
  } else {
    reasons.push("billable-tokens-per-accepted-task-not-lower");
  }

  // The safety bound. A raw stream nobody could total is a gap, not a pass: the
  // quantity the block exists to bound is precisely the one that went unmeasured.
  if (raw.baseline === undefined || raw.variant === undefined) {
    reasons.push("raw-tokens-per-accepted-task-not-measured");
    const missing =
      unmeasuredReasonOf(baseline.rawTokensPerAcceptedTask) ??
      unmeasuredReasonOf(variant.rawTokensPerAcceptedTask);
    if (missing !== undefined) reasons.push(`usage-${missing}`);
    unmeasuredEvidence = true;
  } else if (raw.variant > raw.baseline * (1 + RAW_TOKENS_SAFETY_RELATIVE_DELTA)) {
    reasons.push("raw-tokens-per-accepted-task-safety-exceeded");
    regressed = true;
  }

  const verdict: CompressionVerdict = regressed
    ? "rejected"
    : unmeasuredEvidence
      ? "not_measured"
      : cheaper
        ? "accepted"
        : "rejected";
  if (verdict === "accepted") reasons.push("quality-non-regressed");

  return {
    variantId: variant.variant.id,
    variantIdentity: variant.variant.identity,
    verdict,
    reasons: [...new Set(reasons)].sort(),
    evidence,
  };
}

/**
 * One verdict per non-baseline variant, in the cohort's declaration order.
 *
 * Declaration order rather than the order aggregates arrived in, so two runs of
 * the same cohort produce the same report line for line. A variant the caller
 * supplied no aggregate for is judged on an empty population — `not_measured`,
 * which is what a variant nobody ran is — rather than omitted, because a missing
 * row reads as a variant nobody declared.
 *
 * No single cohort-wide verdict is published: it would hide which feature earned
 * the number, and a rollout decision is taken one feature at a time.
 */
export function judgeCompressionCohort(
  aggregates: readonly CompressionAggregate[],
  cohort: readonly CompressionVariant[] = COMPRESSION_COHORT,
): readonly CompressionVariantVerdict[] {
  const byIdentity = new Map(
    aggregates.map((aggregate) => [aggregate.variant.identity, aggregate] as const),
  );
  const aggregateFor = (variant: CompressionVariant): CompressionAggregate =>
    byIdentity.get(variant.identity) ?? aggregateCompressionSamples(variant, []);

  const baselineVariant = cohort.find((variant) => variant.id === BASELINE_VARIANT_ID);
  if (baselineVariant === undefined) {
    throw new TypeError(
      `The cohort declares no "${BASELINE_VARIANT_ID}" variant, so nothing can be judged against it.`,
    );
  }
  const baseline = aggregateFor(baselineVariant);

  return cohort
    .filter((variant) => variant.identity !== baselineVariant.identity)
    .map((variant) => judgeCompressionVariant(baseline, aggregateFor(variant)));
}
