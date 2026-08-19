// Benchmark suvestinės: task'ų rinkinio totals ir case rezultatas su comparability
// taisykle. Pure. Behaviour etalon: AG_loop domain/metrics/accepted-change.ts
// (totals pusė; WBR VQ-204 skaidymas).

import { addUsageTotals, emptyUsageTotals, type BenchmarkUsageTotals } from "./usage.js";
import { computeTokensPerVerifiedAcceptedChange, type TokensPerAcceptedChange } from "./acceptance-gates.js";
import type { BenchmarkCaseDefinition } from "./cases.js";
import type { BenchmarkTaskMetrics } from "./task-metrics.js";

export const BENCHMARK_REPORT_SCHEMA_VERSION = 1;

export type BenchmarkTotals = {
  measured_tasks: number;
  task_count: number;
  usage: BenchmarkUsageTotals;
  llm_calls: number;
  turns: number;
  first_pass_tasks: number;
  first_pass_rate: number | null;
  repair_total: number;
  human_review_total: number;
  out_of_scope_file_total: number;
  accepted_changes: number;
};

export type BenchmarkCaseResult = {
  case_id: string;
  category: string;
  size_class: "small" | "medium" | "large";
  /** Copied from the frozen definition so the rendered report is self-describing and round-trips. */
  task_id_patterns: string[];
  task_ids: string[];
  task_count: number;
  min_tasks: number;
  comparable: boolean;
  reason: string;
  totals: BenchmarkTotals;
  tokens_per_verified_accepted_change: TokensPerAcceptedChange;
};

export function summarizeTasks(tasks: BenchmarkTaskMetrics[]): BenchmarkTotals {
  const usage = tasks.reduce<BenchmarkUsageTotals>(
    (totals, task) => addUsageTotals(totals, task.usage),
    emptyUsageTotals(),
  );
  const measuredTasks = tasks.filter((task) => task.measurable).length;
  const firstPassTasks = tasks.filter((task) => task.first_pass).length;

  return {
    measured_tasks: measuredTasks,
    task_count: tasks.length,
    usage,
    llm_calls: tasks.reduce((sum, task) => sum + task.llm_calls, 0),
    turns: tasks.reduce((sum, task) => sum + task.turns, 0),
    first_pass_tasks: firstPassTasks,
    first_pass_rate: measuredTasks === 0 ? null : Math.round((firstPassTasks / measuredTasks) * 10000) / 10000,
    repair_total: tasks.reduce((sum, task) => sum + task.repair_count, 0),
    human_review_total: tasks.reduce((sum, task) => sum + task.human_review_count, 0),
    out_of_scope_file_total: tasks.reduce((sum, task) => sum + task.out_of_scope_files.length, 0),
    accepted_changes: tasks.filter((task) => task.acceptance.accepted).length,
  };
}

export function summarizeCase(definition: BenchmarkCaseDefinition, tasks: BenchmarkTaskMetrics[]): BenchmarkCaseResult {
  const totals = summarizeTasks(tasks);
  const comparable = tasks.length >= definition.min_tasks;
  return {
    case_id: definition.id,
    category: definition.category,
    size_class: definition.size_class,
    task_id_patterns: [...definition.task_id_patterns],
    task_ids: tasks.map((task) => task.task_id).sort(),
    task_count: tasks.length,
    min_tasks: definition.min_tasks,
    comparable,
    reason: comparable ? "" : `case has ${tasks.length} task(s), needs ${definition.min_tasks}`,
    totals,
    tokens_per_verified_accepted_change: computeTokensPerVerifiedAcceptedChange(
      totals.usage.total_tokens,
      totals.accepted_changes,
    ),
  };
}
