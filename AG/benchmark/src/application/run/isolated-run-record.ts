import type {
  ExecutionMode,
  SampleCompressionRecord,
  SampleTelemetry,
  SampleUsageRecord,
  WorktreeCleanupResult,
} from "../../domain/result.js";
import type { IsolatedWorktree, WorktreePort } from "../ports/worktree-port.js";

/**
 * What one isolated execution leaves behind (BENCH-4).
 *
 * `SampleWorkspaceRecord` in the domain holds the fields a stored sample carries
 * forward; this record holds what the *runner* observed, which is deliberately
 * larger. A benchmark result is only worth as much as the evidence behind it, so
 * the run layer keeps the base and final object ids, the diff between them, the
 * files that moved, how long it took, how the execution ended and what happened
 * to the checkout afterwards. Scope classification and the acceptance verdict
 * are not here: they belong to the independent verifier, and a runner that
 * judged its own run would be the thing BENCH-6 exists to prevent.
 */

/**
 * How an execution ended, as the harness saw it.
 *
 * The distinction that matters is the last one. `agent-failed` is a measurement:
 * the agent ran under the declared limits and did not succeed, which is a result
 * the benchmark is there to record. `harness-failed` is the absence of a
 * measurement — the worktree could not be made, the adapter threw, the capture
 * did not complete — and it must never be counted as an agent's outcome.
 */
export const SAMPLE_RUN_EXITS = ["completed", "agent-failed", "harness-failed"] as const;

export type SampleRunExit = (typeof SAMPLE_RUN_EXITS)[number];

/**
 * The recorded diff between the base and final commits.
 *
 * Bounded, because a single runaway change would otherwise decide how large
 * every stored run record is. `truncated` states that the bound was reached, so
 * a reader never mistakes a cut-off diff for a small change; `changedFiles`
 * stays complete regardless, which keeps the scope analysis exact even when the
 * text is not.
 */
export interface WorktreeDiff {
  /** Unified diff, redacted before storage. Empty when nothing changed or the diff could not be read. */
  readonly text: string;
  readonly truncated: boolean;
  /** Byte length of the diff as Git produced it, before truncation. */
  readonly byteLength: number;
}

/** The isolation evidence of one execution: where it started, where it ended, what moved. */
export interface IsolatedWorkspaceCapture {
  readonly baseCommit: string;
  /**
   * The commit the work ends at. Equal to `baseCommit` exactly when the agent
   * changed nothing — the runner commits whatever the agent left behind onto the
   * sample's own branch, so "no final commit" and "no change" are the same fact.
   */
  readonly finalCommit: string;
  /** Repository-relative, POSIX-separated, sorted; complete even when the diff is truncated. */
  readonly changedFiles: readonly string[];
  readonly diff: WorktreeDiff;
}

/**
 * Nothing observed: the shape a record carries when a checkout was never usable.
 * Frozen through, because it is shared by every such record and a mutation would
 * rewrite runs that already finished.
 */
export const UNOBSERVED_WORKSPACE: IsolatedWorkspaceCapture = Object.freeze({
  baseCommit: "",
  finalCommit: "",
  changedFiles: Object.freeze([]) as readonly string[],
  diff: Object.freeze({ text: "", truncated: false, byteLength: 0 }),
});

/**
 * The outcome of cleanup, with the reason it reached that outcome.
 *
 * `WorktreeCleanupResult` alone cannot be acted on: `kept-for-diagnosis` because
 * a run crashed and `kept-for-diagnosis` because the checkout was still dirty
 * call for different responses, and `failed` is useless without saying what was
 * refused. The reason is machine-readable and prefixed with a stable code.
 */
export interface IsolatedCleanupOutcome {
  readonly result: WorktreeCleanupResult;
  /** `<code>: <detail>`; empty only when the worktree was removed. */
  readonly reason: string;
}

/**
 * The isolation port as the runner uses it: {@link WorktreePort} plus the two
 * operations that produce and dispose of evidence. The narrower port stays the
 * published contract; this extension is what an implementation must satisfy to
 * drive a run.
 */
export interface IsolatedWorkspacePort extends WorktreePort {
  /**
   * Commits whatever the execution left in the worktree onto the sample's own
   * branch and reports the resulting evidence. Never touches any other branch.
   */
  capture(worktree: IsolatedWorktree): Promise<IsolatedWorkspaceCapture>;
  /** Cleanup that reports why. Refuses any path it did not create, and never forces. */
  cleanupIsolated(worktree: IsolatedWorktree): Promise<IsolatedCleanupOutcome>;
}

/** One isolated execution, start to finish. Everything a stored sample is later derived from. */
export interface IsolatedSampleRun {
  readonly scenarioId: string;
  readonly mode: ExecutionMode;
  /** 1-based, as BENCH-9 counts repetitions. */
  readonly repetition: number;
  /** The worktree this ran in; empty when one could not be created. */
  readonly worktreeId: string;
  /** Absolute worktree path, kept so a `kept-for-diagnosis` record says where the evidence is. */
  readonly worktreePath: string;
  readonly startedAt: string;
  /** Wall-clock duration of the whole isolated execution, including setup and capture. */
  readonly durationMs: number;
  /** Duration the adapter reported for the agent alone; `0` when the agent never ran. */
  readonly agentDurationMs: number;
  readonly exit: SampleRunExit;
  /** Redacted failure description; empty when `exit` is `completed`. */
  readonly failure: string;
  /** What the agent said about itself. Evidence, never a verdict (BENCH-6). */
  readonly agentClaimedDone: boolean;
  /** Absent exactly when the agent did not run to the point of reporting cost. */
  readonly telemetry: SampleTelemetry | undefined;
  /**
   * Cost detail the cost record does not carry. Absent when the adapter observed
   * none; carried here rather than reconstructed later, because cache tokens and
   * turn counts exist only while the execution is happening.
   */
  readonly usage: SampleUsageRecord | undefined;
  /** The compression variant the execution ran under; absent when it ran under no declared variant. */
  readonly compression: SampleCompressionRecord | undefined;
  readonly workspace: IsolatedWorkspaceCapture;
  readonly cleanup: IsolatedCleanupOutcome;
}
