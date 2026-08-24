/**
 * One host command run inside a session worktree, reduced to its outcome.
 *
 * The port is deliberately narrow in one direction: the child's terminal output
 * never crosses it. A quality gate runs the repository's own build and test
 * commands, so its output carries host paths, source fragments and — for a
 * failing test that printed a fixture — whatever the repository happens to hold
 * in memory. Recorded evidence is read back by an operator over a phone-facing
 * surface, so "no terminal text in the evidence" has to be a property of the
 * TYPE rather than a redaction step somebody remembers to apply.
 *
 * What the port returns is therefore facts only: did the process start, did it
 * finish, with what exit code, and how long it took. Whether those facts mean a
 * gate passed is decided by `session-gate-policy.ts`, which keeps the judgement
 * in one testable place instead of in every adapter.
 */

export type GateCommandRunRequest = Readonly<{
  /** Absolute worktree root; it becomes the child's working directory. */
  cwd: string;
  /** Absolute path to the program. A bare name is never accepted. */
  executable: string;
  args: readonly string[];
  timeoutMs: number;
}>;

export type GateCommandOutcome = Readonly<{
  /** Absent when the process never exited on its own. */
  exitCode?: number;
  timedOut: boolean;
  startFailed: boolean;
  durationMs: number;
}>;

export interface GateCommandRunnerPort {
  /**
   * Runs one command and reports how it ended. A red gate is an outcome, not an
   * exception: this never rejects for a command that simply failed.
   */
  run(request: GateCommandRunRequest): Promise<GateCommandOutcome>;
}
