// Ilgalaikis token analitikos snapshot'as ir jo istorija (`vq/state/token-analytics/`).
// Elgesio etalonas: AG_loop orchestrator/learning/similar-task-analytics.ts (snapshot
// pusė). Pure agregacija atskirta nuo IO: buildTokenAnalyticsSnapshot — grynas,
// update/read/history — per LearningFsPort.

import path from "node:path";
import { canonicalTokenUsageModel } from "../../domain/tokens/usage-ledger.js";
import { toPrettyJson } from "../../shared/json.js";
import {
  detectOptimizationCandidates,
  groupTaskUsageByFamily,
  canonicalPhaseGroup,
  repairCycleCountsByTask,
  type OptimizationCandidate,
  type TaskFamilyGroup,
} from "./similar-task-families.js";
import {
  numericUsage,
  parseTolerantTaskEvents,
  parseTolerantUsageRecords,
  usageRecordTotalTokens,
  type LearningTaskEventRecord,
  type LearningUsageRecord,
} from "./usage-view.js";
import type { LearningFsPort } from "./ports.js";

export type TokenAnalyticsBucket = { key: string; totalTokens: number };

export type TokenAnalyticsSnapshot = {
  generatedAt: string;
  totals: { records: number; totalTokens: number; uniqueTasks: number };
  tokensByPhase: TokenAnalyticsBucket[];
  tokensByModel: TokenAnalyticsBucket[];
  tokensByDay: TokenAnalyticsBucket[];
  fastPathHitRate: { preflight: number; diagnose: number };
  /**
   * cache_read / (input + cache_read + cache_creation) per visus įrašus iki šiol —
   * sekamas per snapshot'ą, kad istorija rodytų cache efektyvumo trendą.
   */
  cacheHitRate: number;
  repairShare: number;
  groupMedians: Array<{ familyKey: string; taskCount: number; medianTokens: number }>;
};

function bucketTotals(
  records: LearningUsageRecord[],
  keyFor: (record: LearningUsageRecord) => string,
): TokenAnalyticsBucket[] {
  const grouped = new Map<string, number>();
  for (const record of records) {
    const key = keyFor(record);
    grouped.set(key, (grouped.get(key) ?? 0) + usageRecordTotalTokens(record));
  }
  return [...grouped.entries()]
    .map(([key, totalTokens]) => ({ key, totalTokens }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function computeFastPathHitRate(records: LearningUsageRecord[]): { preflight: number; diagnose: number } {
  let preflightTotal = 0;
  let preflightFast = 0;
  let diagnoseTotal = 0;
  let diagnoseFast = 0;
  for (const record of records) {
    if (record.phase === "preflight" || record.phase === "preflight-fastpath") {
      preflightTotal += 1;
      if (record.phase === "preflight-fastpath") preflightFast += 1;
    } else if (record.phase.startsWith("diagnose")) {
      diagnoseTotal += 1;
      if (record.phase !== "diagnose") diagnoseFast += 1;
    }
  }
  return {
    preflight: preflightTotal > 0 ? preflightFast / preflightTotal : 0,
    diagnose: diagnoseTotal > 0 ? diagnoseFast / diagnoseTotal : 0,
  };
}

function computeCacheHitRate(records: LearningUsageRecord[]): number {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const record of records) {
    inputTokens += numericUsage(record.input_tokens);
    cacheReadTokens += numericUsage(record.cache_read_input_tokens);
    cacheCreationTokens += numericUsage(record.cache_creation_input_tokens);
  }
  const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  return promptTokens > 0 ? cacheReadTokens / promptTokens : 0;
}

/** Pure agregacija — be IO — tad trivialiai testuojama ir pernaudojama persist keliui. */
export function buildTokenAnalyticsSnapshot(
  usageRecords: LearningUsageRecord[],
  taskEvents: LearningTaskEventRecord[],
  now: Date = new Date(),
): TokenAnalyticsSnapshot {
  const groups = groupTaskUsageByFamily(usageRecords);
  const repairCycles = repairCycleCountsByTask(taskEvents);
  const taskIds = new Set(usageRecords.map((record) => record.task_id));
  const tasksWithRepair = [...taskIds].filter((taskId) => (repairCycles.get(taskId) ?? 0) > 0).length;

  return {
    generatedAt: now.toISOString(),
    totals: {
      records: usageRecords.length,
      totalTokens: usageRecords.reduce((sum, record) => sum + usageRecordTotalTokens(record), 0),
      uniqueTasks: taskIds.size,
    },
    tokensByPhase: bucketTotals(usageRecords, (record) => canonicalPhaseGroup(record.phase)),
    tokensByModel: bucketTotals(usageRecords, (record) => canonicalTokenUsageModel(record.model)),
    tokensByDay: bucketTotals(usageRecords, (record) => (record.ts ? record.ts.slice(0, 10) : "unknown")),
    fastPathHitRate: computeFastPathHitRate(usageRecords),
    cacheHitRate: computeCacheHitRate(usageRecords),
    repairShare: taskIds.size > 0 ? tasksWithRepair / taskIds.size : 0,
    groupMedians: groups.map((group) => ({
      familyKey: group.familyKey,
      taskCount: group.taskIds.length,
      medianTokens: group.medianTokens,
    })),
  };
}

export function tokenAnalyticsDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "token-analytics");
}

export function tokenAnalyticsSnapshotPath(runtimeRoot: string): string {
  return path.join(tokenAnalyticsDir(runtimeRoot), "snapshot.json");
}

export function tokenAnalyticsHistoryPath(runtimeRoot: string): string {
  return path.join(tokenAnalyticsDir(runtimeRoot), "snapshots.jsonl");
}

function tokenUsageLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "token-usage.jsonl");
}

function taskEventsLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "task-events.jsonl");
}

/**
 * Perskaičiuoja snapshot'ą iš dabartinių žurnalų ir persistina: naujausią snapshot'ą
 * („dabartinės būsenos" API atsakymui) plius append į istorijos jsonl (trendo grafikams).
 * Best-effort, kaip visa token telemetrija — klaida čia niekada nenutraukia task apdorojimo.
 */
export async function updateTokenAnalyticsSnapshot(
  fs: LearningFsPort,
  runtimeRoot: string,
  now: Date = new Date(),
): Promise<TokenAnalyticsSnapshot | undefined> {
  try {
    const usageRecords = parseTolerantUsageRecords(await fs.readTextFileIfExists(tokenUsageLogPath(runtimeRoot)));
    const taskEvents = parseTolerantTaskEvents(await fs.readTextFileIfExists(taskEventsLogPath(runtimeRoot)));
    const snapshot = buildTokenAnalyticsSnapshot(usageRecords, taskEvents, now);
    await fs.makeDirectory(tokenAnalyticsDir(runtimeRoot));
    await fs.writeTextFile(tokenAnalyticsSnapshotPath(runtimeRoot), toPrettyJson(snapshot));
    await fs.appendTextFile(tokenAnalyticsHistoryPath(runtimeRoot), `${JSON.stringify(snapshot)}\n`);
    return snapshot;
  } catch {
    return undefined;
  }
}

export async function readTokenAnalyticsSnapshot(
  fs: LearningFsPort,
  runtimeRoot: string,
): Promise<TokenAnalyticsSnapshot | null> {
  const raw = await fs.readTextFileIfExists(tokenAnalyticsSnapshotPath(runtimeRoot));
  if (raw === undefined) return null;
  const snapshot = JSON.parse(raw) as TokenAnalyticsSnapshot;
  return {
    ...snapshot,
    tokensByModel: mergeCanonicalModelBuckets(snapshot.tokensByModel),
  };
}

export async function readTokenAnalyticsHistory(
  fs: LearningFsPort,
  runtimeRoot: string,
  limit = 200,
): Promise<TokenAnalyticsSnapshot[]> {
  const raw = await fs.readTextFileIfExists(tokenAnalyticsHistoryPath(runtimeRoot));
  const all: TokenAnalyticsSnapshot[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Istorija — savo paties rašytas failas, tad skaitoma griežtai (kaip etalono readJsonl).
    all.push(JSON.parse(line) as TokenAnalyticsSnapshot);
  }
  return all.slice(-limit).map((snapshot) => ({
    ...snapshot,
    tokensByModel: mergeCanonicalModelBuckets(snapshot.tokensByModel),
  }));
}

export function mergeCanonicalModelBuckets(rows: TokenAnalyticsBucket[]): TokenAnalyticsBucket[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = canonicalTokenUsageModel(row.key);
    totals.set(key, (totals.get(key) ?? 0) + numericUsage(row.totalTokens));
  }
  return [...totals.entries()]
    .map(([key, totalTokens]) => ({ key, totalTokens }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// `GET /api/token-analytics` atsakymo forma
// ---------------------------------------------------------------------------

export type TokenAnalyticsResponse = {
  groups: TaskFamilyGroup[];
  candidates: OptimizationCandidate[];
  history: TokenAnalyticsSnapshot[];
};

export async function buildTokenAnalyticsResponse(
  fs: LearningFsPort,
  runtimeRoot: string,
): Promise<TokenAnalyticsResponse> {
  // UI analitika: sugadinta eilutė praleidžiama, o ne nuverčia atsakymą į 500.
  const usageRecords = parseTolerantUsageRecords(await fs.readTextFileIfExists(tokenUsageLogPath(runtimeRoot)));
  const taskEvents = parseTolerantTaskEvents(await fs.readTextFileIfExists(taskEventsLogPath(runtimeRoot)));
  const groups = groupTaskUsageByFamily(usageRecords);
  const candidates = detectOptimizationCandidates(groups, usageRecords, taskEvents);
  const persistedHistory = await readTokenAnalyticsHistory(fs, runtimeRoot);
  // Trendo grafikui iš senų snapshot'ų reikia tik rodiklių ir laiko žymų. Naujausias
  // snapshot'as lieka pilnas suvestinės panelėms, bet dideli per-šeimos masyvai
  // nepersiunčiami kiekvienam istoriniam taškui per kiekvieną UI atnaujinimą.
  const history = persistedHistory.map((snapshot, index) =>
    index === persistedHistory.length - 1
      ? snapshot
      : {
          ...snapshot,
          tokensByPhase: [],
          tokensByModel: [],
          tokensByDay: [],
          groupMedians: [],
        },
  );
  return { groups, candidates, history };
}
