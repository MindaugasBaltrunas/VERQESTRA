// Task plano šaltinio rezoliucija: OpenSpec change arba aktyvi legacy AG spec. Elgesio
// etalonas: AG_loop application/task-planning/spec-source.ts. IO — per TaskPlanningFsPort.

import path from "node:path";

export type TaskPlanningFsPort = {
  exists(absolutePath: string): Promise<boolean>;
  /** Failo tekstas arba `undefined`, kai failo nėra. */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** Poaplankių vardai; `[]` kai katalogo nėra. */
  listSubdirectories(absoluteDir: string): Promise<string[]>;
};

// Išspręstas task plano šaltinis: `changeDir` absoliutus; relative keliai —
// project-root-relative su forward slash.
export type TaskPlanSource = {
  id: string;
  changeDir: string;
  relativeSpecPath: string;
  relativeTasksPath: string;
};

export async function findOpenSpecTaskPlan(
  fs: TaskPlanningFsPort,
  projectRoot: string,
  changeId: string,
): Promise<TaskPlanSource> {
  const safeChangeId = changeId
    .replace(/^openspec\/changes\//, "")
    .replace(/^AG\/openspec\/changes\//, "")
    .replace(/\/+$/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(safeChangeId) || safeChangeId.includes("..")) {
    throw new Error(`Invalid OpenSpec change id: ${changeId}`);
  }

  const changeDir = path.join(projectRoot, "AG", "openspec", "changes", safeChangeId);
  const specPath = path.join(changeDir, "spec.md");
  const tasksPath = path.join(changeDir, "tasks.md");
  if (!(await fs.exists(specPath))) throw new Error(`OpenSpec spec missing: ${specPath}`);
  if (!(await fs.exists(tasksPath))) throw new Error(`OpenSpec tasks missing: ${tasksPath}`);

  return {
    id: safeChangeId,
    changeDir,
    relativeSpecPath: `openspec/changes/${safeChangeId}`,
    relativeTasksPath: path.relative(projectRoot, tasksPath).replace(/\\/g, "/"),
  };
}

export async function findActiveSpec(fs: TaskPlanningFsPort, projectRoot: string): Promise<TaskPlanSource> {
  const changesRoot = path.join(projectRoot, "AG", "spec", "changes");
  const entries = await fs.listSubdirectories(changesRoot);

  for (const name of [...entries].sort((a, b) => a.localeCompare(b))) {
    const changeDir = path.join(changesRoot, name);
    const specPath = path.join(changeDir, "spec.json");
    const raw = await fs.readTextFileIfExists(specPath);
    if (raw === undefined) {
      continue;
    }

    const spec = JSON.parse(raw) as { id?: unknown; status?: unknown };
    if (spec.status === "active" && typeof spec.id === "string" && spec.id.length > 0) {
      const tasksPath = path.join(changeDir, "tasks.md");
      return {
        id: spec.id,
        changeDir,
        relativeSpecPath: path.relative(projectRoot, specPath).replace(/\\/g, "/"),
        relativeTasksPath: path.relative(projectRoot, tasksPath).replace(/\\/g, "/"),
      };
    }
  }

  throw new Error(`No active spec found under ${changesRoot}`);
}
