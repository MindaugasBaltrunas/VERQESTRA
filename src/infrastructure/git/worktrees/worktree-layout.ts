// Deterministinis izoliuotos kopijos kelias ir šaka (etalonas: AG_loop
// infrastructure/git/worktrees/worktree-layout.ts). Segmentų taisyklė — ta pati
// safeLeaseSegment kaip lease store (FQC-12).

import { createHash } from "node:crypto";
import path from "node:path";
import { safeLeaseSegment } from "../../../application/scheduling/worker-lease-store.js";
import { filterGitIgnored } from "../git-client.js";

/** Visos izoliuotos kopijos gyvena po vienu prefiksu — tik taip orphan'ai atskiriami nuo svetimų worktree'ų. */
export const WORKTREE_ROOT_DIR = ".ag/worktrees";

/** Šakų prefiksas. Atskiras nuo `ag/integration/...`, kad verifier'io šakos nesimaišytų su darbinėmis. */
export const WORKTREE_BRANCH_PREFIX = "ag/worker";

export type WorktreeIdentity = {
  run_id: string;
  worker_id: string;
  task_id: string;
  attempt: number;
};

export type WorktreeLayout = {
  /** Repo-relative kelias (POSIX) — tinkamas gitignore ir logams. */
  relative_path: string;
  /** Absoliutus kelias diske. */
  path: string;
  /** Trumpas šakos vardas (be `refs/heads/`). */
  branch: string;
};

function attemptSegment(attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("Worktree attempt must be a positive integer");
  return `a${attempt}`;
}

/** Windows MAX_PATH apsauga, paliekanti vietos giliai nested failų keliams worktree viduje. */
export const WORKTREE_TASK_SEGMENT_MAX_LENGTH = 40;
const WORKTREE_TASK_HASH_LENGTH = 8;

/** Etalono skirtukas — NUL simbolis; per fromCharCode, kad šaltinyje nebūtų NUL baito. */
const IDENTITY_SEPARATOR = String.fromCharCode(0);

/** Trumpas deterministinis hash iš pilno, netrumpinto identity (hash paritetas su etalonu). */
function worktreeIdentityHash(identity: WorktreeIdentity): string {
  const material = [identity.run_id, identity.worker_id, identity.task_id, String(identity.attempt)].join(
    IDENTITY_SEPARATOR,
  );
  return createHash("sha256").update(material).digest("hex").slice(0, WORKTREE_TASK_HASH_LENGTH);
}

function boundedTaskSegment(taskSegment: string, identity: WorktreeIdentity): string {
  if (taskSegment.length <= WORKTREE_TASK_SEGMENT_MAX_LENGTH) return taskSegment;
  const hash = worktreeIdentityHash(identity);
  const prefixLength = WORKTREE_TASK_SEGMENT_MAX_LENGTH - hash.length - 1;
  return `${taskSegment.slice(0, prefixLength)}-${hash}`;
}

export function assertInsideProject(projectRoot: string, targetPath: string): void {
  const relative = path.relative(path.resolve(projectRoot), targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to manage a worktree outside the project root: ${targetPath}`);
  }
}

/** Deterministinis worktree kelias ir šaka. */
export function worktreeLayout(projectRoot: string, identity: WorktreeIdentity): WorktreeLayout {
  const runSegment = safeLeaseSegment(identity.run_id, "run_id");
  const workerSegment = safeLeaseSegment(identity.worker_id, "worker_id");
  const taskSegment = boundedTaskSegment(safeLeaseSegment(identity.task_id, "task_id"), identity);
  const attempt = attemptSegment(identity.attempt);

  const relativePath = `${WORKTREE_ROOT_DIR}/${runSegment}/${workerSegment}-${taskSegment}-${attempt}`;
  const absolute = path.resolve(projectRoot, relativePath);
  assertInsideProject(projectRoot, absolute);

  return {
    relative_path: relativePath,
    path: absolute,
    branch: `${WORKTREE_BRANCH_PREFIX}/${runSegment}/${taskSegment}/${attempt}`,
  };
}

/** Worktree šaknis turi būti gitignore'inta, kad pagrindinis medis liktų švarus. */
export async function worktreeRootIsIgnored(projectRoot: string): Promise<boolean> {
  const ignored = await filterGitIgnored([WORKTREE_ROOT_DIR], projectRoot);
  return ignored.has(WORKTREE_ROOT_DIR);
}
