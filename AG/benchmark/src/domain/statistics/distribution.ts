import type { DistributionStatistics } from "../verdict.js";

/**
 * Repeated-measurement statistics (BENCH-9).
 *
 * A pure, total fold from the numbers one `scenario × mode` produced across its
 * repetitions to the median, mean, min, max, spread and success count a report
 * publishes. It reads nothing, times nothing and randomises nothing, for the
 * same reason `metrics/aggregate.ts` does not: a distribution whose value
 * depends on the order the runner happened to finish in cannot be compared
 * against itself across runs, which is the only thing BENCH-9 exists to do.
 *
 * ## Order independence
 *
 * Every sum here is taken over a sorted copy rather than over the argument in
 * arrival order. Floating-point addition is not associative — the same tokens
 * counted in a different order can differ in the last bits — and a benchmark
 * that reports a different standard deviation for the same runs depending on
 * which worker returned first would manufacture regressions out of scheduling.
 * Sorting is needed for the median anyway, so the guarantee is free.
 *
 * ## Population, not sample, standard deviation
 *
 * The spread divides by `N`, not by `N − 1`. The repetitions are not a sample
 * drawn from some larger population whose variance is being estimated: they are
 * the entire population that was measured, and the question asked of them is how
 * far these runs sat from their own mean. `N − 1` would also divide by zero for
 * a single repetition and report `NaN` where the correct answer is `0` — one
 * observation exhibits no spread, which is a fact and not a missing value.
 *
 * ## Fail-closed
 *
 * Any observation that is not finite refuses the whole distribution instead of
 * being dropped, clamped or repaired. A `NaN` that reached this far came from a
 * record nobody validated, and a median computed from the survivors of such a
 * set is a number that looks like a measurement and is not — the same rule
 * `metric-value.ts` applies to its totals.
 */

/**
 * Why a distribution has no statistics. Ordered by what the refusal is about:
 * nothing was observed, then something was observed that arithmetic cannot be
 * trusted on, then the success count contradicts the observations it counts.
 */
export const DISTRIBUTION_REFUSAL_REASONS = [
  "no-observations",
  "unreliable-observation",
  "success-count-out-of-range",
] as const;

export type DistributionRefusalReason = (typeof DISTRIBUTION_REFUSAL_REASONS)[number];

/**
 * A distribution, or the reason there is none. A refusal is a value rather than
 * a throw so a caller can turn it into a limitation and an `inconclusive`
 * verdict, which is what BENCH-9 asks for when the evidence is too thin.
 */
export type DistributionSummary =
  | { readonly ok: true; readonly statistics: DistributionStatistics }
  | {
      readonly ok: false;
      readonly reason: DistributionRefusalReason;
      /** Human-readable explanation of `reason` in this distribution's own terms. Never parsed. */
      readonly detail: string;
    };

function refuse(reason: DistributionRefusalReason, detail: string): DistributionSummary {
  return { ok: false, reason, detail };
}

/** The middle value, or the mean of the two middle values for an even count. */
function medianOf(sorted: readonly number[]): number {
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function sumOf(sorted: readonly number[], term: (value: number) => number): number {
  return sorted.reduce((total, value) => total + term(value), 0);
}

/**
 * The statistics of one repeated measurement, or the reason it has none.
 *
 * `successCount` is passed in rather than derived: this module knows only
 * numbers, and which of them came from a run the verifier accepted is a
 * question about samples, answered one module up. It is
 * still validated against the observations, because a success count larger than
 * the number of runs it is drawn from means the two arguments describe
 * different populations, and every rate computed from them afterwards would be
 * wrong in a way no later check could see.
 */
export function summarizeDistribution(
  values: readonly number[],
  successCount: number,
): DistributionSummary {
  const count = values.length;
  if (count === 0) {
    return refuse("no-observations", "no observation was recorded for this distribution");
  }

  // `findIndex`, not `find`: a hole or an `undefined` reaching this far from a
  // record nobody validated is not a finite number either, and `find` reports
  // exactly that value as "nothing was found" — the one guard that exists to
  // stop such an input would wave it through.
  const unreliableIndex = values.findIndex((value) => !Number.isFinite(value));
  if (unreliableIndex !== -1) {
    return refuse(
      "unreliable-observation",
      `one of the ${count} observation(s) is ${String(values[unreliableIndex])}, ` +
        "which is not a finite number, so no statistic may be computed from the set",
    );
  }

  if (!Number.isInteger(successCount) || successCount < 0 || successCount > count) {
    return refuse(
      "success-count-out-of-range",
      `${successCount} success(es) were reported for ${count} observation(s), ` +
        "so the two arguments do not describe the same population",
    );
  }

  // Sorted once: the median needs the order, and every sum below inherits the
  // determinism from it (see the module note on order independence).
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sumOf(sorted, (value) => value) / count;
  const standardDeviation = Math.sqrt(sumOf(sorted, (value) => (value - mean) ** 2) / count);

  // Finite observations can still add up to `Infinity`, and a mean of `Infinity`
  // poisons the spread silently. Refused rather than reported, for the same
  // reason a non-finite observation is.
  if (!Number.isFinite(mean) || !Number.isFinite(standardDeviation)) {
    return refuse(
      "unreliable-observation",
      `the ${count} observation(s) add up beyond the largest finite number, ` +
        "so their mean and spread would not be measurements",
    );
  }

  return {
    ok: true,
    statistics: {
      count,
      median: medianOf(sorted),
      mean,
      min: sorted[0],
      max: sorted[count - 1],
      standardDeviation,
      successCount,
    },
  };
}
