// Backlog auditas: numerių higiena, tvarka ir README kategorijų dengimas per task
// bucket'us. Elgesio etalonas: AG_loop orchestrator/quality/backlog-audit.ts (DUP-01/02/07
// task atpažinimas centralizuotas domain/tasks/identity). IO — per BacklogAuditPorts.

import path from "node:path";
import { identifyTask, splitChildParentStemCandidates, taskFileStem } from "../../domain/tasks/identity.js";

export type BacklogCategory = {
  id: string;
  label: string;
  keywords: readonly string[];
};

export type BacklogTask = {
  file: string;
  number: number;
  goal: string;
};

export type BacklogAuditResult = {
  status: "complete" | "incomplete";
  task_count: number;
  covered_categories: string[];
  missing_categories: string[];
  duplicate_numbers: number[];
  out_of_order: Array<{ file: string; previous_number: number; number: number }>;
  tasks: BacklogTask[];
};

export const auditedTaskStates = ["queue", "active", "delegated", "done", "error", "failed", "human-review"] as const;

// Stabilūs README architektūros konceptai. Keywords sąmoningai pakankamai platūs, kad
// atpažintų ir tikslus, ir failų vardus, o kiekviena kategorija lieka aiški.
export const backlogCategories: readonly BacklogCategory[] = [
  { id: "core", label: "AG Core", keywords: ["core", "queue lifecycle", "orchestrat"] },
  { id: "spec", label: "Spec layer", keywords: ["spec", "product brief", "requirement"] },
  { id: "project-profile", label: "Project profile", keywords: ["project profile", "profile loader", "default config"] },
  { id: "architecture-contract", label: "Architecture contract", keywords: ["architecture", "boundary", "schema"] },
  { id: "context-pack", label: "Context pack", keywords: ["context pack", "context-pack", "rag-lite", "retrieval"] },
  { id: "execution-loop", label: "Execution loop", keywords: ["queue loop", "integrated loop", "integrated-loop", "dispatch flow", "dry-run loop"] },
  { id: "agent-adapters", label: "Agent adapters", keywords: ["codex", "claude adapter", "coding-agent", "agent compatibility", "adapter", "runtime routing", "runtime dispatch"] },
  { id: "quality-gates", label: "Quality gates", keywords: ["quality gate", "test fixture", "end-to-end", "milestone check", "final-audit", "release-check", "ci workflow"] },
  { id: "security-policy", label: "Security and policy", keywords: ["security", "policy", "preflight", "human review"] },
  { id: "recovery", label: "Retry and recovery", keywords: ["retry", "rollback", "restore stable", "stable ref"] },
  { id: "status", label: "Status and convergence", keywords: ["status command", "project status", "converge", "telemetry"] },
  { id: "distribution", label: "Install and release", keywords: ["install command", "package publish", "release", "template version"] },
  { id: "operator-ui", label: "Operator UI", keywords: ["operator ui", "dashboard"] },
] as const;

export type BacklogAuditPorts = {
  /** Failų vardai (ne katalogai); `[]` kai katalogo nėra. */
  listFiles(absoluteDir: string): Promise<string[]>;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
};

export function parseTask(file: string, content: string): BacklogTask | undefined {
  // `identifyTask` reikalauja VEDANČIOS `# Task` antraštės — superseded stub'as (vedanti
  // `# Superseded`) apskritai neatpažįstamas kaip task'as.
  const identity = identifyTask(file, content);
  if (!identity) return undefined;
  return { file, number: identity.number, goal: identity.goal };
}

export function auditBacklog(
  tasks: BacklogTask[],
  categories: readonly BacklogCategory[] = backlogCategories,
): BacklogAuditResult {
  // Task-splitter generuoja vaikų failus `<parentTaskId>-<NN>-<slug>.md`; tėvas ir jo
  // split-vaikai atrodytų kaip to paties numerio dublikatai, nors tai sąmoninga
  // hierarchija — vaikai, kurių tėvas egzistuoja rinkinyje, praleidžiami. Kandidatų aibė
  // vietoj vieno greedy split'o: vaiko slug'as pats gali turėti `-NN-` sekas.
  const taskStems = new Set(tasks.map((task) => taskFileStem(task.file)));
  const isSplitChild = (task: BacklogTask): boolean =>
    splitChildParentStemCandidates(task.file).some((parent) => taskStems.has(parent));
  // `done/` yra nekintamas archyvas, todėl numerių higiena jam netaikoma: loop'as
  // sąmoningai pernaudoja numerius tarp planavimo kartų, o writeUniqueFile cikluojantis
  // sukuria `-2`/`-3` kolizinius vardus — laukiama istorija, ne backlog defektas. Aktyvių
  // bucket'ų kolizijos lieka pažymėtos. Kategorijų dengimas skaičiuoja VISUS task'us.
  const isArchivedDoneTask = (task: BacklogTask): boolean => task.file.startsWith("done/");
  const counts = new Map<number, number>();
  for (const task of tasks) {
    if (isSplitChild(task) || isArchivedDoneTask(task)) continue;
    counts.set(task.number, (counts.get(task.number) ?? 0) + 1);
  }
  const duplicateNumbers = [...counts]
    .filter(([, count]) => count > 1)
    .map(([number]) => number)
    .sort((a, b) => a - b);
  const outOfOrder: BacklogAuditResult["out_of_order"] = [];
  for (let index = 1; index < tasks.length; index += 1) {
    const current = tasks[index]!;
    const previous = tasks[index - 1]!;
    if (current.number < previous.number) {
      outOfOrder.push({
        file: current.file,
        previous_number: previous.number,
        number: current.number,
      });
    }
  }

  const searchable = tasks.map((task) => `${task.file} ${task.goal}`.toLowerCase());
  const covered = categories
    .filter((category) => category.keywords.some((keyword) => searchable.some((text) => text.includes(keyword))))
    .map((category) => category.id);
  const missing = categories.filter((category) => !covered.includes(category.id)).map((category) => category.id);
  const incomplete = missing.length > 0 || duplicateNumbers.length > 0 || outOfOrder.length > 0;
  return {
    status: incomplete ? "incomplete" : "complete",
    task_count: tasks.length,
    covered_categories: covered,
    missing_categories: missing,
    duplicate_numbers: duplicateNumbers,
    out_of_order: outOfOrder,
    tasks,
  };
}

export async function auditBacklogDirectory(ports: BacklogAuditPorts, queueDir: string): Promise<BacklogAuditResult> {
  const files = (await ports.listFiles(queueDir)).filter((file) => file.endsWith(".md"));
  files.sort((left, right) => left.localeCompare(right));
  const tasks = (
    await Promise.all(
      files.map(async (file) => parseTask(file, (await ports.readTextFileIfExists(path.join(queueDir, file))) ?? "")),
    )
  ).filter((task): task is BacklogTask => task !== undefined);
  return auditBacklog(tasks);
}

export async function auditTaskStates(ports: BacklogAuditPorts, tasksRoot: string): Promise<BacklogAuditResult> {
  const tasks: BacklogTask[] = [];
  for (const state of auditedTaskStates) {
    const stateDir = path.join(tasksRoot, state);
    const files = (await ports.listFiles(stateDir)).filter((file) => file.endsWith(".md")).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      const relativeFile = `${state}/${file}`;
      const task = parseTask(relativeFile, (await ports.readTextFileIfExists(path.join(stateDir, file))) ?? "");
      if (task) tasks.push(task);
    }
  }
  tasks.sort((left, right) => left.number - right.number || left.file.localeCompare(right.file));
  return auditBacklog(tasks);
}

export function renderBacklogAudit(result: BacklogAuditResult): string {
  const value = (items: readonly (string | number)[]): string => (items.length === 0 ? "none" : items.join(", "));
  const order = result.out_of_order.map((item) => `${item.file} (${item.previous_number} -> ${item.number})`);
  return [
    `Backlog audit: ${result.status}`,
    `Tasks: ${result.task_count}`,
    `Covered categories: ${value(result.covered_categories)}`,
    `Missing categories: ${value(result.missing_categories)}`,
    `Duplicate numbers: ${value(result.duplicate_numbers)}`,
    `Out of order: ${value(order)}`,
  ].join("\n");
}
