/**
 * The single seam through which an execution adapter starts an external agent.
 *
 * Two reasons it is a port rather than a direct `spawn`:
 *
 * - **A benchmark must be testable without the thing it benchmarks.** Every
 *   adapter behaviour worth asserting — a refusal to reach the network, a
 *   timeout, a missing telemetry envelope, a token limit exceeded — is about
 *   what the adapter does with a process result, not about the process. Behind a
 *   port those cases are stated directly; behind a real spawn they would need a
 *   model, a network and a paid call each.
 * - **The spawn surface stays reviewable in one file.** No shell, an explicit
 *   environment, a mandatory timeout and a bounded output live in the one
 *   implementation of this port instead of at each adapter's call site.
 */

export interface AgentProcessSpec {
  /** Program to execute. Never a shell string — arguments are passed as a vector. */
  readonly command: string;
  readonly args: readonly string[];
  /** Absolute working directory: the isolated checkout, and nothing above it. */
  readonly cwd: string;
  /**
   * Mandatory, and taken from the scenario's normalized limits. A benchmark that
   * can hang has no worst case, and a hang is indistinguishable from a slow
   * agent in the numbers afterwards.
   */
  readonly timeoutMs: number;
  /**
   * The complete environment for the child, composed by the caller. Implementations
   * add only what a process needs to start at all; a credential is forwarded because
   * an adapter was configured to forward it, never because it happened to be set.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Written to the child's standard input, which is then closed. */
  readonly stdin: string;
}

export interface AgentProcessResult {
  /** Null when the process was killed or could not be started. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Raw standard output; the telemetry envelope is read from it and it is never stored. */
  readonly stdout: string;
  /** Redacted by the implementation: an agent echoes its own configuration on failure. */
  readonly stderr: string;
  /** True when {@link AgentProcessSpec.timeoutMs} elapsed and the process was killed. */
  readonly timedOut: boolean;
  /** True when either stream reached the implementation's output ceiling and was cut. */
  readonly outputTruncated: boolean;
  /**
   * NOTE: a tree that could not be confirmed gone is not reported here.
   *
   * It was, briefly, and the field was wrong: `false` is the only value a caller could ever read,
   * because the runner now rejects with `AgentProcessTreeAbandonedError` instead of returning. A
   * surviving agent keeps calling a paid model outside its cell, and a boolean on a result the
   * caller is free to ignore is not the shape that fact should take.
   */
}

/**
 * Raised when a killed process tree was not confirmed gone.
 *
 * Declared on the PORT, not in the adapter that throws it, because the layer that must not catch
 * it lives here. `IsolatedSampleRunner` catches everything an adapter throws and turns it into an
 * unmeasured cell — right for an adapter that stopped being able to report, and wrong for this:
 * the thing that survived is a paid agent, and continuing means starting the next cell beside a
 * process that is still calling a model. The runner re-throws this one, and nothing above it
 * catches, so the run stops.
 *
 * An error rather than a field on the result for the same reason: a boolean a caller is free to
 * ignore does not stop anything.
 */
export class AgentProcessTreeAbandonedError extends Error {
  constructor(pid: number, waitedMs: number) {
    super(
      `The process tree of pid ${pid} was not confirmed gone within ${waitedMs}ms of the kill. ` +
        "A surviving agent keeps calling a paid model outside the cell it belonged to, so the run " +
        "stops here rather than starting another one beside it.",
    );
    this.name = "AgentProcessTreeAbandonedError";
  }
}

export interface AgentProcessPort {
  /**
   * Runs the process to completion. A process that ran and failed is a result,
   * not an exception; only being unable to run one at all — which is the harness
   * failing, not the agent — rejects.
   */
  run(spec: AgentProcessSpec): Promise<AgentProcessResult>;
}
