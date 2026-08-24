import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { GitRunnerPort } from "./ports/git-runner-port.js";
import type { SessionRegistryStorePort } from "./ports/session-registry-store-port.js";
import {
  transitionWorktree,
  type WorktreeRecord,
} from "../domain/worktree-lifecycle.js";

export type WorktreeAllocation = Readonly<{
  sessionId: string;
  branch: string;
  baseCommit: string;
  worktreeRoot: string;
}>;

function requireSessionId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("sessionId must be a UUID");
  }
  return value.toLowerCase();
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class IsolatedWorktreeService {
  constructor(
    private readonly git: GitRunnerPort,
    private readonly configuredSessionRoot: string,
    /**
     * Optional durable registry. With it, allocation is journalled so a crash
     * between creating files and committing the record leaves a `quarantined`
     * worktree instead of an untracked directory that a later session could
     * silently reuse.
     */
    private readonly registry?: SessionRegistryStorePort,
  ) {
    if (!path.isAbsolute(configuredSessionRoot)) throw new Error("Session root must be absolute");
  }

  private async recordWorktree(record: WorktreeRecord): Promise<void> {
    if (!this.registry) return;
    await this.registry.update((snapshot) => ({
      snapshot: {
        ...snapshot,
        revision: snapshot.revision + 1,
        worktrees: { ...snapshot.worktrees, [record.sessionId]: record },
      },
      result: undefined,
    }));
  }

  async allocate(input: {
    repositoryRoot: string;
    sessionId: string;
    baseCommit: string;
  }): Promise<WorktreeAllocation> {
    const sessionId = requireSessionId(input.sessionId);
    if (!/^[0-9a-f]{7,64}$/i.test(input.baseCommit)) throw new Error("baseCommit must be an immutable Git OID");
    const sessionRoot = await realpath(this.configuredSessionRoot);
    const target = path.resolve(sessionRoot, sessionId);
    if (!isInside(sessionRoot, target)) throw new Error("Worktree target escapes the session root");
    const branch = `mobile/${sessionId}`;
    // The intent is journalled BEFORE anything touches the filesystem, so an
    // interrupted allocation is always recoverable as `allocating` — the state
    // reconciliation later quarantines.
    const allocating: WorktreeRecord = {
      sessionId,
      branch,
      baseCommit: input.baseCommit,
      worktreeRoot: target,
      state: "allocating",
    };
    await this.recordWorktree(allocating);
    await mkdir(path.dirname(target), { recursive: true });
    const result = await this.git.run(input.repositoryRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      target,
      input.baseCommit,
    ]);
    if (result.exitCode !== 0) {
      // Files may already exist under the target; quarantine rather than leave a
      // directory a later session could adopt as its own.
      await this.recordWorktree(transitionWorktree(allocating, "quarantined", {
        quarantineReason: `git_worktree_add_failed:${result.exitCode}`,
      }));
      throw new Error(`git_worktree_add_failed:${result.exitCode}`);
    }
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(target);
      if (!isInside(sessionRoot, canonicalTarget)) {
        throw new Error("Created worktree resolved outside session root");
      }
    } catch (error) {
      await this.recordWorktree(transitionWorktree(allocating, "quarantined", {
        quarantineReason: "worktree_escaped_session_root",
      }));
      throw error;
    }
    await this.recordWorktree({
      ...transitionWorktree(allocating, "ready"),
      worktreeRoot: canonicalTarget,
    });
    return Object.freeze({
      sessionId,
      branch,
      baseCommit: input.baseCommit,
      worktreeRoot: canonicalTarget,
    });
  }
}
