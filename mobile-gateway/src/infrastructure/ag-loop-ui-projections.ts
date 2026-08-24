import path from "node:path";
import {
  redactedString,
  redactedStringOrNull,
  redactSensitiveText,
} from "../application/ag-loop-read-redaction.js";
import {
  AG_LOOP_LOG_LINE_CHAR_LIMIT,
  type AgLoopActivity,
  type AgLoopDashboard,
  type AgLoopLearning,
  type AgLoopLearningRecommendation,
  type AgLoopLogName,
  type AgLoopLogs,
  type AgLoopPolicyControl,
  type AgLoopPolicyControls,
  type AgLoopPolicyGroup,
  type AgLoopTaskBucket,
  type AgLoopTokenAnalytics,
  type AgLoopTokenAnalyticsSnapshot,
  type AgLoopTokenBucket,
  type AgLoopTokenUsage,
  type AgLoopTokenUsageRecord,
} from "../application/ports/ag-loop-ui-read-port.js";

/**
 * Upstream JSON → mobile DTO. Grynos projekcijos, be nė vieno tinklo kvietimo.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `ag-loop-ui-http-adapter.ts` buvo 596
 * eilutės). Pjūvis vienas: čia — kaip svetimas atsakymas verčiamas reikšme, kuria galima
 * tikėtis; `ag-loop-ui-http-adapter.ts` — kaip su ta puse apskritai kalbamasi.
 *
 * Visos ribos ir redakcija gyvena čia, nes jos yra projekcijos savybė, o ne transporto:
 * upstream yra to paties host'o ir laikomas SĄŽININGU, bet ne mažu ir ne švariu.
 */

export const taskBuckets = new Set([
  "queue",
  "active",
  "delegated",
  "done",
  "error",
  "failed",
  "human-review",
]);

/**
 * Runtime procesų vardai, kuriuos projekcija praleidžia.
 *
 * Patikrinta prieš VERQESTRA (2026-08-24): `interfaces/http/ui-dashboard-view.ts` išveda
 * tiksliai šiuos tris — `"AG UI"`, `toRuntimeProcess("AG loop", …)`,
 * `toRuntimeProcess("User Claude terminal", …)`. Sąrašas sutampa 1:1, tad filtras nieko
 * tyliai nenumeta. Jei serverio pusė kada nors pervardys procesą, ekranas jį PRARAS be jokios
 * klaidos — tai antra vieta (po token'o antraštės), kur dvi pakuotės privalo sutarti dėl
 * literalo, kurio nė vienas kompiliatorius nesutikrins.
 */
const runtimeNames = new Set(["AG UI", "AG loop", "User Claude terminal"]);

/** Field bounds for short labelled values (agent names, phases, models, ids). */
const LABEL_CHARS = 120;
/** Free-text projections: an activity line, a learning summary, a reason hint. */
const SUMMARY_CHARS = 512;
/** Upper bound on collection sizes a phone screen can meaningfully render. */
const MAX_COLLECTION_ITEMS = 100;

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(value) ? value : null;
}

function status(value: unknown): "running" | "stopped" | "unknown" {
  return value === "running" || value === "stopped" ? value : "unknown";
}

/** Finite non-negative number, or `0` — an upstream `NaN` must not reach the DTO. */
function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** ISO-8601 instants only: a timestamp field is not a place for free text. */
function timestamp(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]{1,15}(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? value
    : "";
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

/**
 * Bucket → task count, read from the ONE place the server still publishes it.
 *
 * VERQESTRA UI turėjo `queueCounts` žemėlapį IR `workflowBuckets[].totalCount`; 2026-08-24
 * `queueCounts` pašalintas kaip to paties skaičiaus dublikatas. Ši projekcija jo vis dar
 * skaitė, tad telefone visi skaitikliai virto nuliais, nors grafe buvo 13 queued ir 1 done.
 *
 * `queueCounts` NĖRA paliktas kaip atsarginis kelias sąmoningai: būtent dviguba forma ir
 * leido lūžiui pragyventi — mobile fikstūra tiekė lauką, kurio serveris nebesiuntė, tad abu
 * paketai atskirai buvo žali. Vienas šaltinis reiškia, kad kitas jo dingimas krenta iš karto.
 *
 * Kintamasis vadinasi `dashboard`, o ne `source`, SĄMONINGAI: `src/tests/contract-mobile-dashboard.test.ts`
 * randa dashboard payload'o laukus būtent per šį vardą. Kiti šio failo projekcijos skaito KITUS
 * atsakymus (task bucket'ą, logus), tad bendras `source` tą kryžminį vartą paverstų triukšmu.
 */
function bucketCounts(dashboard: Record<string, unknown>): Record<string, number> {
  const byName = new Map<string, number>();
  for (const entry of list(dashboard["workflowBuckets"])) {
    const bucket = record(entry);
    const name = bucket["name"];
    const total = bucket["totalCount"];
    if (typeof name === "string" && typeof total === "number" && Number.isSafeInteger(total) && total >= 0) {
      byName.set(name, total);
    }
  }
  const counts: Record<string, number> = {};
  for (const bucket of taskBuckets) {
    counts[bucket] = byName.get(bucket) ?? 0;
  }
  return counts;
}

export function projectDashboardPayload(payload: unknown, now = new Date()): AgLoopDashboard {
  const dashboard = record(payload);
  const queueCounts = bucketCounts(dashboard);
  const runtime = Array.isArray(dashboard["runtime"])
    ? dashboard["runtime"]
      .map(record)
      .filter((item) => runtimeNames.has(String(item["name"])))
      .map((item) => ({ name: String(item["name"]), status: status(item["status"]) }))
    : [];
  const controlPlane = record(dashboard["controlPlane"]);
  const reviews = Array.isArray(controlPlane["human_review_tasks"])
    ? controlPlane["human_review_tasks"].length
    : 0;
  const currentTaskId = boundedId(dashboard["currentTaskId"]);
  const rawState = dashboard["currentTaskState"];
  const currentState = rawState === "active" || rawState === "stale" ? rawState : "none";
  return Object.freeze({
    availability: "online",
    currentTask: Object.freeze({ id: currentTaskId, state: currentState }),
    queueCounts: Object.freeze(queueCounts),
    runtime: Object.freeze(runtime),
    reviewCount: reviews,
    updatedAt: now.toISOString(),
  });
}

export function projectTaskBucketPayload(payload: unknown, bucket: string): AgLoopTaskBucket {
  const source = record(payload);
  const tasks = Array.isArray(source["tasks"])
    ? source["tasks"]
      .filter((value): value is string => typeof value === "string")
      // `path.basename` is platform-shaped: on a POSIX host it keeps a
      // backslash-separated name whole. Both separators are stripped first so
      // the projection cannot depend on where the gateway runs, and the result
      // still goes through redaction — a task name is upstream text like any
      // other, and control characters have no place in a mobile DTO.
      .map((value) => redactSensitiveText(path.basename(value.replace(/\\/g, "/")), 255))
      .slice(0, 100)
    : [];
  const total = source["totalCount"];
  return Object.freeze({
    bucket,
    tasks: Object.freeze(tasks),
    totalCount: typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : tasks.length,
  });
}

export function projectLogsPayload(payload: unknown, log: AgLoopLogName, lines: number): AgLoopLogs {
  const source = record(payload);
  const rawLines = list(source["lines"]).filter((value): value is string => typeof value === "string");
  const kept = rawLines.slice(-lines);
  return Object.freeze({
    log,
    lines: Object.freeze(kept.map((line) => redactSensitiveText(line, AG_LOOP_LOG_LINE_CHAR_LIMIT))),
    truncated: source["truncated"] === true || kept.length < rawLines.length,
  });
}

function projectTokenUsageRecord(value: unknown): AgLoopTokenUsageRecord {
  const source = record(value);
  const outcome = source["outcome"];
  return Object.freeze({
    ts: timestamp(source["ts"]),
    phase: redactedString(source["phase"], LABEL_CHARS),
    taskId: boundedId(source["task_id"]) ?? "",
    model: redactedString(source["model"], LABEL_CHARS),
    attempt: safeInteger(source["attempt"]),
    outcome: outcome === "succeeded" || outcome === "failed" || outcome === "infrastructure"
      ? outcome
      : null,
    inputTokens: safeNumber(source["input_tokens"]),
    outputTokens: safeNumber(source["output_tokens"]),
    cacheReadInputTokens: safeNumber(source["cache_read_input_tokens"]),
    cacheCreationInputTokens: safeNumber(source["cache_creation_input_tokens"]),
    totalCostUsd: safeNumber(source["total_cost_usd"]),
  });
}

export function projectTokenUsagePayload(payload: unknown, limit: number): AgLoopTokenUsage {
  const source = record(payload);
  return Object.freeze({
    records: Object.freeze(list(source["records"]).slice(0, limit).map(projectTokenUsageRecord)),
  });
}

function projectTokenBuckets(value: unknown): readonly AgLoopTokenBucket[] {
  return Object.freeze(list(value).slice(0, MAX_COLLECTION_ITEMS).map((entry) => {
    const bucket = record(entry);
    return Object.freeze({
      key: redactedString(bucket["key"], LABEL_CHARS),
      totalTokens: safeNumber(bucket["totalTokens"]),
    });
  }));
}

function projectAnalyticsSnapshot(value: unknown): AgLoopTokenAnalyticsSnapshot {
  const snapshot = record(value);
  const totals = record(snapshot["totals"]);
  return Object.freeze({
    generatedAt: timestamp(snapshot["generatedAt"]),
    totals: Object.freeze({
      records: safeNumber(totals["records"]),
      totalTokens: safeNumber(totals["totalTokens"]),
      uniqueTasks: safeNumber(totals["uniqueTasks"]),
    }),
    tokensByPhase: projectTokenBuckets(snapshot["tokensByPhase"]),
    tokensByModel: projectTokenBuckets(snapshot["tokensByModel"]),
    tokensByDay: projectTokenBuckets(snapshot["tokensByDay"]),
    cacheHitRate: safeNumber(snapshot["cacheHitRate"]),
    repairShare: safeNumber(snapshot["repairShare"]),
  });
}

export function projectTokenAnalyticsPayload(payload: unknown): AgLoopTokenAnalytics {
  const source = record(payload);
  const history = list(source["history"]);
  return Object.freeze({
    candidates: Object.freeze(
      list(source["candidates"]).slice(0, MAX_COLLECTION_ITEMS).map((entry) => {
        const candidate = record(entry);
        return Object.freeze({
          taskId: boundedId(candidate["taskId"]) ?? "",
          familyKey: redactedString(candidate["familyKey"], LABEL_CHARS),
          taskTokens: safeNumber(candidate["taskTokens"]),
          groupMedianTokens: safeNumber(candidate["groupMedianTokens"]),
          multiplier: safeNumber(candidate["multiplier"]),
          reasonHint: redactedString(candidate["reasonHint"], SUMMARY_CHARS),
        });
      }),
    ),
    latestSnapshot: history.length === 0
      ? null
      : projectAnalyticsSnapshot(history[history.length - 1]),
  });
}

function projectPolicyControl(value: unknown): AgLoopPolicyControl {
  const control = record(value);
  const raw = control["value"];
  return Object.freeze({
    id: redactedString(control["id"], LABEL_CHARS),
    label: redactedString(control["label"], LABEL_CHARS),
    value: typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw))
      ? raw
      : typeof raw === "string"
        ? redactSensitiveText(raw, LABEL_CHARS)
        : null,
  });
}

/**
 * Projects the control-plane block of the dashboard payload. The AG Loop UI has
 * no dedicated policy endpoint: `policy_controls` is one field of
 * `GET /api/dashboard`, so this read costs no extra upstream route.
 */
export function projectPolicyControlsPayload(payload: unknown): AgLoopPolicyControls {
  const controlPlane = record(record(payload)["controlPlane"]);
  const groups = list(controlPlane["policy_controls"])
    .slice(0, MAX_COLLECTION_ITEMS)
    .map((entry): AgLoopPolicyGroup => {
      const group = record(entry);
      return Object.freeze({
        id: redactedString(group["group"], LABEL_CHARS),
        label: redactedString(group["label"], LABEL_CHARS),
        controls: Object.freeze(
          list(group["controls"]).slice(0, MAX_COLLECTION_ITEMS).map(projectPolicyControl),
        ),
      });
    });
  return Object.freeze({ groups: Object.freeze(groups) });
}

export function projectLearningPayload(payload: unknown): AgLoopLearning {
  const controlPlane = record(record(payload)["controlPlane"]);
  const summary = record(controlPlane["learning_summary"]);
  const byTypeSource = record(summary["by_type"]);
  const byType: Record<string, number> = {};
  for (const [key, value] of Object.entries(byTypeSource).slice(0, MAX_COLLECTION_ITEMS)) {
    byType[redactSensitiveText(key, LABEL_CHARS)] = safeNumber(value);
  }
  const recommendations = list(controlPlane["learning_recommendations"])
    .slice(0, MAX_COLLECTION_ITEMS)
    .map((entry): AgLoopLearningRecommendation => {
      const recommendation = record(entry);
      const state = recommendation["recommendation_status"] ?? recommendation["status"];
      return Object.freeze({
        id: boundedId(recommendation["id"]) ?? "",
        status: state === "approved" || state === "rejected" ? state : "pending",
        summary: redactedString(recommendation["summary"], SUMMARY_CHARS),
        labels: Object.freeze(
          list(recommendation["labels"])
            .slice(0, MAX_COLLECTION_ITEMS)
            .filter((label): label is string => typeof label === "string")
            .map((label) => redactSensitiveText(label, LABEL_CHARS)),
        ),
      });
    });
  return Object.freeze({
    summary: Object.freeze({
      records: safeNumber(summary["records"]),
      byType: Object.freeze(byType),
      pendingRecommendations: safeNumber(summary["pending_recommendations"]),
      approvedRecommendations: safeNumber(summary["approved_recommendations"]),
      rejectedRecommendations: safeNumber(summary["rejected_recommendations"]),
    }),
    recommendations: Object.freeze(recommendations),
  });
}

export function projectActivityPayload(payload: unknown): AgLoopActivity {
  const source = record(payload);
  const statusSource = record(source["statuses"]);
  const statuses: Record<string, string> = {};
  for (const [agent, value] of Object.entries(statusSource).slice(0, MAX_COLLECTION_ITEMS)) {
    statuses[redactSensitiveText(agent, LABEL_CHARS)] = redactedString(value, LABEL_CHARS);
  }
  const mode = source["mode"];
  return Object.freeze({
    chain: Object.freeze(
      list(source["chain"])
        .slice(0, MAX_COLLECTION_ITEMS)
        .filter((agent): agent is string => typeof agent === "string")
        .map((agent) => redactSensitiveText(agent, LABEL_CHARS)),
    ),
    statuses: Object.freeze(statuses),
    currentAgent: redactedStringOrNull(source["currentAgent"], LABEL_CHARS),
    // The upstream parser copies up to 50 characters of the Bash command line
    // into this field (`audit-remediation.md` P1), so it is redacted like a log
    // line rather than trusted like a label.
    currentActivity: redactedStringOrNull(source["currentActivity"], SUMMARY_CHARS),
    taskId: boundedId(source["taskId"]),
    claudeStatus: redactedStringOrNull(source["claudeStatus"], LABEL_CHARS),
    mode: mode === "subagents" || mode === "inline" ? mode : "idle",
    updatedAt: timestamp(source["updatedAt"]),
  });
}
