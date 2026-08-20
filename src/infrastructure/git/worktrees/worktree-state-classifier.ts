// Vienintelė vieta, kur techninė worktree būsena klasifikuojama kaip reusable arba
// quarantine (etalonas: AG_loop worktree-state-classifier.ts). Grynas.

import type { WorkerLeaseClaim } from "../../../domain/scheduling/worker-lease-rules.js";
import type { GitWorktreeEntry } from "../git-client.js";

export type WorktreeOwnerMarker = {
  lease_id: string;
  owner_id: string;
  run_id: string;
  worker_id: string;
  task_id: string;
  attempt: number;
  fencing_token: number;
  branch: string;
  created_at: string;
};

export type WorktreeQuarantineReason =
  | "dirty-worktree"
  | "unmerged-paths"
  | "detached-head"
  | "branch-mismatch"
  | "locked"
  | "prunable"
  | "unknown-owner"
  | "foreign-owner";

export type WorktreeState =
  | { status: "absent" }
  | { status: "reusable"; entry: GitWorktreeEntry; owner?: WorktreeOwnerMarker }
  | {
      status: "quarantine";
      entry: GitWorktreeEntry;
      owner?: WorktreeOwnerMarker;
      reasons: WorktreeQuarantineReason[];
    };

export type ClassifyWorktreeInput = {
  entry?: GitWorktreeEntry;
  expectedBranch: string;
  dirtyPaths: readonly string[];
  unmergedPaths: readonly string[];
  owner?: WorktreeOwnerMarker;
  claim?: WorkerLeaseClaim;
};

export function classifyWorktreeState(input: ClassifyWorktreeInput): WorktreeState {
  const { entry } = input;
  if (!entry) return { status: "absent" };

  const reasons: WorktreeQuarantineReason[] = [];
  if (input.dirtyPaths.length > 0) reasons.push("dirty-worktree");
  if (input.unmergedPaths.length > 0) reasons.push("unmerged-paths");
  if (entry.detached) reasons.push("detached-head");
  else if (entry.branch && entry.branch !== `refs/heads/${input.expectedBranch}`) reasons.push("branch-mismatch");
  if (entry.locked) reasons.push("locked");
  if (entry.prunable) reasons.push("prunable");

  if (!input.owner) reasons.push("unknown-owner");
  else if (input.claim && input.owner.lease_id !== input.claim.lease_id) reasons.push("foreign-owner");
  else if (input.claim && input.owner.fencing_token !== input.claim.fencing_token) reasons.push("foreign-owner");

  if (reasons.length > 0) {
    return input.owner
      ? { status: "quarantine", entry, owner: input.owner, reasons }
      : { status: "quarantine", entry, reasons };
  }
  return input.owner ? { status: "reusable", entry, owner: input.owner } : { status: "reusable", entry };
}
