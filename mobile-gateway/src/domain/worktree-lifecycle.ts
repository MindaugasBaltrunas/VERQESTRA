/**
 * Worktree lifecycle from `runtime-state-machines.md`.
 *
 * Worktree disposition is deliberately separate from session state: a session
 * reaching `ended` says nothing about whether the agent's changes may be thrown
 * away. Every rule that could destroy work — cleanup, integration — is a pure,
 * testable predicate here rather than a condition buried in an adapter.
 */

export type WorktreeState =
  | "allocating"
  | "ready"
  | "dirty"
  | "review_ready"
  | "locally_integrating"
  | "integrated"
  | "retained"
  | "quarantined";

export type WorktreeRecord = Readonly<{
  sessionId: string;
  branch: string;
  /** Recorded BEFORE `git worktree add`, so a crash leaves a traceable target. */
  baseCommit: string;
  worktreeRoot: string;
  state: WorktreeState;
  quarantineReason?: string;
}>;

/** Evidence `review_ready` requires; anything missing keeps the worktree `dirty`. */
export type ReviewEvidence = Readonly<{
  processEnded: boolean;
  gitStatusCaptured: boolean;
  recordedGates: readonly string[];
}>;

export type WorktreeTransitionContext = Readonly<{
  review?: ReviewEvidence;
  /**
   * True only for an action authenticated on the host itself. Remote callers can
   * never reach `locally_integrating`.
   */
  localOperator?: boolean;
  quarantineReason?: string;
}>;

export class InvalidWorktreeTransitionError extends Error {
  constructor(readonly from: WorktreeState, readonly to: WorktreeState, reason: string) {
    super(`Worktree cannot move ${from} -> ${to}: ${reason}`);
    this.name = "InvalidWorktreeTransitionError";
  }
}

const QUARANTINABLE: ReadonlySet<WorktreeState> = new Set([
  "allocating",
  "ready",
  "dirty",
  "review_ready",
]);

const ALLOWED: Readonly<Record<WorktreeState, readonly WorktreeState[]>> = Object.freeze({
  allocating: ["ready", "quarantined"],
  ready: ["dirty", "quarantined"],
  dirty: ["review_ready", "quarantined"],
  review_ready: ["locally_integrating", "retained", "quarantined"],
  // A failed gate, a moved base or an unresolved conflict returns here; nothing
  // resolves a conflict automatically.
  locally_integrating: ["integrated", "review_ready"],
  integrated: [],
  retained: [],
  quarantined: [],
});

export function transitionWorktree(
  record: WorktreeRecord,
  next: WorktreeState,
  context: WorktreeTransitionContext = {},
): WorktreeRecord {
  if (next === "quarantined") {
    if (!QUARANTINABLE.has(record.state)) {
      throw new InvalidWorktreeTransitionError(record.state, next, "state is already final");
    }
    return Object.freeze({
      ...record,
      state: next,
      quarantineReason: context.quarantineReason ?? "unspecified",
    });
  }
  if (!ALLOWED[record.state].includes(next)) {
    throw new InvalidWorktreeTransitionError(record.state, next, "transition is not in the state machine");
  }
  if (next === "review_ready" && record.state === "dirty") {
    const review = context.review;
    if (!review?.processEnded || !review.gitStatusCaptured || review.recordedGates.length === 0) {
      throw new InvalidWorktreeTransitionError(
        record.state,
        next,
        "review requires an ended process, captured Git status and recorded quality gates",
      );
    }
  }
  if (next === "locally_integrating" && !context.localOperator) {
    throw new InvalidWorktreeTransitionError(
      record.state,
      next,
      "integration is local-only and cannot be started by a remote caller",
    );
  }
  return Object.freeze({ ...record, state: next });
}

export type CleanupRequest = Readonly<{
  localOperator: boolean;
  uncommittedChanges: boolean;
  /** Set when the operator exported the changes somewhere durable first. */
  exportedAt?: string;
  confirmed: boolean;
}>;

export class WorktreeCleanupRefusedError extends Error {
  constructor(readonly reason: "remote_caller" | "unexported_changes" | "not_confirmed") {
    super(`Worktree cleanup refused: ${reason}`);
    this.name = "WorktreeCleanupRefusedError";
  }
}

/**
 * Cleanup is local-only and refuses uncommitted or unexported changes
 * (`runtime-state-machines.md`). Deleting an agent's only copy of its work is
 * unrecoverable, so every doubt resolves to refusal.
 */
export function assertCleanupAllowed(request: CleanupRequest): void {
  if (!request.localOperator) {
    throw new WorktreeCleanupRefusedError("remote_caller");
  }
  if (request.uncommittedChanges && !request.exportedAt) {
    throw new WorktreeCleanupRefusedError("unexported_changes");
  }
  if (!request.confirmed) {
    throw new WorktreeCleanupRefusedError("not_confirmed");
  }
}
