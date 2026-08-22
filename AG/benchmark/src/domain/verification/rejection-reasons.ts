/**
 * Structured rejection reasons (BENCH-6).
 *
 * `AcceptanceDecision.reasons` carries bare kebab-case codes, because a report
 * groups on them and a code with a detail spliced into it is a code no two
 * samples ever share. The detail is not lost: every code raised here is paired
 * with the file, check or pattern that raised it and travels alongside the
 * decision as evidence, so a rejection can be read without re-running anything.
 *
 * The codes are also split by what they mean about the *measurement* rather than
 * about the run. A rejection says the verifier looked and the run did not meet
 * the scenario's bar. An inconclusive says the verifier could not look — a check
 * that crashed, a scope pattern it cannot interpret, evidence that never
 * arrived. BENCH-5 forbids folding the second into the first: an unverifiable
 * run counted as a failed one would make the numbers most flattering exactly
 * when the harness was least reliable.
 */

export const ACCEPTANCE_REJECTION_CODES = {
  /** The scenario required a change and the run produced none. */
  emptyChange: "empty-change",
  /** A changed file lies outside every declared `allowedPaths` entry. */
  outOfScopeChange: "out-of-scope-change",
  /** A changed file is covered by a declared `forbiddenPaths` entry. */
  forbiddenPathChanged: "forbidden-path-changed",
  /** A forbidden path was changed in a scenario whose forbidden set states an architecture boundary. */
  architectureBoundaryViolated: "architecture-boundary-violated",
  /** A forbidden path was changed in a scenario whose forbidden set states a security boundary. */
  securityBoundaryViolated: "security-boundary-violated",
  /** A declared check ran and did not do what the scenario said it would. */
  checkFailed: "check-failed",
  /** What the run factually did is not what the scenario declared a correct run does. */
  outcomeMismatch: "outcome-mismatch",
  /** A changed path is not workspace-relative, so it landed somewhere no scope declaration reaches. */
  unsafeChangedPath: "unsafe-changed-path",

  // Fail-closed codes below: the verifier could not decide, so nothing is accepted.

  /** The run left no usable evidence to verify — no checkout, no capture, a harness failure. */
  evidenceMissing: "evidence-missing",
  /** A declared check produced no verdict: it was never executed, or its result never arrived. */
  checkNotRun: "check-not-run",
  /** A declared check crashed, timed out or was killed, so it reported neither pass nor fail. */
  checkErrored: "check-errored",
  /** A declared scope pattern this version cannot interpret; scope stays undecided. */
  unsupportedScopePattern: "unsupported-scope-pattern",
  /** A scenario declares no check, so there is nothing to verify a change against. */
  noChecksDeclared: "no-checks-declared",
  /** A declared check uses an id the verifier reserves for its own gates; results could not be told apart. */
  checkIdConflict: "check-id-conflict",
} as const;

export type AcceptanceRejectionCode =
  (typeof ACCEPTANCE_REJECTION_CODES)[keyof typeof ACCEPTANCE_REJECTION_CODES];

/**
 * The codes that mean the verifier could not reach a verdict, as opposed to
 * reaching a negative one. Any of them makes the decision `inconclusive`, and
 * `inconclusive` outranks `rejected`: once one gate could not be evaluated, the
 * gates that could are no longer a complete account of the run.
 */
export const INCONCLUSIVE_REJECTION_CODES: ReadonlySet<AcceptanceRejectionCode> = Object.freeze(
  new Set<AcceptanceRejectionCode>([
    ACCEPTANCE_REJECTION_CODES.evidenceMissing,
    ACCEPTANCE_REJECTION_CODES.checkNotRun,
    ACCEPTANCE_REJECTION_CODES.checkErrored,
    ACCEPTANCE_REJECTION_CODES.unsupportedScopePattern,
    ACCEPTANCE_REJECTION_CODES.noChecksDeclared,
    ACCEPTANCE_REJECTION_CODES.checkIdConflict,
  ]),
);

export function isInconclusiveCode(code: AcceptanceRejectionCode): boolean {
  return INCONCLUSIVE_REJECTION_CODES.has(code);
}

/** One reason a run was not accepted, with the thing that raised it. */
export interface RejectionReason {
  readonly code: AcceptanceRejectionCode;
  /** The file, check id or pattern this reason is about; empty when it is about the run as a whole. */
  readonly subject: string;
  /** Human-readable explanation. Never parsed — the code is what anything downstream groups on. */
  readonly detail: string;
}

/** The codes of `reasons`, deduplicated, in the order the gates raised them. */
export function rejectionReasonCodes(
  reasons: readonly RejectionReason[],
): readonly AcceptanceRejectionCode[] {
  return [...new Set(reasons.map((reason) => reason.code))];
}
