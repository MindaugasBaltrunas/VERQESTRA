// Baseline raporto renderiai ir round-trip parseris. Elgesio etalonas: AG_loop
// application/benchmark/capture-baseline.ts (render/parse pusė). Markdown failas neša
// pilną JSON bloką po markeriu, tad `parseBenchmarkReportMarkdown(render(x)) == x`.

import path from "node:path";
import { z } from "zod";
import {
  BENCHMARK_REPORT_SCHEMA_VERSION,
  addUsageTotals,
  emptyUsageTotals,
  type BenchmarkPhaseUsage,
  type BenchmarkTaskMetrics,
  type TokensPerAcceptedChange,
} from "../../domain/metrics/index.js";
import { parseWithSchema } from "../../shared/schema.js";
import type { BenchmarkReport } from "./capture-baseline.js";
import type { BenchmarkCaptureFsPort } from "./optimization-config.js";

export const BENCHMARK_REPORT_MARKER = "<!-- ag:optimization-benchmark:v1 -->";

function aggregatePhaseUsage(tasks: BenchmarkTaskMetrics[]): BenchmarkPhaseUsage[] {
  const grouped = new Map<string, BenchmarkPhaseUsage>();
  for (const task of tasks) {
    for (const entry of task.phase_usage) {
      const key = `${entry.phase}|${entry.model}`;
      const current = grouped.get(key) ?? {
        phase: entry.phase,
        canonical_phase: entry.canonical_phase,
        model: entry.model,
        records: 0,
        llm_calls: 0,
        usage: emptyUsageTotals(),
      };
      current.records += entry.records;
      current.llm_calls += entry.llm_calls;
      current.usage = addUsageTotals(current.usage, entry.usage);
      grouped.set(key, current);
    }
  }
  return [...grouped.values()].sort((a, b) => a.phase.localeCompare(b.phase) || a.model.localeCompare(b.model));
}

export function renderMetric(metric: TokensPerAcceptedChange): string {
  return metric.value === null ? `n/a (${metric.status})` : String(metric.value);
}

export function renderTable(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

export function renderBenchmarkReportMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [
    "# AG Loop optimization benchmark baseline",
    "",
    `- generated_at: ${report.generated_at}`,
    `- config_version: ${report.config_version}`,
    `- config_frozen_at: ${report.config_frozen_at}`,
    `- config_hash: ${report.config_hash}`,
    `- token_basis: ${report.token_basis}`,
    `- primary_metric: ${report.primary_metric}`,
    `- schema_version: ${report.schema_version}`,
    "",
    "## Frozen benchmark cases",
    "",
    ...renderTable(
      ["case", "category", "size", "patterns", "tasks", "comparable"],
      report.cases.map((benchmarkCase) => [
        benchmarkCase.case_id,
        benchmarkCase.category,
        benchmarkCase.size_class,
        benchmarkCase.task_id_patterns.join(" "),
        String(benchmarkCase.task_count),
        benchmarkCase.comparable ? "yes" : `no (${benchmarkCase.reason})`,
      ]),
    ),
    "",
    "## Per-task results",
    "",
    ...renderTable(
      [
        "task_id",
        "case",
        "total_tokens",
        "llm_calls",
        "turns",
        "first_pass",
        "repairs",
        "human_review",
        "out_of_scope",
        "terminal",
        "accepted",
      ],
      report.tasks.map((task) => [
        task.task_id,
        task.case_id ?? "-",
        String(task.usage.total_tokens),
        String(task.llm_calls),
        String(task.turns),
        task.first_pass ? "yes" : "no",
        String(task.repair_count),
        String(task.human_review_count),
        String(task.out_of_scope_files.length),
        task.terminal_state,
        task.acceptance.accepted ? "yes" : "no",
      ]),
    ),
    "",
    "## Phase usage",
    "",
    ...renderTable(
      ["phase", "canonical", "model", "records", "llm_calls", "input", "output", "cache_read", "cache_creation", "total"],
      aggregatePhaseUsage(report.tasks).map((entry) => [
        entry.phase,
        entry.canonical_phase,
        entry.model,
        String(entry.records),
        String(entry.llm_calls),
        String(entry.usage.input_tokens),
        String(entry.usage.output_tokens),
        String(entry.usage.cache_read_input_tokens),
        String(entry.usage.cache_creation_input_tokens),
        String(entry.usage.total_tokens),
      ]),
    ),
    "",
    "## Totals",
    "",
    `- measured_tasks: ${report.totals.measured_tasks}`,
    `- task_count: ${report.totals.task_count}`,
    `- total_tokens: ${report.totals.usage.total_tokens}`,
    `- billable_tokens: ${report.totals.usage.billable_tokens}`,
    `- total_cost_usd: ${report.totals.usage.total_cost_usd}`,
    `- llm_calls: ${report.totals.llm_calls}`,
    `- turns: ${report.totals.turns}`,
    `- first_pass_tasks: ${report.totals.first_pass_tasks}`,
    `- first_pass_rate: ${report.totals.first_pass_rate === null ? "n/a" : report.totals.first_pass_rate}`,
    `- repair_total: ${report.totals.repair_total}`,
    `- human_review_total: ${report.totals.human_review_total}`,
    `- out_of_scope_file_total: ${report.totals.out_of_scope_file_total}`,
    `- accepted_changes: ${report.totals.accepted_changes}`,
    "",
    "## tokens_per_verified_accepted_change",
    "",
    `- value: ${renderMetric(report.tokens_per_verified_accepted_change)}`,
    `- status: ${report.tokens_per_verified_accepted_change.status}`,
    `- total_tokens: ${report.tokens_per_verified_accepted_change.total_tokens}`,
    `- accepted_changes: ${report.tokens_per_verified_accepted_change.accepted_changes}`,
    `- note: ${report.tokens_per_verified_accepted_change.note || "-"}`,
    "",
    "## Integrity and warnings",
    "",
    `- integrity_ok: ${report.integrity.ok ? "yes" : "no"}`,
    `- usage_records: ${report.integrity.usage_records}`,
    `- event_records: ${report.integrity.event_records}`,
    `- malformed_event_lines: ${report.integrity.malformed_event_lines}`,
    `- unassigned_task_ids: ${report.integrity.unassigned_task_ids.join(", ") || "-"}`,
    `- ambiguous_task_ids: ${report.integrity.ambiguous_task_ids.map((entry) => `${entry.task_id} -> ${entry.case_ids.join("/")}`).join(", ") || "-"}`,
    ...(report.warnings.length > 0 ? report.warnings.map((warning) => `- warning: ${warning}`) : ["- warning: -"]),
    "",
    BENCHMARK_REPORT_MARKER,
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "",
  ];

  return lines.join("\n");
}

// Vokas laisvas (looseObject): raportas yra generuotas output'as, o čia tikrinama tik
// tiek, kiek round-trip skaitytojas realiai naudoja.
const benchmarkReportEnvelopeSchema = z.looseObject({
  schema_version: z.literal(BENCHMARK_REPORT_SCHEMA_VERSION),
  config_hash: z.string().min(1),
  case_ids: z.array(z.string()),
  totals: z.looseObject({}),
  tokens_per_verified_accepted_change: z.looseObject({}),
  integrity: z.looseObject({}),
});

export function parseBenchmarkReportMarkdown(markdown: string, label = "optimization baseline report"): BenchmarkReport {
  const markerIndex = markdown.indexOf(BENCHMARK_REPORT_MARKER);
  if (markerIndex < 0) {
    throw new Error(`optimization baseline report marker not found in ${label}`);
  }

  const block = /```json\r?\n([\s\S]*?)```/.exec(markdown.slice(markerIndex + BENCHMARK_REPORT_MARKER.length));
  if (!block) {
    throw new Error(`optimization baseline report JSON block not found in ${label}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block[1] ?? "");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`optimization baseline report is not valid JSON: ${message}`, { cause: error });
  }

  parseWithSchema(benchmarkReportEnvelopeSchema, parsed, label);
  return parsed as BenchmarkReport;
}

export function renderBenchmarkReportText(report: BenchmarkReport): string {
  const lines: string[] = [
    `optimization benchmark (config ${report.config_version}, frozen ${report.config_frozen_at})`,
    `config_hash: ${report.config_hash}`,
    `generated_at: ${report.generated_at}`,
    "",
    `tokens_per_verified_accepted_change: ${renderMetric(report.tokens_per_verified_accepted_change)} [${report.tokens_per_verified_accepted_change.status}]`,
    `total_tokens: ${report.totals.usage.total_tokens} (billable ${report.totals.usage.billable_tokens})`,
    `accepted_changes: ${report.totals.accepted_changes} of ${report.totals.measured_tasks} measured task(s)`,
    `first_pass_rate: ${report.totals.first_pass_rate === null ? "n/a" : report.totals.first_pass_rate}`,
    `human_review_total: ${report.totals.human_review_total}, out_of_scope_files: ${report.totals.out_of_scope_file_total}`,
    "",
    "cases:",
    ...report.cases.map(
      (benchmarkCase) =>
        `  ${benchmarkCase.case_id}: ${benchmarkCase.task_count} task(s), ${renderMetric(benchmarkCase.tokens_per_verified_accepted_change)} tokens/accepted${benchmarkCase.comparable ? "" : ` — not comparable (${benchmarkCase.reason})`}`,
    ),
    "",
    `integrity: ${report.integrity.ok ? "ok" : "problems detected"} (usage ${report.integrity.usage_records}, events ${report.integrity.event_records}, malformed ${report.integrity.malformed_event_lines})`,
  ];

  if (report.warnings.length > 0) {
    lines.push("warnings:", ...report.warnings.map((warning) => `  - ${warning}`));
  }

  return lines.join("\n");
}

export async function writeBenchmarkBaseline(
  fs: BenchmarkCaptureFsPort,
  report: BenchmarkReport,
  filePath: string,
): Promise<string> {
  await fs.makeDirectory(path.dirname(filePath));
  await fs.writeTextFile(filePath, renderBenchmarkReportMarkdown(report));
  return filePath;
}

export async function readBenchmarkBaseline(fs: BenchmarkCaptureFsPort, filePath: string): Promise<BenchmarkReport> {
  const raw = await fs.readTextFileIfExists(filePath);
  if (raw === undefined) {
    throw new Error(`optimization baseline not found: ${filePath}`);
  }
  return parseBenchmarkReportMarkdown(raw, filePath);
}
