// Pure task-dependency rules: what a task's `## Dependencies` section means and how a
// blocked-task notice is rendered. FS persistence lives in later layers.
// Behaviour etalon: AG_loop domain/tasks/dependencies.ts. WBR VQ-201 changes: markdown
// section reader comes straight from shared/markdown (no compat shim), the ledger key is
// the unified identity.taskLedgerKey, and DEPENDENCY_PLACEHOLDERS is exported so the
// scheduler consumes the same set instead of keeping a copy (AG_loop R8).

import { taskLedgerKey } from "./identity.js";
import { extractSection } from "../../shared/markdown.js";

export type TaskDependencyMetadata = {
  task_id: string;
  file: string;
  blocked_by: string[];
};

export type BlockedTaskRoute = {
  task_id: string;
  from: string;
  to: string;
  blocked_by: string;
};

/**
 * Placeholder texts that are NOT a real dependency (PDAG-2). Templates write `none` / `-`
 * / `TBD` under `## Dependencies` to mean "no blockers"; read as a task id such a value
 * would block the whole queue behind a task that can never exist. Values are compared
 * AFTER {@link normalizeTaskReference} (hence `n-a`). Exported: every consumer of
 * caller-supplied `blocked_by` arrays must filter with THIS set, never a private copy.
 */
export const DEPENDENCY_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "none",
  "no",
  "n-a",
  "na",
  "nera",
  "n-ra",
  "tbd",
  "null",
  "-",
]);

/** True when a normalized dependency reference is a "no dependencies" placeholder (PDAG-2). */
export function isPlaceholderDependency(reference: string): boolean {
  return DEPENDENCY_PLACEHOLDERS.has(reference.trim().toLowerCase());
}

/**
 * Reads a task's `## Dependencies` section into its normalized blocker set. PDAG-2 is
 * enforced here, at the parse boundary: placeholder values never leave this function as
 * dependencies, so no downstream consumer has to re-learn that rule.
 */
export function parseTaskDependencies(taskText: string, taskFile = "task.md"): TaskDependencyMetadata {
  const taskId = taskLedgerKey(taskFile);
  const dependenciesText =
    extractSection(taskText, "## Dependencies") ||
    extractSection(taskText, "## Priklausomybės") ||
    extractSection(taskText, "## Priklausomybes");
  const blockedBy = new Set<string>();

  for (const line of dependenciesText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const keyValue = trimmed.match(
      /^(?:[-*]\s*)?(?:blocked_by|blocked-by|depends_on|depends-on|priklauso_nuo|priklauso-nuo)\s*:\s*(.+)$/i,
    );
    if (keyValue?.[1]) {
      for (const value of splitDependencyValues(keyValue[1])) blockedBy.add(normalizeTaskReference(value));
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet?.[1]) blockedBy.add(normalizeTaskReference(bullet[1]));
  }

  const inlineMatches = taskText.matchAll(/(?:blocked_by|blocked-by|depends_on|depends-on)\s*:\s*([^\n]+)/gi);
  for (const match of inlineMatches) {
    for (const value of splitDependencyValues(match[1] ?? "")) blockedBy.add(normalizeTaskReference(value));
  }

  return {
    task_id: taskId,
    file: taskFile.replace(/\\/g, "/"),
    blocked_by: Array.from(blockedBy)
      .filter((value) => value && !isPlaceholderDependency(value))
      .sort(),
  };
}

export function dependencyMatches(dependency: string, blocker: string): boolean {
  return dependency === blocker || dependency.startsWith(`${blocker}-`) || blocker.startsWith(`${dependency}-`);
}

export function normalizeTaskReference(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^AG\/tasks\/[A-Za-z-]+\//, "")
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function splitDependencyValues(value: string): string[] {
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function withBlockedNotice(taskText: string, blocker: string): string {
  if (/## Human review block\b/.test(taskText)) return taskText;
  const notice = `\n## Human review block\n- blocked_by: ${blocker}\n- reason: upstream task entered human-review or failed routing. Review dependency before requeue.\n`;
  return `${taskText.trimEnd()}\n${notice}`;
}
