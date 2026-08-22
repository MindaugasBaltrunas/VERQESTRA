/**
 * Regression thresholds (BENCH-9).
 *
 * These are policy, not measurement. The spec fixes the verdict vocabulary and
 * the rule that a new security or out-of-scope violation is always a regression,
 * but it names no number for "materially cheaper" or "materially worse", so the
 * numbers are chosen here and stated once. They are exported rather than inlined
 * so a report can print the threshold beside the delta it was judged against: a
 * verdict a reader cannot re-derive from the published numbers is not traceable
 * to its inputs (BENCH-10).
 *
 * Both are deliberately loose. Agent runs vary between repetitions, and a gate
 * that fires on a few percent of movement would report a regression every time
 * the model happened to take one more turn. A threshold set below the noise
 * floor does not make a benchmark more sensitive; it makes its verdicts
 * meaningless, and a meaningless red gate is one a team learns to ignore.
 *
 * Changing either number changes what past comparisons would have concluded, so
 * a change belongs in the same commit as the reasoning for it.
 */

/**
 * How far the share of verified-accepted runs must move before it is treated as
 * a signal. Ten points is roughly one run in ten — below that, a suite of a few
 * repetitions cannot distinguish a capability change from which side of a
 * borderline check a single run landed on.
 */
export const SUCCESS_RATE_MATERIAL_DELTA = 0.1;

/**
 * How far the median cost must move, relative to the baseline median, before it
 * is treated as a signal. Relative rather than absolute because the scenarios
 * differ in size by orders of magnitude: a thousand extra tokens is noise on a
 * refactor and a doubling on a docs change.
 */
export const COST_MATERIAL_RELATIVE_DELTA = 0.1;

/**
 * How far the *raw* token stream — input + output + cache read + cache creation
 * — may grow above the baseline before a variant is refused whatever it saved
 * on the bill (task 0040).
 *
 * This threshold guards a different quantity from the one above, which is why it
 * is a separate number rather than a reuse. `COST_MATERIAL_RELATIVE_DELTA` asks
 * *is this cheaper*, judged on billable tokens; this one asks *did the run
 * become dangerous*, judged on the raw stream the dispatch budget watchdog and
 * the provider's rate limit actually see. A variant can be genuinely cheaper and
 * still be unrunnable, because a context that grew fivefold collides with the
 * turn budget long before it collides with the invoice.
 *
 * Deliberately looser than the cost threshold. The whole point of judging on
 * billable tokens is that shifting prompt text into a cached prefix is a real
 * saving, and every such shift inflates the raw stream — each turn re-reads what
 * the cache holds. A cap near the noise floor would reject exactly the variants
 * this KPI exists to admit. Half again is the point at which the growth stops
 * looking like cache reuse and starts looking like a context nobody bounded.
 *
 * Changing this number changes which variants past runs would have blocked, so a
 * change belongs in the same commit as the reasoning for it.
 */
export const RAW_TOKENS_SAFETY_RELATIVE_DELTA = 0.5;
