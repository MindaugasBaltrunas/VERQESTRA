/**
 * The exit codes `ag benchmark` answers with (BENCH-10).
 *
 * A benchmark is read by machines — a CI job, the release gate of BENCH-12, a
 * scheduled workflow — before it is read by a person, and those readers have to
 * separate "the measurement says no" from "the measurement did not happen".
 * Collapsing the two into a single non-zero code is how a harness failure gets
 * filed as a regression, or worse, how an unrun benchmark passes a gate because
 * nothing crashed.
 *
 * So each code answers exactly one question:
 *
 * - `ok` — the command did what it was asked and the verdict, if any, was
 *   acceptable.
 * - `gateNotPassed` — the command ran, produced an authoritative verdict, and
 *   that verdict was `regressed`. This is the same contract `ag
 *   optimization-benchmark --compare-baseline` already publishes: exit 1 means
 *   "report computed, gate not passed", never "tool error".
 * - `usageError` — the invocation itself was wrong. Nothing was measured, and
 *   nothing about the suite is implied.
 * - `validationFailed` — inputs were read and refused: an invalid suite, an
 *   unknown scenario id, a repetition count BENCH-9 forbids. The refusal is a
 *   statement about the inputs, not about the code under measurement.
 * - `inconclusive` — the command ran but the evidence does not support a
 *   verdict: an incomparable baseline, a run that produced no measurable sample,
 *   an acceptance that could not be re-derived. Distinct from `gateNotPassed`
 *   because "we could not tell" and "it got worse" are opposite pieces of
 *   evidence that a release gate must never conflate.
 * - `infrastructureError` — the harness failed. Git, the filesystem, a process,
 *   or a capability that is wired but not yet executable. No conclusion about
 *   the suite or the measured system may be drawn from it.
 */
export const BENCHMARK_EXIT_CODES = {
  ok: 0,
  gateNotPassed: 1,
  usageError: 2,
  validationFailed: 3,
  inconclusive: 4,
  infrastructureError: 5,
} as const;

export type BenchmarkExitCodeName = keyof typeof BENCHMARK_EXIT_CODES;

export type BenchmarkExitCode = (typeof BENCHMARK_EXIT_CODES)[BenchmarkExitCodeName];

/**
 * One line per code, rendered into `--help` so the contract a caller scripts
 * against is visible from the CLI itself rather than only from this file.
 */
export const BENCHMARK_EXIT_CODE_MEANINGS: Readonly<Record<BenchmarkExitCodeName, string>> =
  Object.freeze({
    ok: "the command completed and no gate was violated",
    gateNotPassed: "a verdict was computed and it is a regression",
    usageError: "the invocation was rejected; nothing was measured",
    validationFailed: "the inputs were refused (invalid suite, unknown scenario, forbidden repetitions)",
    inconclusive: "the command ran but the evidence does not support a verdict",
    infrastructureError: "the harness failed; no conclusion may be drawn",
  });
