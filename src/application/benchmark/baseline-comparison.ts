// Baseline palyginimo use-case: dabartinis capture prieš išsaugotą baseline, per-case
// deltos ir sėkmės deklaracija. Elgesio etalonas: AG_loop
// application/benchmark/capture-baseline.ts (comparison pusė).

import path from "node:path";
import {
  BENCHMARK_REPORT_SCHEMA_VERSION,
  canDeclareOptimizationSuccess,
  compareBenchmarkRuns,
  type BenchmarkComparable,
  type BenchmarkComparison,
  type BenchmarkTotals,
  type TokensPerAcceptedChange,
} from "../../domain/metrics/index.js";
import { readBenchmarkBaseline, renderMetric, renderTable } from "./baseline-report.js";
import { captureBenchmarkReport, type BenchmarkReport, type CaptureBenchmarkOptions } from "./capture-baseline.js";
import {
  benchmarkPaths,
  loadOptimizationBenchmarkConfig,
  type BenchmarkCaptureFsPort,
} from "./optimization-config.js";

export type BenchmarkCaseComparison = {
  case_id: string;
  comparable: boolean;
  reason: string;
  baseline_tokens_per_accepted: number | null;
  current_tokens_per_accepted: number | null;
  delta_pct: number | null;
};

export type BenchmarkComparisonReport = {
  schema_version: typeof BENCHMARK_REPORT_SCHEMA_VERSION;
  generated_at: string;
  baseline_ref: { generated_at: string; config_hash: string; config_version: number; case_ids: string[] };
  current: BenchmarkReport;
  baseline_totals: BenchmarkTotals;
  baseline_tokens_per_verified_accepted_change: TokensPerAcceptedChange;
  comparison: BenchmarkComparison;
  case_comparisons: BenchmarkCaseComparison[];
  success_declaration: { allowed: boolean; reason: string };
};

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

function toComparable(report: BenchmarkReport): BenchmarkComparable {
  return {
    config_hash: report.config_hash,
    case_ids: report.case_ids,
    integrity_ok: report.integrity.ok,
    totals: report.totals,
    tokens_per_verified_accepted_change: report.tokens_per_verified_accepted_change,
  };
}

function compareCases(baseline: BenchmarkReport, current: BenchmarkReport): BenchmarkCaseComparison[] {
  const caseIds = [
    ...new Set([...baseline.cases.map((entry) => entry.case_id), ...current.cases.map((entry) => entry.case_id)]),
  ].sort();

  return caseIds.map((caseId) => {
    const baselineCase = baseline.cases.find((entry) => entry.case_id === caseId);
    const currentCase = current.cases.find((entry) => entry.case_id === caseId);
    const baselineValue = baselineCase?.tokens_per_verified_accepted_change.value ?? null;
    const currentValue = currentCase?.tokens_per_verified_accepted_change.value ?? null;

    const reasons: string[] = [];
    if (!baselineCase) reasons.push("case missing in baseline");
    if (!currentCase) reasons.push("case missing in current run");
    if (baselineCase && !baselineCase.comparable) reasons.push(`baseline: ${baselineCase.reason}`);
    if (currentCase && !currentCase.comparable) reasons.push(`current: ${currentCase.reason}`);
    if (baselineCase && baselineCase.tokens_per_verified_accepted_change.status !== "computed") {
      reasons.push(`baseline metric unavailable: ${baselineCase.tokens_per_verified_accepted_change.status}`);
    }
    if (currentCase && currentCase.tokens_per_verified_accepted_change.status !== "computed") {
      reasons.push(`current metric unavailable: ${currentCase.tokens_per_verified_accepted_change.status}`);
    }

    const comparable = reasons.length === 0;
    return {
      case_id: caseId,
      comparable,
      reason: reasons.join("; "),
      baseline_tokens_per_accepted: baselineValue,
      current_tokens_per_accepted: currentValue,
      delta_pct:
        comparable && baselineValue !== null && currentValue !== null && baselineValue !== 0
          ? roundPct(((currentValue - baselineValue) / baselineValue) * 100)
          : null,
    };
  });
}

export async function compareWithBaseline(
  fs: BenchmarkCaptureFsPort,
  options: CaptureBenchmarkOptions & { baselinePath?: string } = {},
): Promise<BenchmarkComparisonReport> {
  const runtimeRoot = options.runtimeRoot ?? path.join(process.cwd(), "vq");
  const defaults = benchmarkPaths(runtimeRoot);
  const { config } = await loadOptimizationBenchmarkConfig(fs, options.configPath ?? defaults.configPath);

  const current = await captureBenchmarkReport(fs, options);
  const baseline = await readBenchmarkBaseline(fs, options.baselinePath ?? defaults.baselinePath);
  const comparison = compareBenchmarkRuns(toComparable(baseline), toComparable(current), {
    maxTokenRegressionPct: config.comparison.max_token_regression_pct,
  });

  return {
    schema_version: BENCHMARK_REPORT_SCHEMA_VERSION,
    generated_at: current.generated_at,
    baseline_ref: {
      generated_at: baseline.generated_at,
      config_hash: baseline.config_hash,
      config_version: baseline.config_version,
      case_ids: baseline.case_ids,
    },
    current,
    baseline_totals: baseline.totals,
    baseline_tokens_per_verified_accepted_change: baseline.tokens_per_verified_accepted_change,
    comparison,
    case_comparisons: compareCases(baseline, current),
    success_declaration: canDeclareOptimizationSuccess(comparison),
  };
}

function renderDelta(value: number | null, suffix: string): string {
  return value === null ? "n/a" : `${value > 0 ? "+" : ""}${value}${suffix}`;
}

export function renderComparisonMarkdown(report: BenchmarkComparisonReport): string {
  const lines: string[] = [
    "# AG Loop optimization benchmark comparison",
    "",
    `- generated_at: ${report.generated_at}`,
    `- baseline_generated_at: ${report.baseline_ref.generated_at}`,
    `- config_hash: ${report.baseline_ref.config_hash}`,
    `- verdict: ${report.comparison.verdict}`,
    `- comparable: ${report.comparison.comparable ? "yes" : "no"}`,
    `- regression_limit_pct: ${report.comparison.regression_limit_pct}`,
    "",
    "## Deltas",
    "",
    ...renderTable(
      ["metric", "baseline", "current", "delta"],
      [
        [
          "total_tokens",
          String(report.baseline_totals.usage.total_tokens),
          String(report.current.totals.usage.total_tokens),
          renderDelta(report.comparison.token_delta_pct, "%"),
        ],
        [
          "tokens_per_verified_accepted_change",
          renderMetric(report.baseline_tokens_per_verified_accepted_change),
          renderMetric(report.current.tokens_per_verified_accepted_change),
          renderDelta(report.comparison.tokens_per_accepted_delta_pct, "%"),
        ],
        [
          "accepted_changes",
          String(report.baseline_totals.accepted_changes),
          String(report.current.totals.accepted_changes),
          renderDelta(report.comparison.accepted_change_delta, ""),
        ],
        [
          "first_pass_rate",
          report.baseline_totals.first_pass_rate === null ? "n/a" : String(report.baseline_totals.first_pass_rate),
          report.current.totals.first_pass_rate === null ? "n/a" : String(report.current.totals.first_pass_rate),
          renderDelta(report.comparison.first_pass_rate_delta_pp, "pp"),
        ],
        [
          "human_review_total",
          String(report.baseline_totals.human_review_total),
          String(report.current.totals.human_review_total),
          renderDelta(report.comparison.human_review_delta, ""),
        ],
        [
          "out_of_scope_file_total",
          String(report.baseline_totals.out_of_scope_file_total),
          String(report.current.totals.out_of_scope_file_total),
          renderDelta(report.comparison.out_of_scope_delta, ""),
        ],
      ],
    ),
    "",
    "## Per-case comparison",
    "",
    ...renderTable(
      ["case", "baseline tokens/accepted", "current tokens/accepted", "delta", "comparable"],
      report.case_comparisons.map((entry) => [
        entry.case_id,
        entry.baseline_tokens_per_accepted === null ? "n/a" : String(entry.baseline_tokens_per_accepted),
        entry.current_tokens_per_accepted === null ? "n/a" : String(entry.current_tokens_per_accepted),
        renderDelta(entry.delta_pct, "%"),
        entry.comparable ? "yes" : `no (${entry.reason})`,
      ]),
    ),
    "",
    "## Success declaration",
    "",
    `- allowed: ${report.success_declaration.allowed ? "yes" : "no"}`,
    `- reason: ${report.success_declaration.reason}`,
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "",
  ];

  return lines.join("\n");
}

export function renderComparisonText(report: BenchmarkComparisonReport): string {
  const lines: string[] = [
    `optimization benchmark comparison: ${report.comparison.verdict}`,
    `baseline ${report.baseline_ref.generated_at} -> current ${report.generated_at}`,
    `config_hash: ${report.baseline_ref.config_hash}`,
    "",
    `total_tokens: ${report.baseline_totals.usage.total_tokens} -> ${report.current.totals.usage.total_tokens} (${renderDelta(report.comparison.token_delta_pct, "%")})`,
    `tokens_per_verified_accepted_change: ${renderMetric(report.baseline_tokens_per_verified_accepted_change)} -> ${renderMetric(report.current.tokens_per_verified_accepted_change)} (${renderDelta(report.comparison.tokens_per_accepted_delta_pct, "%")})`,
    `accepted_changes: ${renderDelta(report.comparison.accepted_change_delta, "")}`,
    `first_pass_rate: ${renderDelta(report.comparison.first_pass_rate_delta_pp, "pp")}`,
    `human_review: ${renderDelta(report.comparison.human_review_delta, "")}, out_of_scope: ${renderDelta(report.comparison.out_of_scope_delta, "")}`,
    "",
    `success declaration: ${report.success_declaration.allowed ? "allowed" : "blocked"} — ${report.success_declaration.reason}`,
  ];

  if (report.comparison.reasons.length > 0) {
    lines.push("reasons:", ...report.comparison.reasons.map((reason) => `  - ${reason}`));
  }

  return lines.join("\n");
}

export async function writeBenchmarkComparison(
  fs: BenchmarkCaptureFsPort,
  report: BenchmarkComparisonReport,
  filePath: string,
): Promise<string> {
  await fs.makeDirectory(path.dirname(filePath));
  await fs.writeTextFile(filePath, renderComparisonMarkdown(report));
  return filePath;
}
