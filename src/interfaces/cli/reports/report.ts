// `report` CLI adapteris (etalonas: interfaces/cli/report/index.ts 1:1). Lokali
// telemetrijos ataskaita: bucket'ų/ledger skaičiai, token-usage santraukos
// (application/analytics), adapterių deklaracijos (per struktūrinę view formą — realios
// gyvena infrastructure), kompresijos kohortos ir canary arrests. Keliai: task bucket'ai
// `<root>/AG/tasks`, ledger/logai — vq runtime šaknis.

import path from "node:path";
import {
  buildCompressionCohortReport,
  selectCohortTaskEvents,
  COHORT_MIN_SAMPLE,
  type CohortRow,
  type CompressionCohortReport,
} from "../../../application/analytics/compression-cohorts.js";
import {
  parseTokenUsageSummaryLines,
  summarizeTokenUsage,
  summarizeTokenUsageByModel,
  type TokenUsageAdapterSummary,
  type TokenUsageSummaryRecord,
} from "../../../application/analytics/token-usage-summary.js";
import { parseJsonlObjects, parseTolerantUsageRecords } from "../../../application/learning/usage-view.js";
import {
  latestContextSizeMetrics,
  readContextSizeMetrics,
  type ContextSizeMetricsRecord,
} from "../../../application/context-pack/metrics.js";
import { readContextCompressionArrestState } from "../../../application/context-pack/effective-compression-policy.js";
import { CONTEXT_COMPRESSION_ARREST_RELATIVE_PATH } from "../../../application/context-pack/compression-arrest-observer.js";
import type { ContextPackFileSystemPort } from "../../../application/context-pack/ports.js";
import { taskBuckets as lifecycleTaskBuckets } from "../../../application/task-execution/index.js";
import { consoleCliIo, type CliIo } from "../registry.js";

type ArrestView = Awaited<ReturnType<typeof readContextCompressionArrestState>>;

/** Struktūrinė adapterio deklaracijos forma — infrastructure AdapterCapabilityDeclaration ją tenkina. */
export type AdapterCapabilityView = {
  adapter: string;
  summary: string;
  implemented: Array<{ feature: string }>;
  future: Array<{ feature: string }>;
};

export type ReportCommandDeps = {
  fs: {
    readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
    /** Failų vardai kataloge; `[]` kai katalogo nėra. */
    listFiles(absoluteDir: string): Promise<string[]>;
  };
  contextFs: ContextPackFileSystemPort;
  adapterCapabilities(): AdapterCapabilityView[];
  projectRoot: string;
  /** Numatytoji runtime šaknis — `<projectRoot>/vq`. */
  runtimeRoot?: string;
  nowIso?: () => string;
  io?: CliIo;
};

export type ReportOptions = {
  json?: boolean;
  recentLimit?: number;
};

export type TaskCounts = {
  buckets: Record<string, number>;
  ledgerStates: Record<string, number>;
};

export type RecentOutcome = {
  ts: string;
  task_id: string;
  outcome: string;
  reason: string;
};

export type ContextSizeReport = {
  latest?: ContextSizeMetricsRecord;
  warning?: string;
  /** Canary vs control palyginimas (0004) — tik kai žurnalas turi bent vieną įrašą. */
  cohorts?: CompressionCohortReport;
};

/** Canary arrests (0008) — atskira top-level sekcija: arrest yra dispatch elgesio faktas. */
export type CompressionArrestReport = {
  arrests: ArrestView["state"]["arrests"];
  /** Markeris yra, bet neperskaitomas — visi feature laikomi off. */
  unreadable: boolean;
  unreadableReason?: string;
};

export type LocalTelemetryReport = {
  generatedAt: string;
  localOnly: true;
  taskCounts: TaskCounts;
  tokenUsage: TokenUsageSummaryRecord[];
  adapterUsage: TokenUsageAdapterSummary[];
  adapterCapabilities: AdapterCapabilityView[];
  recentOutcomes: RecentOutcome[];
  contextSize: ContextSizeReport;
  compressionArrests: CompressionArrestReport;
};

// "duplicate" ir "pending" nėra lifecycle bucket'ai — tik ledger-state reikšmės, kurias
// reportas rodo ir kaip nulinius bucket skaičiavimus (etalonas 1:1).
const reportTaskBuckets: string[] = [...lifecycleTaskBuckets, "duplicate", "pending"];

async function countMarkdownFiles(deps: ReportCommandDeps, dir: string): Promise<number> {
  return (await deps.fs.listFiles(dir)).filter((name) => name.endsWith(".md")).length;
}

async function collectTaskCounts(deps: ReportCommandDeps, agRoot: string, runtimeRoot: string): Promise<TaskCounts> {
  const buckets: Record<string, number> = {};
  for (const bucket of reportTaskBuckets) {
    buckets[bucket] = await countMarkdownFiles(deps, path.join(agRoot, "tasks", bucket));
  }

  const ledgerRaw = await deps.fs.readTextFileIfExists(path.join(runtimeRoot, "state", "task-ledger.json"));
  const ledger = ledgerRaw === undefined ? {} : (JSON.parse(ledgerRaw) as Record<string, { state?: unknown }>);
  const ledgerStates: Record<string, number> = {};
  for (const entry of Object.values(ledger)) {
    const state = typeof entry.state === "string" && entry.state.trim() ? entry.state : "unknown";
    ledgerStates[state] = (ledgerStates[state] ?? 0) + 1;
  }

  return { buckets, ledgerStates };
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

async function collectRecentOutcomes(
  deps: ReportCommandDeps,
  runtimeRoot: string,
  limit: number,
): Promise<RecentOutcome[]> {
  const taskEvents = parseJsonlObjects(await deps.fs.readTextFileIfExists(path.join(runtimeRoot, "logs", "task-events.jsonl")));
  if (taskEvents.length > 0) {
    return taskEvents
      .map((record) => ({
        ts: stringField(record, "ts"),
        task_id: stringField(record, "task_id"),
        outcome: stringField(record, "to_state"),
        reason: stringField(record, "reason"),
      }))
      .filter((record) => record.ts && record.task_id && record.outcome)
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, limit);
  }

  const historyRaw = await deps.fs.readTextFileIfExists(path.join(runtimeRoot, "state", "state-history.json"));
  const history = historyRaw === undefined ? [] : (JSON.parse(historyRaw) as Record<string, unknown>[]);
  return history
    .map((record) => ({
      ts: stringField(record, "timestamp"),
      task_id: stringField(record, "task_id"),
      outcome: stringField(record, "result") || stringField(record, "next_folder"),
      reason: stringField(record, "reason"),
    }))
    .filter((record) => record.ts && record.task_id && record.outcome)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
}

async function buildContextSizeReport(
  deps: ReportCommandDeps,
  runtimeRoot: string,
  records: ContextSizeMetricsRecord[],
): Promise<ContextSizeReport> {
  const latest = latestContextSizeMetrics(records);
  if (!latest) {
    return {};
  }

  // Canary ranka gyvena šiame žurnale, bet verdikto įvestys — kituose: tokenai/turn'ai iš
  // token-usage.jsonl, galutinė būsena iš task-events.jsonl. Abu skaitomi tolerantiškai.
  const tokenUsage = parseTolerantUsageRecords(
    await deps.fs.readTextFileIfExists(path.join(runtimeRoot, "logs", "token-usage.jsonl")),
  );
  const taskEvents = selectCohortTaskEvents(
    parseJsonlObjects(await deps.fs.readTextFileIfExists(path.join(runtimeRoot, "logs", "task-events.jsonl"))),
  );

  return {
    latest,
    ...(latest.exceeded
      ? {
          warning: `context pack for task ${latest.task_id} exceeded max_context_chars: ${latest.context_chars} > ${latest.max_context_chars}`,
        }
      : {}),
    cohorts: buildCompressionCohortReport(records, tokenUsage, taskEvents),
  };
}

async function buildCompressionArrestReport(deps: ReportCommandDeps, runtimeRoot: string): Promise<CompressionArrestReport> {
  const view = await readContextCompressionArrestState(deps.contextFs, runtimeRoot);
  return {
    arrests: view.state.arrests,
    unreadable: view.unreadable,
    ...(view.unreadableReason === undefined ? {} : { unreadableReason: view.unreadableReason }),
  };
}

export async function buildLocalTelemetryReport(
  deps: ReportCommandDeps,
  options: ReportOptions = {},
): Promise<LocalTelemetryReport> {
  const agRoot = path.join(deps.projectRoot, "AG");
  const runtimeRoot = deps.runtimeRoot ?? path.join(deps.projectRoot, "vq");
  const recentLimit = options.recentLimit ?? 5;
  const usageLines = parseTokenUsageSummaryLines(
    await deps.fs.readTextFileIfExists(path.join(runtimeRoot, "logs", "token-usage.jsonl")),
  );

  return {
    generatedAt: (deps.nowIso ?? (() => new Date().toISOString()))(),
    localOnly: true,
    taskCounts: await collectTaskCounts(deps, agRoot, runtimeRoot),
    tokenUsage: summarizeTokenUsage(usageLines),
    adapterUsage: summarizeTokenUsageByModel(usageLines),
    adapterCapabilities: deps.adapterCapabilities(),
    recentOutcomes: await collectRecentOutcomes(deps, runtimeRoot, recentLimit),
    contextSize: await buildContextSizeReport(deps, runtimeRoot, await readContextSizeMetrics(deps.contextFs, runtimeRoot)),
    compressionArrests: await buildCompressionArrestReport(deps, runtimeRoot),
  };
}

function renderCountMap(values: Record<string, number>): string {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "  none";
  return entries.map(([key, value]) => `  ${key}: ${value}`).join("\n");
}

function renderAdapterCapabilities(declarations: AdapterCapabilityView[]): string {
  if (declarations.length === 0) return "  none";
  return declarations
    .map((declaration) => {
      const implemented = declaration.implemented.map((capability) => capability.feature).join(", ") || "none";
      const future = declaration.future.map((capability) => capability.feature).join(", ") || "none";
      return [
        `  ${declaration.adapter}: ${declaration.summary}`,
        `    implemented: ${implemented}`,
        `    future: ${future}`,
      ].join("\n");
    })
    .join("\n");
}

/** A withheld metric names its own denominator, so "no number" never reads as "zero". */
function renderCohortMetric(label: string, value: number | undefined, sample: number): string {
  return value === undefined ? `${label}=n/a (measured=${sample})` : `${label}=${value} (measured=${sample})`;
}

function renderCohortRow(row: CohortRow): string {
  const head = `  ${row.arm}: n=${row.n} dispatches=${row.dispatchCount}`;
  if (row.insufficientSample) {
    return `${head} insufficient sample (n<${COHORT_MIN_SAMPLE})`;
  }
  return [
    head,
    renderCohortMetric("billable_p50", row.billableTokensP50, row.samples.billable),
    renderCohortMetric("turns_p50", row.turnsP50, row.samples.turns),
    renderCohortMetric("human_review_rate", row.humanReviewRate, row.samples.humanReview),
    renderCohortMetric("repair_rate", row.repairRate, row.samples.repair),
  ].join(" ");
}

function renderCompressionCohorts(cohorts: CompressionCohortReport | undefined): string {
  if (!cohorts || cohorts.rows.length === 0) return "  none";
  const features = cohorts.featureBreakdown.map((entry) => `${entry.feature}=${entry.n}`).join(", ");
  return [...cohorts.rows.map(renderCohortRow), ...(features ? [`  canary features: ${features}`] : [])].join("\n");
}

/** "none" (sveikas repo) privalo skirtis nuo "markeris neperskaitomas" (viskas off). */
function renderCompressionArrests(report: CompressionArrestReport): string {
  if (report.unreadable) {
    return [
      `  UNREADABLE: ${CONTEXT_COMPRESSION_ARREST_RELATIVE_PATH} (${report.unreadableReason ?? "unreadable"})`,
      "  every compression feature is treated as off until the marker is repaired or deleted",
    ].join("\n");
  }
  if (report.arrests.length === 0) return "  none";
  return [
    ...report.arrests.map(
      (arrest) =>
        `  ${arrest.feature}: ARRESTED ${arrest.arrested_at} trigger=${arrest.trigger} ` +
        `observed=${arrest.observed}/${arrest.threshold} last_task=${arrest.last_task_id}\n    ${arrest.reason}`,
    ),
    `  lift by hand: remove the entry from ${CONTEXT_COMPRESSION_ARREST_RELATIVE_PATH}`,
  ].join("\n");
}

export function renderLocalTelemetryReport(report: LocalTelemetryReport): string {
  const lines = [
    "AG local telemetry report",
    `Generated: ${report.generatedAt}`,
    "Scope: local files only; no data is sent anywhere.",
    "",
    "Task counts by bucket:",
    renderCountMap(report.taskCounts.buckets),
    "",
    "Task counts by ledger state:",
    renderCountMap(report.taskCounts.ledgerStates),
    "",
    "Adapter usage:",
    report.adapterUsage.length
      ? report.adapterUsage.map((entry) => `  ${entry.model}: ${entry.records}`).join("\n")
      : "  none",
    "",
    "Adapter capabilities:",
    renderAdapterCapabilities(report.adapterCapabilities),
    "",
    "Token usage:",
    report.tokenUsage.length
      ? report.tokenUsage
          .map(
            (entry) =>
              `  ${entry.phase}/${entry.model}: records=${entry.records}, input=${entry.input_tokens}, output=${entry.output_tokens}, cache_read=${entry.cache_read_input_tokens}, cache_create=${entry.cache_creation_input_tokens}, cost_usd=${entry.total_cost_usd}`,
          )
          .join("\n")
      : "  none",
    "",
    "Recent outcomes:",
    report.recentOutcomes.length
      ? report.recentOutcomes.map((entry) => `  ${entry.ts} ${entry.task_id} -> ${entry.outcome} (${entry.reason})`).join("\n")
      : "  none",
    "",
    "Context size (latest task):",
    report.contextSize.latest
      ? `  task=${report.contextSize.latest.task_id} chars=${report.contextSize.latest.context_chars}/${report.contextSize.latest.max_context_chars} spec_fragments=${report.contextSize.latest.spec_fragment_count} code_context_items=${report.contextSize.latest.code_context_item_count} dropped=${report.contextSize.latest.dropped_item_count}`
      : "  none",
    ...(report.contextSize.warning ? [`  WARNING: ${report.contextSize.warning}`] : []),
    "",
    "Context compression canary vs control:",
    renderCompressionCohorts(report.contextSize.cohorts),
    "",
    "Context compression canary arrests:",
    renderCompressionArrests(report.compressionArrests),
  ];

  return `${lines.join("\n")}\n`;
}

export async function reportCommand(deps: ReportCommandDeps, args: string[], options: ReportOptions = {}): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const json = options.json ?? args.includes("--json");
    const report = await buildLocalTelemetryReport(deps, { ...options, json });
    io.out(json ? JSON.stringify(report, null, 2) : renderLocalTelemetryReport(report));
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
