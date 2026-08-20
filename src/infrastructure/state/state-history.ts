// Task būsenų perėjimų istorija (etalonas: AG_loop orchestrator/state/state-history.ts).
// `resolveHumanReviewStatus` — FinalAuditPorts.humanReviewResolved tiekėjas: paskutinis
// task'o įvykis sprendžia statusą ("routed" atveria, "resolved" uždaro; be įvykio —
// pending). VERQESTRA kelias: vq/state/state-history.json.

import path from "node:path";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

export type StateHistoryRecord = {
  task_id: string;
  previous_folder: string;
  next_folder: string;
  timestamp: string;
  result: string;
  reason: string;
};

export type NewStateHistoryRecord = Omit<StateHistoryRecord, "timestamp"> & { timestamp?: string };

export function stateHistoryPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "state-history.json");
}

export async function readStateHistory(filePath: string): Promise<StateHistoryRecord[]> {
  const raw = await nodeFsAdapter.readTextFileIfExists(filePath);
  if (raw === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid state history JSON at ${filePath}: ${message}`, { cause: error });
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid state history at ${filePath}: expected an array`);
  }

  return parsed.map((record, index) => validateRecord(record, index, filePath));
}

export async function appendStateHistory(filePath: string, record: NewStateHistoryRecord): Promise<StateHistoryRecord> {
  const history = await readStateHistory(filePath);
  const nextRecord: StateHistoryRecord = {
    ...record,
    timestamp: record.timestamp ?? new Date().toISOString(),
  };
  validateRecord(nextRecord, history.length, filePath);
  history.push(nextRecord);

  await nodeFsAdapter.writeTextFile(filePath, `${JSON.stringify(history, null, 2)}\n`);
  return nextRecord;
}

export type HumanReviewStatus = "pending" | "resolved";

// Paskutinis task_id atitinkantis įvykis sprendžia statusą: "routed" (vėl) atveria
// peržiūrą, "resolved" — uždaro. Be jokio įvykio — pending.
export function resolveHumanReviewStatus(history: StateHistoryRecord[], taskId: string): HumanReviewStatus {
  let status: HumanReviewStatus = "pending";
  for (const record of history) {
    if (record.task_id !== taskId) continue;
    if (record.result === "resolved") status = "resolved";
    else if (record.result === "routed") status = "pending";
  }
  return status;
}

function validateRecord(record: unknown, index: number, filePath: string): StateHistoryRecord {
  if (!record || typeof record !== "object") {
    throw new Error(`Invalid state history at ${filePath}: record ${index} must be an object`);
  }

  const candidate = record as Record<string, unknown>;
  for (const field of ["task_id", "previous_folder", "next_folder", "timestamp", "result", "reason"] as const) {
    if (typeof candidate[field] !== "string" || candidate[field].trim().length === 0) {
      throw new Error(`Invalid state history at ${filePath}: record ${index}.${field} must be a non-empty string`);
    }
  }

  return {
    task_id: String(candidate["task_id"]),
    previous_folder: String(candidate["previous_folder"]),
    next_folder: String(candidate["next_folder"]),
    timestamp: String(candidate["timestamp"]),
    result: String(candidate["result"]),
    reason: String(candidate["reason"]),
  };
}
