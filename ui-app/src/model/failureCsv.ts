// Pure CSV export of the reliability failure ledger. Lives in the model layer
// (moved out of view/pages/ReliabilityPage.tsx 2026-08-08): the page file must
// only export components to stay HMR-safe (react-refresh/only-export-components),
// and a formula-injection-hardened serializer is model logic, not view logic.
import type { ReliabilityAnalyticsResponse } from "./types";

export type FailureRecord = ReliabilityAnalyticsResponse["reliability"]["records"][number];

function csvCell(value: string | number | undefined): string {
  const raw = value === undefined ? "" : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildFailureCsv(records: FailureRecord[]): string {
  const header = ["task_id", "type", "phase", "failed_at", "fixed_at", "status", "reason", "incident_tokens", "diagnostic_tokens", "retry_tokens", "cache_tokens"];
  return [header.map(csvCell).join(","), ...records.map((record) => [
    record.taskId, record.type, record.phase, record.failedAt, record.fixedAt, record.status, record.reason,
    record.totalTokens, record.diagnosticTokens, record.retryTokens, record.cacheTokens,
  ].map(csvCell).join(","))].join("\n");
}
