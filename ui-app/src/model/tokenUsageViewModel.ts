import type { TokenUsageRecord } from "./types";

function coerce(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function recordTotalTokens(record: TokenUsageRecord): number {
  return (
    coerce(record.input_tokens) +
    coerce(record.output_tokens) +
    coerce(record.cache_read_input_tokens) +
    coerce(record.cache_creation_input_tokens)
  );
}

/**
 * Collapses the raw telemetry `phase` values (`preflight`, `preflight-fastpath`,
 * `dispatch`, `diagnose`, `diagnose-fastpath`, `diagnose-local`, ...) into the four
 * learning-oriented buckets the token-usage view reports on: how much goes into
 * preflight vs dispatch vs full diagnose vs the no-LLM fast paths.
 */
export type PhaseGroup = "preflight" | "dispatch" | "diagnose" | "fastpath" | "other";

export function canonicalPhaseGroup(phase: string): PhaseGroup {
  if (phase.endsWith("-fastpath") || phase.endsWith("-local")) return "fastpath";
  if (phase === "dispatch") return "dispatch";
  if (phase.startsWith("preflight")) return "preflight";
  if (phase.startsWith("diagnose")) return "diagnose";
  return "other";
}

export type AggregateGroupBy = "model" | "phase" | "day" | "task_id" | "phaseGroup";

const MODEL_TIERS = ["haiku", "sonnet", "opus", "fable"] as const;

/** Maps a concrete Claude model ID and its short policy alias to one reporting tier. */
export function canonicalModelName(model: string): string {
  const normalized = model.trim().toLowerCase();
  for (const tier of MODEL_TIERS) {
    if (normalized === tier || normalized.startsWith(`claude-${tier}-`) || normalized === `claude-${tier}`) {
      return tier;
    }
  }
  return normalized || "unknown";
}

export type AggregateRow = {
  key: string;
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
};

function aggregateGroupKey(record: TokenUsageRecord, groupBy: AggregateGroupBy): string {
  if (groupBy === "day") {
    if (!record.ts) return "unknown";
    const timestamp = new Date(record.ts);
    if (Number.isNaN(timestamp.getTime())) return "unknown";
    const year = timestamp.getFullYear();
    const month = String(timestamp.getMonth() + 1).padStart(2, "0");
    const day = String(timestamp.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  if (groupBy === "phaseGroup") {
    return canonicalPhaseGroup(record.phase);
  }
  if (groupBy === "model") {
    return canonicalModelName(record.model);
  }
  return record[groupBy];
}

export function aggregateTokenUsage(records: TokenUsageRecord[], groupBy: AggregateGroupBy): AggregateRow[] {
  const grouped = new Map<string, AggregateRow>();
  for (const record of records) {
    const key = aggregateGroupKey(record, groupBy);
    const current = grouped.get(key) ?? {
      key,
      records: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
    };

    current.records += 1;
    current.inputTokens += coerce(record.input_tokens);
    current.outputTokens += coerce(record.output_tokens);
    current.cacheReadTokens += coerce(record.cache_read_input_tokens);
    current.cacheCreationTokens += coerce(record.cache_creation_input_tokens);
    current.totalTokens += recordTotalTokens(record);
    grouped.set(key, current);
  }

  return [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export type TokenUsageTotals = {
  records: number;
  uniqueTasks: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheTokens: number;
  totalTokens: number;
  /** Total tokens divided by the number of distinct task IDs in the selection. */
  tokensPerTask: number;
  /** Total tokens divided by the number of telemetry records in the selection. */
  tokensPerRecord: number;
  /** output_tokens / input_tokens — how much the model writes relative to what it reads. */
  outputInputRatio: number;
  /** cache_read / (input + cache_read + cache_creation) — share of prompt tokens served from cache. */
  cacheHitRate: number;
  /** cache_read / cache_creation — how many cached reads each cache-write token later paid for. */
  cacheReadToCreationRatio: number;
  firstTimestamp: string | null;
  latestTimestamp: string | null;
};

export function computeTokenUsageTotals(records: TokenUsageRecord[]): TokenUsageTotals {
  const totals: TokenUsageTotals = {
    records: 0,
    uniqueTasks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    tokensPerTask: 0,
    tokensPerRecord: 0,
    outputInputRatio: 0,
    cacheHitRate: 0,
    cacheReadToCreationRatio: 0,
    firstTimestamp: null,
    latestTimestamp: null,
  };
  const taskIds = new Set<string>();

  for (const record of records) {
    totals.records += 1;
    taskIds.add(record.task_id);
    totals.inputTokens += coerce(record.input_tokens);
    totals.outputTokens += coerce(record.output_tokens);
    totals.cacheReadTokens += coerce(record.cache_read_input_tokens);
    totals.cacheCreationTokens += coerce(record.cache_creation_input_tokens);
    if (record.ts) {
      if (!totals.firstTimestamp || record.ts < totals.firstTimestamp) totals.firstTimestamp = record.ts;
      if (!totals.latestTimestamp || record.ts > totals.latestTimestamp) totals.latestTimestamp = record.ts;
    }
  }
  totals.cacheTokens = totals.cacheReadTokens + totals.cacheCreationTokens;
  totals.totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheTokens;
  totals.uniqueTasks = taskIds.size;
  totals.tokensPerTask = totals.uniqueTasks > 0 ? totals.totalTokens / totals.uniqueTasks : 0;
  totals.tokensPerRecord = totals.records > 0 ? totals.totalTokens / totals.records : 0;
  totals.outputInputRatio = totals.inputTokens > 0 ? totals.outputTokens / totals.inputTokens : 0;
  const promptTokens = totals.inputTokens + totals.cacheTokens;
  totals.cacheHitRate = promptTokens > 0 ? totals.cacheReadTokens / promptTokens : 0;
  totals.cacheReadToCreationRatio =
    totals.cacheCreationTokens > 0 ? totals.cacheReadTokens / totals.cacheCreationTokens : 0;

  return totals;
}

export type TokenDistributionStats = {
  mean: number;
  median: number;
  p95: number;
};

function percentileOfSorted(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = Math.min(Math.max(Math.ceil((p / 100) * sortedAsc.length) - 1, 0), sortedAsc.length - 1);
  return sortedAsc[index];
}

export function computeTokenDistributionStats(values: number[]): TokenDistributionStats {
  if (values.length === 0) return { mean: 0, median: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    mean: sum / sorted.length,
    median: percentileOfSorted(sorted, 50),
    p95: percentileOfSorted(sorted, 95),
  };
}

export type FastPathStats = {
  preflightTotal: number;
  preflightFastPath: number;
  preflightFastPathRate: number;
  diagnoseTotal: number;
  diagnoseFastPath: number;
  diagnoseFastPathRate: number;
};

/**
 * Fast-path records (`preflight-fastpath`, `diagnose-fastpath`, `diagnose-local`) resolve
 * without an LLM call. This measures what share of preflight/diagnose work skipped the model.
 */
export function computeFastPathStats(records: TokenUsageRecord[]): FastPathStats {
  const stats: FastPathStats = {
    preflightTotal: 0,
    preflightFastPath: 0,
    preflightFastPathRate: 0,
    diagnoseTotal: 0,
    diagnoseFastPath: 0,
    diagnoseFastPathRate: 0,
  };

  for (const record of records) {
    if (record.phase === "preflight" || record.phase === "preflight-fastpath") {
      stats.preflightTotal += 1;
      if (record.phase === "preflight-fastpath") stats.preflightFastPath += 1;
    } else if (record.phase.startsWith("diagnose")) {
      stats.diagnoseTotal += 1;
      if (record.phase !== "diagnose") stats.diagnoseFastPath += 1;
    }
  }

  stats.preflightFastPathRate = stats.preflightTotal > 0 ? stats.preflightFastPath / stats.preflightTotal : 0;
  stats.diagnoseFastPathRate = stats.diagnoseTotal > 0 ? stats.diagnoseFastPath / stats.diagnoseTotal : 0;
  return stats;
}

export type ReworkProxyStats = {
  diagnosisTokens: number;
  diagnosisTokenShare: number;
  tasksWithDiagnosis: number;
  taskShare: number;
  exactRetryTokens: number;
  exactRetryTokenShare: number;
  retryAttempts: number;
  failedRetryAttempts: number;
  metadataCoverage: number;
  isExact: boolean;
};

/**
 * A transparent rework proxy. Raw telemetry has no retry/failed-outcome field, so
 * only model-backed `diagnose` activity is counted; local and fast-path diagnoses
 * are deliberately excluded.
 */
export function computeReworkProxyStats(records: TokenUsageRecord[]): ReworkProxyStats {
  const allTasks = new Set(records.map((record) => record.task_id));
  const diagnosisTasks = new Set<string>();
  let diagnosisTokens = 0;
  let totalTokens = 0;
  let exactRetryTokens = 0;
  let retryAttempts = 0;
  let failedRetryAttempts = 0;
  let dispatchRecords = 0;
  let dispatchRecordsWithAttempt = 0;

  for (const record of records) {
    const tokens = recordTotalTokens(record);
    totalTokens += tokens;
    if (record.phase === "dispatch") {
      dispatchRecords += 1;
      if (typeof record.attempt === "number") {
        dispatchRecordsWithAttempt += 1;
        if (record.attempt > 1) {
          exactRetryTokens += tokens;
          retryAttempts += 1;
          if (record.outcome === "failed") failedRetryAttempts += 1;
        }
      }
    }
    if (record.phase === "diagnose") {
      diagnosisTokens += tokens;
      diagnosisTasks.add(record.task_id);
    }
  }

  const metadataCoverage = dispatchRecords > 0 ? dispatchRecordsWithAttempt / dispatchRecords : 0;
  return {
    diagnosisTokens,
    diagnosisTokenShare: totalTokens > 0 ? diagnosisTokens / totalTokens : 0,
    tasksWithDiagnosis: diagnosisTasks.size,
    taskShare: allTasks.size > 0 ? diagnosisTasks.size / allTasks.size : 0,
    exactRetryTokens,
    exactRetryTokenShare: totalTokens > 0 ? exactRetryTokens / totalTokens : 0,
    retryAttempts,
    failedRetryAttempts,
    metadataCoverage,
    isExact: dispatchRecords > 0 && metadataCoverage === 1,
  };
}

export type PeriodComparison = {
  available: boolean;
  daysPerPeriod: number;
  previous: TokenUsageTotals;
  current: TokenUsageTotals;
  tokenDelta: number | null;
  tokensPerTaskDelta: number | null;
  cacheHitRateDelta: number | null;
};

function relativeDelta(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null;
}

/** Šiandienos data vietine laiko juosta `YYYY-MM-DD` formatu — tuo pačiu raktu, kaip `day` grupė. */
function localTodayKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Palygina naujausią UŽBAIGTĄ N dienų langą su prieš jį buvusiomis N dienomis.
 *
 * Einamoji diena atmetama: iki 2026-08-06 UI audito ji dalyvavo palyginime kaip lygiavertė, tad
 * 10 val. ryto keturios darbo valandos buvo lyginamos su visa vakarykšte para ir „Token volume
 * change" rodydavo −80 %, o sprendimų panelė tai nudažydavo žaliai kaip „favorable". Operatorius
 * darydavo išvadą, kad optimizacija suveikė, nors tiesiog dar nesibaigė diena.
 */
export function computePeriodComparison(records: TokenUsageRecord[], now: Date = new Date()): PeriodComparison {
  const today = localTodayKey(now);
  const rowsByDay = aggregateTokenUsage(records, "day")
    .filter((row) => row.key !== "unknown")
    .filter((row) => row.key !== today);
  const daysPerPeriod = Math.floor(rowsByDay.length / 2);
  const empty = computeTokenUsageTotals([]);
  if (daysPerPeriod < 1) {
    return {
      available: false,
      daysPerPeriod: 0,
      previous: empty,
      current: empty,
      tokenDelta: null,
      tokensPerTaskDelta: null,
      cacheHitRateDelta: null,
    };
  }

  const comparisonDays = rowsByDay.slice(-(daysPerPeriod * 2));
  const previousDays = new Set(comparisonDays.slice(0, daysPerPeriod).map((row) => row.key));
  const currentDays = new Set(comparisonDays.slice(daysPerPeriod).map((row) => row.key));
  const dayKey = (record: TokenUsageRecord) => aggregateGroupKey(record, "day");
  const previous = computeTokenUsageTotals(records.filter((record) => previousDays.has(dayKey(record))));
  const current = computeTokenUsageTotals(records.filter((record) => currentDays.has(dayKey(record))));

  return {
    available: true,
    daysPerPeriod,
    previous,
    current,
    tokenDelta: relativeDelta(current.totalTokens, previous.totalTokens),
    tokensPerTaskDelta: relativeDelta(current.tokensPerTask, previous.tokensPerTask),
    cacheHitRateDelta: current.cacheHitRate - previous.cacheHitRate,
  };
}

/** Share of `totalTokens` attributable to the aggregate row keyed by `key` (e.g. a phase group). */
export function tokenShareForKey(rows: AggregateRow[], key: string, totalTokens: number): number {
  if (totalTokens <= 0) return 0;
  const row = rows.find((r) => r.key === key);
  return row ? row.totalTokens / totalTokens : 0;
}

export function toInclusiveIsoDateBoundary(value: string, boundary: "start" | "end"): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    const localBoundary =
      boundary === "start"
        ? new Date(year, month - 1, day, 0, 0, 0, 0)
        : new Date(year, month - 1, day, 23, 59, 59, 999);
    return localBoundary.toISOString();
  }
  return value;
}

export type TokenUsageClientFilters = {
  model?: string;
  phase?: string;
  taskIdQuery?: string;
  from?: string;
  to?: string;
};

export function filterTokenUsageRecords(
  records: TokenUsageRecord[],
  filters: TokenUsageClientFilters,
): TokenUsageRecord[] {
  const taskIdQuery = filters.taskIdQuery?.trim().toLowerCase();
  const from = toInclusiveIsoDateBoundary(filters.from ?? "", "start");
  const to = toInclusiveIsoDateBoundary(filters.to ?? "", "end");

  return records.filter((record) => {
    if (filters.model && canonicalModelName(record.model) !== canonicalModelName(filters.model)) return false;
    if (filters.phase && record.phase !== filters.phase) return false;
    if (taskIdQuery && !record.task_id.toLowerCase().includes(taskIdQuery)) return false;
    if (from && record.ts < from) return false;
    if (to && record.ts > to) return false;
    return true;
  });
}

export type SortKey =
  | "key"
  | "records"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheCreationTokens"
  | "totalTokens";
export type SortDirection = "asc" | "desc";

export function sortAggregateRows(
  rows: AggregateRow[],
  sortKey: SortKey,
  direction: SortDirection,
): AggregateRow[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sortKey === "key") {
      return a.key.localeCompare(b.key) * factor;
    }
    return (a[sortKey] - b[sortKey]) * factor;
  });
}

export function uniqueSortedValues(records: TokenUsageRecord[], field: "model" | "phase"): string[] {
  const values = records.map((record) => field === "model" ? canonicalModelName(record.model) : record.phase);
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
