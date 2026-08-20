// Learning atminties žurnalas (`vq/state/learning/events.jsonl`). Elgesio etalonas:
// AG_loop orchestrator/learning/learning-memory.ts. VERQESTRA skirtumai: IO per
// LearningFsPort; keliai — vq runtime šaknyje.

import path from "node:path";
import type { LearningFsPort } from "./ports.js";

export type LearningMemoryEventType = "task_outcome" | "failure_pattern" | "context_feedback" | "policy_recommendation";
export type LearningRecommendationStatus = "pending" | "approved" | "rejected";

export type LearningMemoryRecord = {
  id: string;
  ts: string;
  type: LearningMemoryEventType;
  task_id?: string;
  file?: string;
  summary: string;
  labels: string[];
  evidence: string[];
  recommendation_status?: LearningRecommendationStatus;
};

export type LearningMemorySummary = {
  records: number;
  by_type: Record<LearningMemoryEventType, number>;
  pending_recommendations: number;
  approved_recommendations: number;
  rejected_recommendations: number;
};

export type LearningMemoryQuery = {
  taskId?: string;
  file?: string;
  type?: LearningMemoryEventType;
  label?: string;
  limit?: number;
};

const memoryFileName = "events.jsonl";

export function learningMemoryDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "learning");
}

export function learningMemoryPath(runtimeRoot: string): string {
  return path.join(learningMemoryDir(runtimeRoot), memoryFileName);
}

export type LearningMemoryRecordInput = Omit<LearningMemoryRecord, "id" | "ts"> & { id?: string; ts?: string };

export async function appendLearningMemoryRecord(
  fs: LearningFsPort,
  runtimeRoot: string,
  input: LearningMemoryRecordInput,
): Promise<LearningMemoryRecord> {
  await fs.makeDirectory(learningMemoryDir(runtimeRoot));
  const recommendationStatus = resolveRecommendationStatus(input);
  const record: LearningMemoryRecord = {
    id: input.id ?? stableRecordId(input.type, input.task_id, input.file, input.summary),
    ts: input.ts ?? new Date().toISOString(),
    type: input.type,
    // exactOptionalPropertyTypes: neapibrėžti raktai praleidžiami, ne rašomi `undefined`
    // reikšme — JSON serializacija abiem atvejais identiška etalonui.
    ...(input.task_id === undefined ? {} : { task_id: input.task_id }),
    ...(input.file === undefined ? {} : { file: input.file }),
    summary: input.summary.trim(),
    labels: uniqueSorted(input.labels ?? []),
    evidence: uniqueSorted(input.evidence ?? []),
    ...(recommendationStatus === undefined ? {} : { recommendation_status: recommendationStatus }),
  };
  validateLearningMemoryRecord(record);
  await fs.appendTextFile(learningMemoryPath(runtimeRoot), `${JSON.stringify(record)}\n`);
  return record;
}

function resolveRecommendationStatus(input: LearningMemoryRecordInput): LearningRecommendationStatus | undefined {
  return input.type === "policy_recommendation" ? input.recommendation_status ?? "pending" : input.recommendation_status;
}

export async function readLearningMemoryRecords(fs: LearningFsPort, runtimeRoot: string): Promise<LearningMemoryRecord[]> {
  const raw = await fs.readTextFileIfExists(learningMemoryPath(runtimeRoot));
  if (raw === undefined) return [];

  const records: LearningMemoryRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as LearningMemoryRecord;
    validateLearningMemoryRecord(record);
    records.push(record);
  }
  return records;
}

export async function queryLearningMemory(
  fs: LearningFsPort,
  runtimeRoot: string,
  query: LearningMemoryQuery = {},
): Promise<LearningMemoryRecord[]> {
  const limit = Math.max(1, Math.min(query.limit ?? 20, 200));
  const records = await readLearningMemoryRecords(fs, runtimeRoot);
  return records
    .filter((record) => !query.taskId || record.task_id === query.taskId)
    .filter((record) => !query.file || record.file === query.file)
    .filter((record) => !query.type || record.type === query.type)
    .filter((record) => !query.label || record.labels.includes(query.label))
    .sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

export async function summarizeLearningMemory(fs: LearningFsPort, runtimeRoot: string): Promise<LearningMemorySummary> {
  const records = await readLearningMemoryRecords(fs, runtimeRoot);
  const summary: LearningMemorySummary = {
    records: records.length,
    by_type: {
      task_outcome: 0,
      failure_pattern: 0,
      context_feedback: 0,
      policy_recommendation: 0,
    },
    pending_recommendations: 0,
    approved_recommendations: 0,
    rejected_recommendations: 0,
  };

  // Rekomendacijos statusas — PASKUTINIS to paties id įrašas: decide append'ina naują
  // eilutę tuo pačiu id, tad Map perrašymas natūraliai realizuoja "latest wins".
  const latestRecommendations = new Map<string, LearningMemoryRecord>();
  for (const record of records) {
    summary.by_type[record.type] += 1;
    if (record.type === "policy_recommendation") {
      latestRecommendations.set(record.id, record);
    }
  }

  for (const record of latestRecommendations.values()) {
    if (record.recommendation_status === "approved") summary.approved_recommendations += 1;
    else if (record.recommendation_status === "rejected") summary.rejected_recommendations += 1;
    else summary.pending_recommendations += 1;
  }
  return summary;
}

export async function decideLearningRecommendation(
  fs: LearningFsPort,
  runtimeRoot: string,
  id: string,
  status: Exclude<LearningRecommendationStatus, "pending">,
  evidence: string[] = [],
): Promise<LearningMemoryRecord> {
  const matches = (await readLearningMemoryRecords(fs, runtimeRoot)).filter((record) => record.id === id);
  const existing = matches[matches.length - 1];
  if (!existing) throw new Error(`Learning recommendation not found: ${id}`);
  if (existing.type !== "policy_recommendation") throw new Error(`Learning record is not a policy recommendation: ${id}`);

  return await appendLearningMemoryRecord(fs, runtimeRoot, {
    id: existing.id,
    type: "policy_recommendation",
    ...(existing.task_id === undefined ? {} : { task_id: existing.task_id }),
    ...(existing.file === undefined ? {} : { file: existing.file }),
    summary: existing.summary,
    labels: existing.labels,
    evidence: [...existing.evidence, ...evidence, `decision:${status}`],
    recommendation_status: status,
  });
}

function validateLearningMemoryRecord(record: LearningMemoryRecord): void {
  if (!record.id || !record.ts || !record.type || !record.summary) {
    throw new Error("Invalid learning memory record: id, ts, type, and summary are required");
  }
  if (!Array.isArray(record.labels) || !Array.isArray(record.evidence)) {
    throw new Error("Invalid learning memory record: labels and evidence must be arrays");
  }
  if (record.type === "policy_recommendation" && !record.recommendation_status) {
    throw new Error("Invalid learning memory record: policy recommendations require recommendation_status");
  }
}

function stableRecordId(type: string, taskId: string | undefined, file: string | undefined, summary: string): string {
  const key = [type, taskId ?? "", file ?? "", summary]
    .join("|")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key.slice(0, 96) || `learning-${Date.now()}`;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}
