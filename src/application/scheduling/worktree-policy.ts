// Worktree policy ir izoliuotos darbo kopijos PLANAS (etalonas: AG_loop
// orchestrator/git/worktree.ts; active-runtime nuo 2026-08-11 — antro worker slot'o
// izoliacija). Grynas: sudaro GitCommandPlan, kurio vykdymas — infrastructure/git.

import path from "node:path";

/** Vieno git kvietimo planas: kur ir su kokiu argv. Vykdytojas — infrastructure runGitPlan. */
export type GitCommandPlan = {
  root: string;
  args: string[];
};

export function gitCommandPlan(root: string, args: string[]): GitCommandPlan {
  return { root: path.resolve(root), args };
}

export type WorktreePolicy = {
  enabled: boolean;
  root: string;
  branchPrefix: string;
  pathPrefix: string;
};

export type WorktreePlan =
  | { status: "disabled"; reason: "worktree_disabled" }
  | {
      status: "planned";
      taskId: string;
      worktreePath: string;
      branchName: string;
      create: GitCommandPlan;
      cleanup: GitCommandPlan;
    };

export const defaultWorktreePolicy: WorktreePolicy = {
  enabled: false,
  root: ".ag-worktrees",
  branchPrefix: "ag-task",
  pathPrefix: "task",
};

export type WorktreePolicyFsPort = {
  /** Failo tekstas arba `undefined`, kai failo nėra. */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
};

export async function loadWorktreePolicy(fs: WorktreePolicyFsPort, filePath: string): Promise<WorktreePolicy> {
  const raw = await fs.readTextFileIfExists(filePath);
  if (raw === undefined) return defaultWorktreePolicy;
  return parseWorktreePolicy(JSON.parse(raw) as unknown);
}

export function parseWorktreePolicy(raw: unknown): WorktreePolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid worktree policy: expected object.");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record["enabled"] !== "boolean") {
    throw new Error("Invalid worktree policy: enabled must be boolean.");
  }
  return {
    enabled: record["enabled"],
    root: safeRelativePath(stringField(record["root"], defaultWorktreePolicy.root), "root"),
    branchPrefix: safeName(stringField(record["branchPrefix"], defaultWorktreePolicy.branchPrefix), "branchPrefix"),
    pathPrefix: safeName(stringField(record["pathPrefix"], defaultWorktreePolicy.pathPrefix), "pathPrefix"),
  };
}

export function planTaskWorktree(input: {
  projectRoot: string;
  taskId: string;
  baseRef: string;
  policy: WorktreePolicy;
}): WorktreePlan {
  if (!input.policy.enabled) {
    return { status: "disabled", reason: "worktree_disabled" };
  }

  const projectRoot = path.resolve(input.projectRoot);
  const taskSlug = safeName(input.taskId, "taskId");
  const branchName = `${input.policy.branchPrefix}/${taskSlug}`;
  const worktreePath = path.resolve(projectRoot, input.policy.root, `${input.policy.pathPrefix}-${taskSlug}`);
  assertInsideProject(projectRoot, worktreePath);

  return {
    status: "planned",
    taskId: taskSlug,
    worktreePath,
    branchName,
    create: gitCommandPlan(projectRoot, ["worktree", "add", "-b", branchName, worktreePath, input.baseRef]),
    cleanup: gitCommandPlan(projectRoot, ["worktree", "remove", "--force", worktreePath]),
  };
}

export function planWorktreeCleanup(projectRoot: string, worktreePath: string): GitCommandPlan {
  const root = path.resolve(projectRoot);
  const resolvedWorktreePath = path.resolve(worktreePath);
  assertInsideProject(root, resolvedWorktreePath);
  return gitCommandPlan(root, ["worktree", "remove", "--force", resolvedWorktreePath]);
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function safeRelativePath(value: string, field: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized || normalized.includes("..") || path.isAbsolute(normalized) || /^[A-Za-z]:[\\/]/.test(normalized)) {
    throw new Error(`Invalid worktree policy: ${field} must be a safe relative path.`);
  }
  return normalized;
}

function safeName(value: string, field: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error(`Invalid worktree policy: ${field} must contain a safe name.`);
  }
  return normalized.slice(0, 80);
}

function assertInsideProject(projectRoot: string, targetPath: string): void {
  const relative = path.relative(projectRoot, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to plan worktree outside the project root.");
  }
}
