// Task skaidymo planas (etalono orchestrator/tasks/task-splitting-policy.ts, VQ-304 3/3).
//
// GRYNOS taisyklės: dydžio metrikos ir ribos gyvena domain/tasks/size.ts (E2 dedup — etalono
// task-size.ts matavimo pusė ten jau sujungta, FQC-12); čia — tik plano sudarymas ir dalių
// rendinimas. Jokio IO: tą patį tekstą padavus gaunamas tas pats planas.
import {
  exceedsLimits,
  measureTaskSize,
  type TaskSizeLimitsView,
  type TaskSizeMetrics,
} from "../../domain/tasks/size.js";
import { allowedPaths } from "../../domain/tasks/allowed-paths.js";
import { extractSection } from "../../shared/markdown.js";
import type { TaskDecision } from "./run-coordinator-ports.js";

/** Vaiko task juodraštis — ta pati forma kaip `TaskDecision.child_tasks` įrašo. */
export type ChildTaskDraft = NonNullable<TaskDecision["child_tasks"]>[number];

export type TaskSplitPlan = {
  required: boolean;
  reason: string[];
  parent_task_id: string;
  first_task: string;
  child_tasks: Required<ChildTaskDraft>[];
  parts: number;
};

type TaskSections = {
  specSource: string;
  goal: string;
  agents: string;
  files: string;
  actions: string[];
  checks: string;
  stop: string;
  excluded: string;
};

export function shouldSplitTask(metrics: TaskSizeMetrics, limits: TaskSizeLimitsView): string[] {
  return exceedsLimits(metrics, limits);
}

export function buildTaskSplitPlan(taskText: string, parentTaskId: string, limits: TaskSizeLimitsView): TaskSplitPlan {
  const metrics = measureTaskSize(taskText);
  const violations = shouldSplitTask(metrics, limits);
  const sections = parseTaskSections(taskText);
  const actionParts = chunk(actionsOrFallback(sections), Math.max(1, Math.min(3, limits.maxActionBullets)));
  const allowedPathParts = chunk(allowedPaths(taskText), Math.max(1, limits.maxAllowedPaths));
  const partCount = Math.max(2, actionParts.length, allowedPathParts.length);
  const taskParts = Array.from({ length: partCount }, (_, index) =>
    renderTaskPart({
      parentTaskId,
      partIndex: index + 1,
      partCount,
      sections,
      actions: actionParts[index] ?? actionParts[actionParts.length - 1] ?? [sections.goal || "Implement scoped task part"],
      allowedPaths: allowedPathParts[index] ?? allowedPathParts[allowedPathParts.length - 1] ?? [],
    }),
  );

  return {
    required: violations.length > 0,
    reason: violations,
    parent_task_id: parentTaskId,
    first_task: taskParts[0] ?? taskText,
    child_tasks: taskParts.slice(1).map((claudeTask, index) => ({
      title: splitTitle(sections.goal, index + 2),
      claude_task: claudeTask,
    })),
    parts: taskParts.length,
  };
}

function parseTaskSections(taskText: string): TaskSections {
  return {
    specSource: extractSection(taskText, "## Spec source"),
    goal: firstNonEmptyLine(extractSection(taskText, "## Tikslas")),
    agents: extractSection(taskText, "## Agentai"),
    files: extractSection(taskText, "## Failai"),
    actions: bulletLines(extractSection(taskText, "## Veiksmas")),
    checks: extractSection(taskText, "## Patikra"),
    stop: extractSection(taskText, "## Stop"),
    excluded: extractSection(taskText, "## Neįtraukta"),
  };
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function bulletLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim());
}

function actionsOrFallback(sections: TaskSections): string[] {
  return sections.actions.length > 0 ? sections.actions : [sections.goal || "Implement scoped task part"];
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function renderTaskPart(args: {
  parentTaskId: string;
  partIndex: number;
  partCount: number;
  sections: TaskSections;
  actions: string[];
  allowedPaths: string[];
}): string {
  const title = splitTitle(args.sections.goal, args.partIndex);
  const dependencies = args.partIndex === 1 ? "" : `\n## Dependencies\n- blocked_by: ${args.parentTaskId}\n`;
  const allowed =
    args.allowedPaths.length > 0 ? args.allowedPaths.map((item) => `- \`${item}\``).join("\n") : "- `AG/**`";
  const excluded = [
    args.sections.excluded,
    `Original oversized task split into ${args.partCount} parts. This part is ${args.partIndex}/${args.partCount}.`,
  ]
    .filter(Boolean)
    .join("\n");

  return `# Task\n\n## Spec source\n${args.sections.specSource || "openspec/changes/unknown"}\n\n## Tikslas\n${title}.\n${dependencies}\n## Agentai\n${args.sections.agents || "coder"}\n\n## Failai\nLeidžiama:\n${allowed}\n\n## Veiksmas\n${args.actions.map((action) => `- ${action}`).join("\n")}\n\n## Patikra\n${args.sections.checks || "- `npm run test`"}\n\n## Stop\n${args.sections.stop || "Sustoti, kai patikros praeina."}\n\n## Neįtraukta\n${excluded}\n`;
}

function splitTitle(goal: string, partIndex: number): string {
  const base = goal.replace(/[.]+$/g, "").trim() || "Scoped task";
  return `${base} — part ${partIndex}`;
}
