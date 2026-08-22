import {
  assessComparability,
  comparabilityRefusalCodes,
  type ComparabilityAssessment,
} from "../../domain/baseline/compatibility.js";
import type { BaselineManifest } from "../../domain/baseline/manifest.js";
import type { BenchmarkComparison } from "../../domain/verdict.js";

/**
 * The gate every comparison passes through (BENCH-8, BENCH-9).
 *
 * Nothing may read a baseline's metrics beside a current run's until this
 * returns `ok`. The refusal is not an error and not an exception: it is a
 * `BenchmarkComparison` whose verdict is `inconclusive`, carrying the refusal
 * codes as its reasons and the details as its limitations, so a CLI, a report
 * and the UI all publish the same authoritative object whether the comparison
 * happened or not (BENCH-10, BENCH-11).
 *
 * `inconclusive` rather than `stable` is the whole point. "We could not tell"
 * and "nothing changed" are the same shape of answer and opposite pieces of
 * evidence, and a release gate reading the second when the first was true would
 * pass a benchmark that never ran.
 */

export type ComparisonGate =
  | {
      readonly ok: true;
      /** Advisory differences the report must show beside the verdict. */
      readonly limitations: readonly string[];
    }
  | { readonly ok: false; readonly comparison: BenchmarkComparison };

/**
 * The comparison a refused pair produces: no scenario, no verdict but
 * `inconclusive`, and every reason it was refused.
 */
export function refusedComparison(assessment: ComparabilityAssessment): BenchmarkComparison {
  return {
    verdict: "inconclusive",
    // Bare codes: a report groups on them, and a code with a field spliced in is
    // a code no two comparisons ever share. The field travels in `limitations`.
    reasons: comparabilityRefusalCodes(assessment),
    scenarios: [],
    limitations: [
      ...assessment.refusals.map((refusal) => `${refusal.subject}: ${refusal.detail}`),
      ...assessment.limitations,
      "no scenario was compared: the pair was refused before any metric was read",
    ],
  };
}

/** Opens a comparison, or refuses it with the reasons why. */
export function guardComparison(
  baseline: BaselineManifest,
  current: BaselineManifest,
): ComparisonGate {
  const assessment = assessComparability(baseline, current);
  if (!assessment.comparable) return { ok: false, comparison: refusedComparison(assessment) };
  return { ok: true, limitations: assessment.limitations };
}
