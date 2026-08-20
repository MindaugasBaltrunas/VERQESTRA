// Nesėkmių incidentų analitika (pure). Elgesio etalonas: AG_loop
// orchestrator/learning/reliability-analytics.ts (failure pusė): incidentas atsidaro
// pirmu failure įvykiu, užsidaro `done` perėjimu, o tarp jų įrašyta token usage
// priskiriama incidento kainai.

import { dateKey } from "./file-activity.js";
import {
  numericUsage,
  usageRecordCacheTokens,
  usageRecordTotalTokens,
  type LearningTaskEventRecord,
  type LearningUsageRecord,
} from "./usage-view.js";

export type FailureRecord = {
  taskId: string;
  failedAt: string;
  fixedAt?: string;
  status: "fixed" | "open";
  type: string;
  phase: string;
  reason: string;
  detail?: string;
  totalTokens: number;
  repairTokens: number;
  diagnosticTokens: number;
  retryTokens: number;
  cacheTokens: number;
};

export type FailureAnalytics = {
  failures: number;
  fixed: number;
  open: number;
  fixRate: number;
  medianRepairMinutes?: number;
  incidentTokens: number;
  repairTokens: number;
  diagnosticTokens: number;
  retryTokens: number;
  cacheTokens: number;
  byType: Array<{ type: string; count: number; fixed: number; open: number }>;
  byDay: Array<{
    date: string;
    fixed: number;
    open: number;
    incidentTokens: number;
    repairTokens: number;
    diagnosticTokens: number;
    retryTokens: number;
    cacheTokens: number;
  }>;
  records: FailureRecord[];
};

function isFailure(event: LearningTaskEventRecord): boolean {
  return (
    event.to_state === "error" ||
    (event.to_state === "human-review" &&
      /fail|error|reject|corrupt|rollback|missing|blocked/i.test(`${event.reason} ${event.detail}`)) ||
    (event.to_state === "queue" && /abort|fail|error/i.test(`${event.reason} ${event.detail}`))
  );
}

function failureType(event: LearningTaskEventRecord): string {
  const text = `${event.phase ?? ""} ${event.reason ?? ""} ${event.detail ?? ""}`.toLocaleLowerCase();
  if (/typescript|tsc|error ts/.test(text)) return "TypeScript";
  if (/test|quality.gate/.test(text)) return "Tests / quality";
  if (/build|dist is stale|missing\)/.test(text)) return "Build / generated output";
  if (/security|secret|permission|auth/.test(text)) return "Security / permissions";
  if (/rate.limit|429|timeout|exit=124/.test(text)) return "External service / timeout";
  if (/preflight/.test(text)) return "Preflight / specification";
  if (/dispatch/.test(text)) return "Dispatch / execution";
  if (/rollback|commit|git/.test(text)) return "Git / recovery";
  return "Other";
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function buildFailureAnalytics(
  events: LearningTaskEventRecord[],
  tokens: LearningUsageRecord[],
): FailureAnalytics {
  const records: FailureRecord[] = [];
  const openByTask = new Map<string, FailureRecord>();
  const chronologicalEvents = [...events]
    .filter((event) => Number.isFinite(Date.parse(event.ts)))
    .sort((left, right) => left.ts.localeCompare(right.ts));
  for (const event of chronologicalEvents) {
    if (isFailure(event)) {
      if (openByTask.has(event.task_id)) continue;
      const incident: FailureRecord = {
        taskId: event.task_id,
        failedAt: event.ts,
        status: "open",
        type: failureType(event),
        phase: event.phase ?? "workflow",
        reason: event.reason ?? "Unspecified failure",
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        totalTokens: 0,
        repairTokens: 0,
        diagnosticTokens: 0,
        retryTokens: 0,
        cacheTokens: 0,
      };
      records.push(incident);
      openByTask.set(event.task_id, incident);
      continue;
    }
    if (event.to_state === "done") {
      const incident = openByTask.get(event.task_id);
      if (!incident) continue;
      incident.fixedAt = event.ts;
      incident.status = "fixed";
      openByTask.delete(event.task_id);
    }
  }

  const incidentsByTask = new Map<string, FailureRecord[]>();
  for (const incident of records) {
    const incidents = incidentsByTask.get(incident.taskId) ?? [];
    incidents.push(incident);
    incidentsByTask.set(incident.taskId, incidents);
  }
  for (const token of tokens) {
    if (!token.ts) continue;
    const incident = (incidentsByTask.get(token.task_id) ?? []).find(
      (candidate) => token.ts >= candidate.failedAt && (!candidate.fixedAt || token.ts <= candidate.fixedAt),
    );
    if (!incident) continue;
    const total = usageRecordTotalTokens(token);
    incident.totalTokens += total;
    incident.cacheTokens += usageRecordCacheTokens(token);
    const diagnostic = token.phase.includes("diagnose");
    const retry = !diagnostic && (numericUsage(token.attempt ?? 1) > 1 || Boolean(token.retry_reason));
    if (diagnostic) incident.diagnosticTokens += total;
    if (retry) incident.retryTokens += total;
    if (diagnostic || retry) {
      incident.repairTokens += total;
    }
  }
  const repairMinutes = records
    .filter((record) => record.fixedAt)
    .map((record) => (Date.parse(record.fixedAt!) - Date.parse(record.failedAt)) / 60_000)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const types = new Map<string, { count: number; fixed: number; open: number }>();
  for (const record of records) {
    const item = types.get(record.type) ?? { count: 0, fixed: 0, open: 0 };
    item.count += 1;
    item[record.status] += 1;
    types.set(record.type, item);
  }
  const fixed = records.filter((record) => record.status === "fixed").length;
  const days = new Map<
    string,
    { fixed: number; open: number; incidentTokens: number; repairTokens: number; diagnosticTokens: number; retryTokens: number; cacheTokens: number }
  >();
  for (const record of records) {
    const day = days.get(dateKey(record.failedAt)) ?? {
      fixed: 0,
      open: 0,
      incidentTokens: 0,
      repairTokens: 0,
      diagnosticTokens: 0,
      retryTokens: 0,
      cacheTokens: 0,
    };
    day[record.status] += 1;
    day.incidentTokens += record.totalTokens;
    day.repairTokens += record.repairTokens;
    day.diagnosticTokens += record.diagnosticTokens;
    day.retryTokens += record.retryTokens;
    day.cacheTokens += record.cacheTokens;
    days.set(dateKey(record.failedAt), day);
  }
  const medianRepair = median(repairMinutes);
  return {
    failures: records.length,
    fixed,
    open: records.length - fixed,
    fixRate: records.length ? fixed / records.length : 1,
    ...(medianRepair === undefined ? {} : { medianRepairMinutes: medianRepair }),
    incidentTokens: records.reduce((sum, record) => sum + record.totalTokens, 0),
    repairTokens: records.reduce((sum, record) => sum + record.repairTokens, 0),
    diagnosticTokens: records.reduce((sum, record) => sum + record.diagnosticTokens, 0),
    retryTokens: records.reduce((sum, record) => sum + record.retryTokens, 0),
    cacheTokens: records.reduce((sum, record) => sum + record.cacheTokens, 0),
    byType: [...types.entries()]
      .map(([type, value]) => ({ type, ...value }))
      .sort((left, right) => right.count - left.count),
    byDay: [...days.entries()]
      .map(([date, value]) => ({ date, ...value }))
      .sort((left, right) => left.date.localeCompare(right.date)),
    records: records.sort((left, right) => right.failedAt.localeCompare(left.failedAt)),
  };
}
