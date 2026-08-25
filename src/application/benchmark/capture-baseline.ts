// benchmark application use-case: skaito užšaldytą benchmark konfigūraciją ir append-only
// telemetrijos žurnalus, taiko grynas metrikos taisykles iš domain/metrics ir sudeda
// optimizacijos baseline raportą. Elgesio etalonas: AG_loop
// application/benchmark/capture-baseline.ts (capture pusė). Visas IO — per
// BenchmarkCaptureFsPort; domain modulis lieka grynas.
//
// Telemetrijos pastaba: `task-events.jsonl` skaitomas VIETINIU atlaidžiu parseriu —
// nutrūkusi eilutė privalo degraduoti į suskaičiuotą integrity warning'ą, ne nuversti
// visą raportą. Priešingai, `token-usage.jsonl` čia skaitomas GRIEŽTAI (kaip etalono
// `readTokenUsageRecords`): benchmark'as yra integrity kelias, tad sugadinta usage eilutė
// yra klaida, ne praleidimas.

import path from "node:path";
import {
  BENCHMARK_REPORT_SCHEMA_VERSION,
  addUsageTotals,
  assignTaskToCase,
  computeTaskMetrics,
  computeTokensPerVerifiedAcceptedChange,
  emptyUsageTotals,
  matchingCaseIds,
  summarizeCase,
  summarizeTasks,
  usageTotalsFromEntry,
  type BenchmarkCaseDefinition,
  type BenchmarkCaseResult,
  type BenchmarkEventEntry,
  type BenchmarkTaskMetrics,
  type BenchmarkTotals,
  type BenchmarkUsageEntry,
  type TokensPerAcceptedChange,
} from "../../domain/metrics/index.js";
import {
  benchmarkPaths,
  loadOptimizationBenchmarkConfig,
  type BenchmarkCaptureFsPort,
} from "./optimization-config.js";

export type BenchmarkIntegrity = {
  usage_records: number;
  event_records: number;
  malformed_event_lines: number;
  unassigned_task_ids: string[];
  unassigned_usage_records: number;
  unassigned_total_tokens: number;
  ambiguous_task_ids: { task_id: string; case_ids: string[] }[];
  ok: boolean;
};

export type BenchmarkReport = {
  schema_version: typeof BENCHMARK_REPORT_SCHEMA_VERSION;
  generated_at: string;
  config_version: number;
  config_hash: string;
  config_frozen_at: string;
  token_basis: "total_tokens";
  primary_metric: "tokens_per_verified_accepted_change";
  case_ids: string[];
  cases: BenchmarkCaseResult[];
  tasks: BenchmarkTaskMetrics[];
  totals: BenchmarkTotals;
  tokens_per_verified_accepted_change: TokensPerAcceptedChange;
  integrity: BenchmarkIntegrity;
  warnings: string[];
};

export type CaptureBenchmarkOptions = {
  /** VERQESTRA runtime šaknis (vq/…). Default: <cwd>/vq. */
  runtimeRoot?: string;
  configPath?: string;
  usageLogPath?: string;
  eventsLogPath?: string;
  now?: Date;
};

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Griežtas usage skaitymas (etalono `readTokenUsageRecords` semantika): trūkstamas failas
 * — tuščias sąrašas; sugadinta JSON eilutė arba eilutė be phase/task_id/model — klaida.
 */
function parseBenchmarkUsageEntries(raw: string | undefined): BenchmarkUsageEntry[] {
  const entries: BenchmarkUsageEntry[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;

    const record = JSON.parse(line) as Record<string, unknown>;
    const phase = record["phase"];
    const taskId = record["task_id"];
    const model = record["model"];
    if (typeof phase !== "string" || typeof model !== "string" || typeof taskId !== "string") {
      throw new Error("Invalid token usage log record: phase, task_id, and model are required");
    }

    const attempt = record["attempt"];
    const outcome = record["outcome"];
    const retryReason = record["retry_reason"];
    const numTurns = record["num_turns"];
    entries.push({
      task_id: taskId,
      phase,
      model: model || "none",
      input_tokens: numericUsage(record["input_tokens"]),
      output_tokens: numericUsage(record["output_tokens"]),
      cache_read_input_tokens: numericUsage(record["cache_read_input_tokens"]),
      cache_creation_input_tokens: numericUsage(record["cache_creation_input_tokens"]),
      total_cost_usd: numericUsage(record["total_cost_usd"]),
      ...(typeof attempt === "number" && Number.isFinite(attempt) ? { attempt } : {}),
      ...(outcome === "succeeded" || outcome === "failed" || outcome === "infrastructure" ? { outcome } : {}),
      ...(typeof retryReason === "string" ? { retry_reason: retryReason } : {}),
      ...(typeof numTurns === "number" && Number.isFinite(numTurns) ? { num_turns: numTurns } : {}),
    });
  }
  return entries;
}

/** Atlaidus task-events skaitymas: sugadinta eilutė suskaičiuojama, ne metama (žr. antraštę). */
function parseBenchmarkEvents(raw: string | undefined): { events: BenchmarkEventEntry[]; malformed: number } {
  const events: BenchmarkEventEntry[] = [];
  let malformed = 0;

  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      malformed += 1;
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const taskId = record["task_id"];
    const toState = record["to_state"];
    if (typeof taskId !== "string" || typeof toState !== "string") {
      malformed += 1;
      continue;
    }

    const reason = record["reason"];
    const phase = record["phase"];
    const verdict = record["verdict"];
    const exitCode = record["exit_code"];
    events.push({
      task_id: taskId,
      to_state: toState,
      reason: typeof reason === "string" ? reason : "",
      ...(typeof phase === "string" ? { phase } : {}),
      ...(typeof verdict === "string" ? { verdict } : {}),
      ...(typeof exitCode === "number" ? { exit_code: exitCode } : {}),
    });
  }

  return { events, malformed };
}

export async function captureBenchmarkReport(
  fs: BenchmarkCaptureFsPort,
  options: CaptureBenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const runtimeRoot = options.runtimeRoot ?? path.join(process.cwd(), "vq");
  const defaults = benchmarkPaths(runtimeRoot);
  const { config, hash } = await loadOptimizationBenchmarkConfig(fs, options.configPath ?? defaults.configPath);

  const usageEntries = parseBenchmarkUsageEntries(
    await fs.readTextFileIfExists(options.usageLogPath ?? defaults.usageLogPath),
  );
  const { events, malformed } = parseBenchmarkEvents(
    await fs.readTextFileIfExists(options.eventsLogPath ?? defaults.eventsLogPath),
  );

  const usageByTask = groupBy(usageEntries, (entry) => entry.task_id);
  const eventsByTask = groupBy(events, (event) => event.task_id);
  const taskIds = [...new Set([...usageByTask.keys(), ...eventsByTask.keys()])].sort();

  const cases: BenchmarkCaseDefinition[] = config.cases;
  const warnings: string[] = [];
  const unassigned: string[] = [];
  const ambiguous: { task_id: string; case_ids: string[] }[] = [];
  const tasks: BenchmarkTaskMetrics[] = [];
  let unassignedUsageRecords = 0;
  let unassignedUsageTotals = emptyUsageTotals();

  for (const taskId of taskIds) {
    const matches = matchingCaseIds(taskId, cases);
    if (matches.length > 1) {
      ambiguous.push({ task_id: taskId, case_ids: matches });
      warnings.push(`task ${taskId} matches multiple benchmark cases: ${matches.join(", ")}`);
    }

    const assigned = assignTaskToCase(taskId, cases);
    if (!assigned) {
      unassigned.push(taskId);
      warnings.push(`task ${taskId} does not match any frozen benchmark case`);
      const orphanedUsage = usageByTask.get(taskId) ?? [];
      unassignedUsageRecords += orphanedUsage.length;
      for (const entry of orphanedUsage) {
        unassignedUsageTotals = addUsageTotals(unassignedUsageTotals, usageTotalsFromEntry(entry));
      }
      continue;
    }

    tasks.push(
      computeTaskMetrics({
        task_id: taskId,
        case_id: assigned.id,
        category: assigned.category,
        usage: usageByTask.get(taskId) ?? [],
        events: eventsByTask.get(taskId) ?? [],
      }),
    );
  }

  const caseResults = cases.map((definition) =>
    summarizeCase(
      definition,
      tasks.filter((task) => task.case_id === definition.id),
    ),
  );
  for (const caseResult of caseResults) {
    if (!caseResult.comparable) {
      warnings.push(`case ${caseResult.case_id} is not comparable: ${caseResult.reason}`);
    }
  }
  if (malformed > 0) {
    warnings.push(`${malformed} malformed task-event line(s) skipped`);
  }

  const totals = summarizeTasks(tasks);

  return {
    schema_version: BENCHMARK_REPORT_SCHEMA_VERSION,
    generated_at: (options.now ?? new Date()).toISOString(),
    config_version: config.version,
    config_hash: hash,
    config_frozen_at: config.frozen_at,
    token_basis: config.token_basis,
    primary_metric: config.primary_metric,
    case_ids: cases.map((definition) => definition.id).sort(),
    cases: caseResults,
    tasks: [...tasks].sort((a, b) => a.task_id.localeCompare(b.task_id)),
    totals,
    tokens_per_verified_accepted_change: computeTokensPerVerifiedAcceptedChange(
      totals.usage.total_tokens,
      totals.accepted_changes,
    ),
    integrity: {
      usage_records: usageEntries.length,
      event_records: events.length,
      malformed_event_lines: malformed,
      unassigned_task_ids: [...unassigned].sort(),
      unassigned_usage_records: unassignedUsageRecords,
      unassigned_total_tokens: unassignedUsageTotals.total_tokens,
      ambiguous_task_ids: [...ambiguous].sort((a, b) => a.task_id.localeCompare(b.task_id)),
      ok: malformed === 0 && ambiguous.length === 0 && unassignedUsageTotals.total_tokens === 0,
    },
    warnings: warnings.sort(),
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(key(item));
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(key(item), [item]);
    }
  }
  return grouped;
}
