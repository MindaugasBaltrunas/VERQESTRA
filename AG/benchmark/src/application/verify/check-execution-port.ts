/**
 * The seam through which the verifier re-runs a scenario's declared checks.
 *
 * Separate from the port an execution adapter starts an agent through, because
 * the two carry different authority. An agent is handed a task, an environment
 * the caller composed and possibly a credential; a check is a command the frozen
 * suite declared, run over a checkout, and it needs none of that. Narrowing the
 * request to the four fields a check actually has keeps the verifier from being
 * able to hand a scenario's command anything an agent was given.
 *
 * Behind a port rather than a spawn for the usual reason: what the verifier
 * concludes from a crashed, timed-out or non-zero check is the behaviour worth
 * asserting, and a test states those directly instead of arranging for a real
 * process to produce each one.
 */

export interface CheckExecutionRequest {
  /** Program to execute. An argument vector, never a shell string. */
  readonly command: string;
  readonly args: readonly string[];
  /** Absolute path of the isolated checkout the check runs over. */
  readonly cwd: string;
  /** Mandatory: a check that can hang would make the verdict wait on it forever. */
  readonly timeoutMs: number;
}

export interface CheckExecutionResult {
  /** Null when the process was killed or never produced a status. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** Combined output, redacted and bounded by the implementation; kept only as failure detail. */
  readonly output: string;
}

export interface CheckExecutionPort {
  /**
   * Runs the check to completion. A check that ran and failed is a result; only
   * being unable to run one at all — a refused command, a missing checkout —
   * rejects, because that is the verifier failing rather than the change.
   */
  run(request: CheckExecutionRequest): Promise<CheckExecutionResult>;
}
