// Savininko žyma ir karantinas (etalono worktree-lifecycle.ts nuosavybės/karantino pusė).
// Žyma gyvena worktree git admin kataloge (ne darbiniame medyje — niekada nesirodo kaip
// untracked failas). Karantinas = `git worktree lock` + mašininis įrašas; nieko netrinama.

import path from "node:path";
import type { WorkerLease } from "../../../domain/scheduling/worker-lease-rules.js";
import { toPrettyJson } from "../../../shared/json.js";
import { nodeFsAdapter } from "../../fs/node-fs-adapter.js";
import { gitWorktreeList } from "../git-client.js";
import { assertInsideProject } from "./worktree-layout.js";
import { entryFor, worktreeGit, worktreeGitFailure } from "./worktree-git-util.js";
import type { WorktreeOwnerMarker, WorktreeQuarantineReason } from "./worktree-state-classifier.js";

/** Savininko žyma git admin kataloge. */
export const WORKTREE_OWNER_FILE = "ag-worktree-owner.json";

/** Karantino įrašas šalia savininko žymos. */
export const WORKTREE_QUARANTINE_FILE = "ag-worktree-quarantine.json";

/** Worktree git admin katalogas (`<main>/.git/worktrees/<name>`). */
export async function worktreeGitDir(worktreePath: string): Promise<string | undefined> {
  const result = await worktreeGit(worktreePath, ["rev-parse", "--absolute-git-dir"]);
  return result.code === 0 ? path.normalize(result.stdout.trim()) : undefined;
}

export async function readWorktreeOwner(worktreePath: string): Promise<WorktreeOwnerMarker | undefined> {
  const gitDir = await worktreeGitDir(worktreePath);
  if (!gitDir) return undefined;
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(gitDir, WORKTREE_OWNER_FILE));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed["lease_id"] !== "string" || typeof parsed["owner_id"] !== "string") return undefined;
    return parsed as unknown as WorktreeOwnerMarker;
  } catch {
    // Sugadinta žyma reiškia „savininkas nežinomas" — klasifikatorius dėl to nukreipia
    // kopiją į karantiną.
    return undefined;
  }
}

export async function writeWorktreeOwner(worktreePath: string, marker: WorktreeOwnerMarker): Promise<void> {
  const gitDir = await worktreeGitDir(worktreePath);
  if (!gitDir) throw new Error(`Cannot resolve the git admin directory of ${worktreePath}`);
  await nodeFsAdapter.writeTextFile(path.join(gitDir, WORKTREE_OWNER_FILE), toPrettyJson(marker));
}

export function ownerMarkerFor(lease: WorkerLease, branch: string, createdAt: string): WorktreeOwnerMarker {
  return {
    lease_id: lease.lease_id,
    owner_id: lease.owner_id,
    run_id: lease.run_id,
    worker_id: lease.worker_id,
    task_id: lease.task_id,
    attempt: lease.attempt,
    fencing_token: lease.fencing_token,
    branch,
    created_at: createdAt,
  };
}

export type WorktreeQuarantineRecord = {
  worktree_path: string;
  reasons: WorktreeQuarantineReason[];
  owner?: WorktreeOwnerMarker;
  quarantined_at: string;
};

/**
 * Užrakina kopiją ir palieka mašininį pėdsaką. `git worktree lock` reiškia, kad nei
 * `prune`, nei `remove` jos nebepalies atsitiktinai — būtent to reikia neaiškiai būsenai.
 */
export async function quarantineWorktree(input: {
  projectRoot: string;
  worktreePath: string;
  reasons: readonly WorktreeQuarantineReason[];
  now?: Date;
}): Promise<{ status: "quarantined"; record: WorktreeQuarantineRecord } | { status: "infrastructure"; message: string }> {
  const projectRoot = path.resolve(input.projectRoot);
  const worktreePath = path.resolve(input.worktreePath);
  assertInsideProject(projectRoot, worktreePath);

  const reasons = [...new Set(input.reasons)].sort();
  const record: WorktreeQuarantineRecord = {
    worktree_path: worktreePath,
    reasons,
    quarantined_at: (input.now ?? new Date()).toISOString(),
  };

  const owner = await readWorktreeOwner(worktreePath);
  if (owner) record.owner = owner;

  const entries = await gitWorktreeList(projectRoot);
  const entry = entryFor(entries, worktreePath);
  if (entry && !entry.locked) {
    const args = ["worktree", "lock", "--reason", `ag-quarantine: ${reasons.join(", ")}`, worktreePath];
    const locked = await worktreeGit(projectRoot, args);
    if (locked.code !== 0) return { status: "infrastructure", message: worktreeGitFailure(locked, args) };
  }

  const gitDir = await worktreeGitDir(worktreePath);
  if (gitDir) await nodeFsAdapter.writeTextFile(path.join(gitDir, WORKTREE_QUARANTINE_FILE), toPrettyJson(record));

  return { status: "quarantined", record };
}
