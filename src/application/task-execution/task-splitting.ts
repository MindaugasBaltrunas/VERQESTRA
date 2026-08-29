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
import { extractSection, findSectionBounds } from "../../shared/markdown.js";
import { detectHallucinatedAllowedPaths } from "../quality-gates/preflight-rules.js";
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
  /**
   * Garsūs log punktai, kai vaiko `## Failai` buvo pakeista tėvo sekcija (žr.
   * `buildTaskSplitPlan` — hallucinated-allowed-path guard). Neprivalomas — senesni fixture'ai
   * jo neturi; `buildTaskSplitPlan` visada grąžina bent tuščią masyvą.
   */
  warnings?: string[];
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

export function buildTaskSplitPlan(
  taskText: string,
  parentTaskId: string,
  limits: TaskSizeLimitsView,
  dirExists: (relativeDir: string) => boolean = () => true,
): TaskSplitPlan {
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

  const warnings: string[] = [];
  const childTaskTexts = taskParts.slice(1).map((claudeTask, index) => {
    const flagged = detectHallucinatedAllowedPaths(claudeTask, dirExists);
    if (flagged.length === 0 || !sections.files) return claudeTask;
    const patched = withOriginalFailaiSection(claudeTask, sections.files, childCommitLogPath(parentTaskId, index + 2));
    if (patched === claudeTask) return claudeTask;
    warnings.push(
      `TASK SPLIT: parent=${parentTaskId} part=${index + 2} hallucinated-allowed-path: referenced ` +
        `non-existent path(s) (${flagged.join(", ")}) — reverted ## Failai to parent section`,
    );
    return patched;
  });

  return {
    required: violations.length > 0,
    reason: violations,
    parent_task_id: parentTaskId,
    first_task: taskParts[0] ?? taskText,
    child_tasks: childTaskTexts.map((claudeTask, index) => ({
      title: splitTitle(sections.goal, index + 2),
      claude_task: claudeTask,
    })),
    parts: taskParts.length,
    warnings,
  };
}

/**
 * Pakeičia vaiko `## Failai` sekcijos KŪNĄ tėvo (pre-split) `## Failai` sekcija — tas pats
 * atstatymo šablonas kaip LLM reformulacijos apsaugoje (045-a-02), taikomas skaidymo vaikams:
 * skaidymo chunk'ai kilę iš PAČIO tėvo `allowedPaths(taskText)`, tad hallucinated kelias čia
 * reiškia, kad tėvas jau turėjo įrodytai sugalvotą kelią PRIEŠ skaidymą.
 */
function withOriginalFailaiSection(claudeTask: string, originalFailaiBody: string, commitLogPath: string): string {
  const lines = claudeTask.split(/\r?\n/);
  const bounds = findSectionBounds(lines, (line) => line.trim() === "## Failai");
  if (bounds === undefined) return claudeTask;
  const restoredBody = insertIntoAllowedBlock(originalFailaiBody, commitLogPath);
  return [...lines.slice(0, bounds.start + 1), restoredBody, "", ...lines.slice(bounds.end)].join("\n");
}

// Ta pati diakritiką toleruojanti taisyklė kaip `domain/tasks/allowed-paths.ts` DENY_MARKER —
// naudojama TIK įterpimo taško paieškai (ne token'ų parsinimui), tad ji negali gyventi ten be
// naujo eksporto, kurio šis 066 task'as neapima (domain/** uždrausta liesti).
const DENY_MARKER_LINE = /^\s*Draud[žz]iama\b/i;

/**
 * Įterpia naują `Leidžiama:` bullet'ą PRIEŠ `Draudžiama:` žymeklį, jei jis yra tėvo `## Failai`
 * kūne — ne aklai teksto pabaigoje. Aklas append'as čia būtų reiškęs, kad `commitLogPath`
 * atsiduria PO `Draudžiama:` žymeklio: `domain/tasks/allowed-paths.ts` `forbiddenBlock()` ima
 * VISKĄ nuo Draudžiama iki kito Leidžiama, tad vaiko paties commit-log kelias būtų užregistruotas
 * kaip DRAUDŽIAMAS — tiesiogiai prieštaraujant to paties vaiko `## Stop` nurodymui.
 */
function insertIntoAllowedBlock(failaiBody: string, path: string): string {
  const lines = failaiBody.split(/\r?\n/);
  const denyIndex = lines.findIndex((line) => DENY_MARKER_LINE.test(line));
  const bullet = `- \`${path}\``;
  if (denyIndex === -1) return [...lines, bullet].join("\n");
  return [...lines.slice(0, denyIndex), bullet, ...lines.slice(denyIndex)].join("\n");
}

/**
 * Vaiko unikalus commit-msg kelias (066): `renderTaskPart` anksčiau kopijuodavo tėvo `## Stop`
 * tekstą su tėvo commit-msg keliu į kiekvieną dalį nepakeistą, tad visi vienos šeimos vaikai
 * dalinosi VIENU keliu ir jų write set'ai kirtosi vien dėl to (GeoGravity 1150-a/b/c) — pats
 * splitter'is blokavo savo vaikų lygiagretumą. `partIndex` (2..partCount) garantuoja unikalumą
 * tarp brolių iš to paties skaidymo.
 */
function childCommitLogPath(parentTaskId: string, partIndex: number): string {
  return `logs/tasks/${parentTaskId}-${partIndex}-commit-msg.md`;
}

const COMMIT_LOG_PATH_PATTERN = /[\w./-]*commit-msg\.md/g;

/** Pakeičia commit-msg kelią tėvo Stop tekste; jei kelio nėra, jis pridedamas prie teksto pabaigos. */
function withUniqueCommitLogPath(stopText: string, commitLogPath: string): string {
  const replaced = stopText.replace(COMMIT_LOG_PATH_PATTERN, commitLogPath);
  if (replaced !== stopText) return replaced;
  const suffix = `Kai baigsi, įrašyk commit žinutę į \`${commitLogPath}\` ir sustok.`;
  return stopText ? `${stopText}\n${suffix}` : suffix;
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
  const commitLogPath = args.partIndex > 1 ? childCommitLogPath(args.parentTaskId, args.partIndex) : undefined;
  const baseStop = args.sections.stop || "Sustoti, kai patikros praeina.";
  const stop = commitLogPath === undefined ? baseStop : withUniqueCommitLogPath(baseStop, commitLogPath);
  const baseAllowedPaths = args.allowedPaths.length > 0 ? args.allowedPaths : ["AG/**"];
  const allowedPathList = commitLogPath === undefined ? baseAllowedPaths : [...baseAllowedPaths, commitLogPath];
  const allowed = allowedPathList.map((item) => `- \`${item}\``).join("\n");
  const excluded = [
    args.sections.excluded,
    `Original oversized task split into ${args.partCount} parts. This part is ${args.partIndex}/${args.partCount}.`,
  ]
    .filter(Boolean)
    .join("\n");

  return `# Task\n\n## Spec source\n${args.sections.specSource || "openspec/changes/unknown"}\n\n## Tikslas\n${title}.\n${dependencies}\n## Agentai\n${args.sections.agents || "coder"}\n\n## Failai\nLeidžiama:\n${allowed}\n\n## Veiksmas\n${args.actions.map((action) => `- ${action}`).join("\n")}\n\n## Patikra\n${args.sections.checks || "- `npm run test`"}\n\n## Stop\n${stop}\n\n## Neįtraukta\n${excluded}\n`;
}

function splitTitle(goal: string, partIndex: number): string {
  const base = goal.replace(/[.]+$/g, "").trim() || "Scoped task";
  return `${base} — part ${partIndex}`;
}
