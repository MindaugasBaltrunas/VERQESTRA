import type { WorktreeCleanupResult } from "../../domain/result.js";

/** A checkout created for exactly one sample and owned by the runner (BENCH-4). */
export interface IsolatedWorktree {
  readonly id: string;
  readonly path: string;
  readonly startCommit: string;
}

export interface IsolatedWorktreeRequest {
  readonly scenarioId: string;
  readonly fixturePath: string;
}

/**
 * Isolation port.
 *
 * Implementations create a temporary Git worktree, never touch the main branch
 * and never force. `cleanup` resolves and verifies the path before removing it,
 * and reports `kept-for-diagnosis` rather than deleting evidence of a crash.
 */
export interface WorktreePort {
  create(request: IsolatedWorktreeRequest): Promise<IsolatedWorktree>;
  changedFiles(worktree: IsolatedWorktree): Promise<{
    readonly endCommit: string;
    readonly changedFiles: readonly string[];
  }>;
  cleanup(worktree: IsolatedWorktree): Promise<WorktreeCleanupResult>;
}
