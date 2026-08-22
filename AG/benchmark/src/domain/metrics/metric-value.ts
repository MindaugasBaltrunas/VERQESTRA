/**
 * Metric values that can say "not measured" (BENCH-7).
 *
 * Every benchmark metric is a quotient, and a quotient over an empty denominator
 * has no value. The three numbers JavaScript offers there — `0`, `NaN` and
 * `Infinity` — each lie in a different direction: `0` reads as "measured and
 * bad", `NaN` propagates silently through any later arithmetic, and `Infinity`
 * reads as "measured and infinitely bad". BENCH-7 therefore requires the absent
 * value to be `undefined`, and this module makes that the only reachable shape:
 * a value is produced by {@link measure}, which cannot return a number without a
 * denominator to divide by.
 *
 * `undefined` alone would still lose the interesting part, which is *why*
 * nothing was measured — a suite nobody ran and a suite where every sample was
 * unverifiable are both "no accepted rate", and a reader has to be able to tell
 * them apart without re-reading the samples. So an unmeasured value carries a
 * machine-readable {@link UnmeasuredReason} and the counts it was refused on.
 *
 * The module is pure and total: same numbers in, same value out, no throw.
 */

/**
 * Why a metric has no value.
 *
 * The first three are about the population the metric was asked to describe,
 * ordered by how much was recorded: nothing at all, then records that exist but
 * cannot be verified, then records that cannot answer this particular question
 * however sound they are. The next two are about a cost metric whose
 * denominator counts changes rather than samples. Then the population whose real
 * token usage was never captured, so no token total may be summed over it at
 * all. The last is the fail-closed case: a total that arithmetic can no longer
 * be trusted on is reported as unmeasured rather than as the imprecise number it
 * would otherwise become.
 */
export const UNMEASURED_REASONS = [
  "no-samples",
  "no-conclusive-samples",
  "no-applicable-samples",
  "no-accepted-change",
  "no-verified-accepted-change",
  "no-captured-usage",
  "unreliable-total",
] as const;

export type UnmeasuredReason = (typeof UNMEASURED_REASONS)[number];

/** The numerator and denominator a metric was computed from, kept so a reported value is traceable to its inputs (BENCH-10). */
export interface MetricCounts {
  readonly numerator: number;
  readonly denominator: number;
}

export interface MeasuredMetric extends MetricCounts {
  /** The quotient. Always finite: {@link measure} refuses every input that could produce anything else. */
  readonly value: number;
}

export interface UnmeasuredMetric extends MetricCounts {
  readonly value: undefined;
  readonly reason: UnmeasuredReason;
  /** Human-readable explanation of `reason` in this metric's own terms. Never parsed. */
  readonly detail: string;
}

/**
 * A metric value. `value` is present on both members, so a consumer that only
 * wants the number reads `metric.value` and gets `number | undefined`; one that
 * wants the explanation narrows on `value === undefined` and reaches `reason`.
 */
export type MetricValue = MeasuredMetric | UnmeasuredMetric;

/** What to report when the denominator turns out to be empty. */
export interface UnmeasuredCause {
  readonly reason: UnmeasuredReason;
  readonly detail: string;
}

export function isMeasured(metric: MetricValue): metric is MeasuredMetric {
  return metric.value !== undefined;
}

export function unmeasured(cause: UnmeasuredCause, counts: MetricCounts): UnmeasuredMetric {
  return {
    value: undefined,
    numerator: counts.numerator,
    denominator: counts.denominator,
    reason: cause.reason,
    detail: cause.detail,
  };
}

/**
 * The only way to obtain a metric value.
 *
 * A positive denominator yields the quotient; an empty one yields `cause`. Both
 * counts are required to be safe integers first: a count that overflowed the
 * exact integer range, or a `NaN` that reached this far from a record nobody
 * validated, would divide into a number that looks like a measurement and is
 * not. That case is reported as `unreliable-total` rather than repaired, in
 * keeping with the fail-closed rule the rest of the package validates under,
 * and it outranks `cause`: when the numbers themselves cannot be trusted, why
 * the denominator was empty is no longer a question worth answering.
 */
export function measure(
  numerator: number,
  denominator: number,
  cause: UnmeasuredCause,
): MetricValue {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    return unmeasured(
      {
        reason: "unreliable-total",
        detail:
          `the metric was asked for ${numerator} over ${denominator}, ` +
          "which is not a pair of exact integers, so the quotient would not be a measurement",
      },
      { numerator, denominator },
    );
  }
  if (denominator <= 0) return unmeasured(cause, { numerator, denominator });
  return { value: numerator / denominator, numerator, denominator };
}

/**
 * The sum of `values`, or a value no metric may be computed from.
 *
 * Addition over exact integers is associative, so the result does not depend on
 * the order samples arrived in — the determinism BENCH-9 compares runs under.
 * That property is what makes the guard necessary rather than paranoid: two
 * fractional terms can sum to a whole number, and to a *different* whole number
 * depending on the order they were added in, so a term that is not a safe
 * integer poisons the total whether or not the total looks sound afterwards.
 * Such a sum, and one that leaves the exact integer range, are returned as a
 * value {@link measure} refuses rather than rounded into a plausible-looking
 * total. Stored samples are validated to hold integers here; this function is
 * also reachable with records that were only ever held in memory.
 */
export function totalOf(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) return Number.NaN;
    total += value;
  }
  return total;
}
