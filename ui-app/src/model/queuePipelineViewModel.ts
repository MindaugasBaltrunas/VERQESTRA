import type { LoopSlotView, WorkflowBucketView } from "./dashboardViewModel";
import { elapsedMsFrom } from "./slotProgressViewModel";
import type { UiHumanReviewTask, UiWaveRefillDecision, UiWaveRejection, UiWaveSlot } from "./types";

export type PipelineColumnId = "ready" | "running" | "blocked" | "failed" | "done";

export type PipelineRow = {
  key: string;
  label: string;
  taskId: string | null;
  /** i18n RAKTAS, ne išverstas tekstas: modelis `t()` neturi ir turėti negali. */
  stateLabelKey: string;
  reason: { kind: "blocked_by" | "waiting_for" | "reason" | "rejection"; text: string } | null;
  attempts: number | null;
  streamIndex: number | null;
  worktree: "yes" | "no" | "unknown" | null;
  ageMs: number | null;
  tone: "neutral" | "live" | "warning" | "error" | "good";
};

export type PipelineColumn = {
  id: PipelineColumnId;
  titleKey: string;
  rows: PipelineRow[];
  /** Serverio žinomas VISAS kiekis; `rows` gali būti trumpesnis (`truncated`). */
  total: number;
  truncated: boolean;
};

export type PipelineBoardView = {
  columns: PipelineColumn[];
  /** Ko trūksta: be bangų duomenų blokavimo priežastys nepilnos, ir tai turi būti pasakyta. */
  sources: { wavesKnown: boolean; dashboardKnown: boolean };
};

export type QueuePipelineInput = {
  now: number;
  buckets: readonly WorkflowBucketView[];
  loopSlots: readonly LoopSlotView[];
  waveSlots: readonly UiWaveSlot[] | undefined;
  humanReview: readonly UiHumanReviewTask[];
  rejections: readonly UiWaveRejection[];
  refillDecisions: readonly UiWaveRefillDecision[];
};

/**
 * `Failed` stulpelio raktas yra „Failed tasks", o ne „Failed": žodyne „Failed" jau reiškia
 * „Sugedo" (gedimų lentelės stulpelis), o plokščiame `lt` žodyne pakartotas raktas tyliai
 * perrašytų ankstesnį vertimą.
 */
const COLUMN_TITLE_KEYS: Record<PipelineColumnId, string> = {
  ready: "Queued",
  running: "In progress",
  blocked: "Blocked",
  failed: "Failed tasks",
  done: "Done",
};

/** Baigtų užduočių gali būti šimtai — rodoma naujausia dalis, o `truncated` pasako, kad ne viskas. */
const DONE_ROW_LIMIT = 10;

function stripMd(fileName: string): string {
  return fileName.replace(/\.md$/i, "");
}

/**
 * Failo vardas prieš užduoties ID. Sutampa tik tikslus vardas arba `ID-…` prefiksas — jokio
 * „panašumo": nesutapus rodomos ABI eilutės, nes suliejimas pagal spėjimą paslėptų realų darbą.
 */
export function matchesTask(fileName: string, taskId: string): boolean {
  const base = stripMd(fileName);
  return base === taskId || base.startsWith(`${taskId}-`);
}

function bucketOf(buckets: readonly WorkflowBucketView[], name: string): WorkflowBucketView | null {
  return buckets.find((bucket) => bucket.name === name) ?? null;
}

function column(id: PipelineColumnId, rows: PipelineRow[], total: number): PipelineColumn {
  return { id, titleKey: COLUMN_TITLE_KEYS[id], rows, total: Math.max(total, rows.length), truncated: total > rows.length };
}

function readyColumn(buckets: readonly WorkflowBucketView[]): PipelineColumn {
  const queue = bucketOf(buckets, "queue");
  const rows: PipelineRow[] = (queue?.tasks ?? []).map((file) => ({
    key: `ready:${file}`,
    label: stripMd(file),
    taskId: null,
    stateLabelKey: "Waiting to start",
    reason: null,
    attempts: null,
    streamIndex: null,
    worktree: null,
    ageMs: null,
    tone: "neutral",
  }));
  // Leksikografinė tvarka pagal `0940` konvenciją YRA vykdymo tvarka, o ne vien estetika.
  rows.sort((left, right) => left.label.localeCompare(right.label));
  return column("ready", rows, queue?.totalTasks ?? rows.length);
}

function runningColumn(input: QueuePipelineInput): PipelineColumn {
  const rows: PipelineRow[] = [];
  const busySlots = input.loopSlots.filter((slot) => slot.taskId !== null);

  for (const slot of busySlots) {
    // Lease'as imamas tik kai jo užduotis sutampa su srauto užduotimi: nesutapus laikmatis ir darbo
    // kopija priklauso KITAI užduočiai (žinomas „reused-lease" defektas).
    const lease = input.waveSlots?.find((wave) => wave.worker_id === slot.workerId && wave.task_id === slot.taskId) ?? null;
    rows.push({
      key: `running:${slot.workerId}`,
      label: slot.taskId ?? slot.workerId,
      taskId: slot.taskId,
      stateLabelKey: "Running",
      reason: null,
      attempts: slot.attempt,
      streamIndex: slot.index,
      worktree: lease === null ? "unknown" : lease.has_worktree ? "yes" : "no",
      ageMs: lease === null ? null : elapsedMsFrom(lease.acquired_at, lease.lease_age_ms, input.now),
      tone: "live",
    });
  }

  for (const name of ["active", "delegated"] as const) {
    const bucket = bucketOf(input.buckets, name);
    for (const file of bucket?.tasks ?? []) {
      const claimed = busySlots.some((slot) => slot.taskId !== null && matchesTask(file, slot.taskId));
      if (claimed) continue;
      rows.push({
        key: `running:${name}:${file}`,
        label: stripMd(file),
        taskId: null,
        stateLabelKey: name === "active" ? "Under validation" : "Agent is working",
        reason: null,
        attempts: null,
        streamIndex: null,
        worktree: null,
        ageMs: null,
        tone: "live",
      });
    }
  }

  // Rikiuojama pagal srauto numerį; eilutės be srauto lieka gale savo pradine tvarka.
  const order = (row: PipelineRow) => row.streamIndex ?? Number.MAX_SAFE_INTEGER;
  rows.sort((left, right) => order(left) - order(right));
  return column("running", rows, rows.length);
}

function blockedColumn(input: QueuePipelineInput): PipelineColumn {
  const rows: PipelineRow[] = [];
  const seen = new Set<string>();

  for (const task of input.humanReview) {
    seen.add(task.task_id);
    rows.push({
      key: `blocked:review:${task.task_id}`,
      label: task.title || task.task_id,
      taskId: task.task_id,
      stateLabelKey: "Requires your attention",
      reason: task.blocked_by
        ? { kind: "blocked_by", text: task.blocked_by }
        : task.reason
          ? { kind: "reason", text: task.reason }
          : null,
      attempts: null,
      streamIndex: null,
      worktree: null,
      ageMs: null,
      tone: "warning",
    });
  }

  for (const rejection of input.rejections) {
    if (seen.has(rejection.task_id)) continue;
    seen.add(rejection.task_id);
    rows.push({
      key: `blocked:rejection:${rejection.task_id}`,
      label: rejection.task_id,
      taskId: rejection.task_id,
      stateLabelKey: "Rejected by the wave",
      reason: {
        kind: "rejection",
        // `reason` yra pool'o KODAS (`legacy-reads`, `missing-lease`) — jis neverčiamas, nes būtent
        // jo ieškoma log'e ir snapshot'e.
        text: rejection.detail ? `${rejection.reason} — ${rejection.detail}` : rejection.reason,
      },
      attempts: null,
      streamIndex: null,
      worktree: null,
      ageMs: null,
      tone: "warning",
    });
  }

  for (const decision of input.refillDecisions) {
    if (decision.granted || seen.has(decision.task_id)) continue;
    seen.add(decision.task_id);
    rows.push({
      key: `blocked:refill:${decision.task_id}`,
      label: decision.task_id,
      taskId: decision.task_id,
      stateLabelKey: decision.hard_capped > 0 ? "Hard cap reached" : "Waiting for a slot",
      reason: {
        kind: "waiting_for",
        text: decision.hard_capped > 0 ? `${decision.reason} (hard_capped=${decision.hard_capped})` : decision.reason,
      },
      attempts: null,
      streamIndex: null,
      worktree: null,
      ageMs: null,
      tone: "warning",
    });
  }

  return column("blocked", rows, rows.length);
}

function failedColumn(buckets: readonly WorkflowBucketView[]): PipelineColumn {
  const error = bucketOf(buckets, "error");
  const failed = bucketOf(buckets, "failed");
  const rows: PipelineRow[] = [];

  // `error` ir `failed` yra skirtingi faktai: pirmas dar taisomas, antras jau išnaudojo bandymus.
  for (const file of error?.tasks ?? []) {
    rows.push({
      key: `failed:error:${file}`,
      label: stripMd(file),
      taskId: null,
      stateLabelKey: "Recovery in progress",
      reason: null,
      attempts: null,
      streamIndex: null,
      worktree: null,
      ageMs: null,
      tone: "warning",
    });
  }
  for (const file of failed?.tasks ?? []) {
    rows.push({
      key: `failed:failed:${file}`,
      label: stripMd(file),
      taskId: null,
      stateLabelKey: "Retries exhausted",
      reason: null,
      attempts: null,
      streamIndex: null,
      worktree: null,
      ageMs: null,
      tone: "error",
    });
  }

  return column("failed", rows, (error?.totalTasks ?? 0) + (failed?.totalTasks ?? 0));
}

function doneColumn(buckets: readonly WorkflowBucketView[]): PipelineColumn {
  const done = bucketOf(buckets, "done");
  const rows: PipelineRow[] = (done?.tasks ?? []).slice(0, DONE_ROW_LIMIT).map((file) => ({
    key: `done:${file}`,
    label: stripMd(file),
    taskId: null,
    stateLabelKey: "Completed",
    reason: null,
    attempts: null,
    streamIndex: null,
    worktree: null,
    ageMs: null,
    tone: "good",
  }));
  return column("done", rows, done?.totalTasks ?? rows.length);
}

/**
 * Scheduler'io būsena kiekvienai užduočiai. VISI penki stulpeliai grąžinami visada — dingęs
 * stulpelis paslėptų faktą, kad jis tuščias, ir dar šokdintų išdėstymą.
 */
export function buildQueuePipeline(input: QueuePipelineInput): PipelineBoardView {
  return {
    columns: [
      readyColumn(input.buckets),
      runningColumn(input),
      blockedColumn(input),
      failedColumn(input.buckets),
      doneColumn(input.buckets),
    ],
    sources: { wavesKnown: input.waveSlots !== undefined, dashboardKnown: input.buckets.length > 0 },
  };
}
