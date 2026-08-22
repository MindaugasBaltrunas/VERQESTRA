import type { ComparisonVerdict } from "../verdict.js";

/**
 * The one priority chain of the comparison feature (BENCH-9).
 *
 * `regressed` outranks `inconclusive`, which outranks `improved`, which outranks
 * `stable`. Both levels of the comparison — the findings inside one scenario and
 * the scenarios inside one benchmark — resolve their verdict through this single
 * ranking, because two chains would eventually disagree: a scenario that both
 * improved and produced an undivided cost would publish `improved` while the
 * benchmark rolling it up would have called the same evidence `inconclusive`,
 * and the stricter reading would be lost at exactly the level a reader looks at.
 *
 * The middle ordering is the one that matters and it is the argument
 * `application/baseline/comparability-gate.ts` makes: "we could not tell" and
 * "nothing changed" have the same shape and opposite evidence, so evidence we
 * could not judge must never be resolved into a quieter verdict. `regressed`
 * still outranks it, because evidence of harm is not weakened by other evidence
 * being incomplete.
 */
const VERDICT_RANK: Readonly<Record<ComparisonVerdict, number>> = {
  regressed: 3,
  inconclusive: 2,
  improved: 1,
  stable: 0,
};

/**
 * The strongest verdict among `verdicts`, or `stable` for none.
 *
 * Ties keep the earliest, so a caller that passes its verdicts in rule order
 * gets that order as the tie-breaker without stating it twice.
 */
export function strongestVerdict(verdicts: readonly ComparisonVerdict[]): ComparisonVerdict {
  return verdicts.reduce<ComparisonVerdict>(
    (strongest, verdict) => (VERDICT_RANK[verdict] > VERDICT_RANK[strongest] ? verdict : strongest),
    "stable",
  );
}
