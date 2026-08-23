import type { TerminalSession } from "./terminal-session.js";
import type { WorktreeRecord } from "./worktree-lifecycle.js";

/**
 * Durable session registry and the pure reconciliation rule applied after a
 * gateway restart (`runtime-state-machines.md` § Gateway restart
 * reconciliation).
 *
 * The decision is a pure function of the persisted record and what the host
 * currently reports, so the dangerous case — silently reattaching to a PID that
 * the operating system has since reused for an unrelated process — is decided by
 * testable logic rather than by adapter timing.
 */

/** Process facts captured WITHOUT signalling the process. */
export type ProcessIdentity = Readonly<{
  pid: number;
  /** Process start instant; the field that makes a recycled PID detectable. */
  startedAt: string;
  executable: string;
}>;

export type PersistedLease = Readonly<{
  leaseId: string;
  ownerDeviceId: string;
  generation: number;
  expiresAt: string;
  status: "active" | "revoked" | "expired";
}>;

export type PersistedSessionRecord = Readonly<{
  sessionId: string;
  projectId: string;
  provider: TerminalSession["provider"];
  /** Immutable after `creating`. */
  worktreeRoot: string;
  branch: string;
  baseCommit: string;
  state: TerminalSession["state"];
  lease: PersistedLease;
  process?: ProcessIdentity;
  /** Gateway instance that created the record. */
  gatewayInstanceId: string;
}>;

export type SessionRegistrySnapshot = Readonly<{
  version: 1;
  /** Monotonically increasing; a lower revision on disk is a rollback attack or a restore. */
  revision: number;
  gatewayInstanceId: string;
  sessions: Readonly<Record<string, PersistedSessionRecord>>;
  /**
   * Worktree disposition, keyed by session id. Kept beside sessions rather than
   * inside them because a worktree outlives its session: an `ended` session can
   * still own `review_ready` work that must not be discarded.
   */
  worktrees: Readonly<Record<string, WorktreeRecord>>;
}>;

const TERMINAL_STATES: ReadonlySet<TerminalSession["state"]> = new Set(["ended", "failed"]);

export function isTerminalSessionState(state: TerminalSession["state"]): boolean {
  return TERMINAL_STATES.has(state);
}

export type ObservedSession = Readonly<{
  /** Current process facts for the recorded pid, or `undefined` when absent. */
  process?: ProcessIdentity;
  /** Git reports this worktree path for the recorded branch. */
  gitReportsWorktree: boolean;
  /** The recorded worktree path resolves under the configured session root. */
  withinSessionRoot: boolean;
}>;

export type ReconciliationVerdict = "reattached" | "orphaned" | "already_terminal";

/**
 * `orphaned -> live` is allowed only when PID, process start identity,
 * executable, worktree containment, Git's own view of the worktree and the
 * owning gateway instance ALL match. Any mismatch, or any missing observation,
 * keeps the session `orphaned` — the specification forbids an automatic
 * reattachment on partial evidence.
 */
export function decideReattachment(
  record: PersistedSessionRecord,
  observed: ObservedSession,
  registryInstanceId: string,
): ReconciliationVerdict {
  if (isTerminalSessionState(record.state)) {
    return "already_terminal";
  }
  if (
    !record.process ||
    !observed.process ||
    record.gatewayInstanceId !== registryInstanceId ||
    observed.process.pid !== record.process.pid ||
    observed.process.startedAt !== record.process.startedAt ||
    observed.process.executable !== record.process.executable ||
    !observed.withinSessionRoot ||
    !observed.gitReportsWorktree
  ) {
    return "orphaned";
  }
  return "reattached";
}

/**
 * Every lease that survived a restart is invalidated by bumping its generation,
 * so a pre-restart writer can never fence a post-restart mutation
 * (`runtime-state-machines.md`: "Increment/revoke every pre-restart lease
 * generation").
 */
export function revokePersistedLease(lease: PersistedLease): PersistedLease {
  return Object.freeze({
    ...lease,
    generation: lease.generation + 1,
    status: "revoked" as const,
  });
}
