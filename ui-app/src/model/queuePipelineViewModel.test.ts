import { describe, expect, it } from "vitest";
import type { LoopSlotView, WorkflowBucketView } from "./dashboardViewModel";
import {
  buildQueuePipeline,
  matchesTask,
  type PipelineBoardView,
  type PipelineColumnId,
  type QueuePipelineInput,
} from "./queuePipelineViewModel";
import type { UiHumanReviewTask, UiWaveRefillDecision, UiWaveRejection, UiWaveSlot } from "./types";

const NOW = Date.parse("2026-08-15T06:04:00.000Z");

function bucket(name: string, tasks: string[], totalTasks?: number): WorkflowBucketView {
  return {
    name,
    tasks,
    variant: "neutral",
    description: "",
    isQueue: name === "queue",
    totalTasks: totalTasks ?? tasks.length,
  };
}

function slot(overrides: Partial<LoopSlotView> = {}): LoopSlotView {
  return {
    workerId: "w1",
    index: 1,
    desired: "run",
    state: "running",
    taskId: null,
    attempt: null,
    lastWave: null,
    ...overrides,
  };
}

function waveSlot(overrides: Partial<UiWaveSlot> = {}): UiWaveSlot {
  return {
    worker_id: "w1",
    task_id: "1233",
    state: "running",
    lease_status: "held",
    acquired_at: "2026-08-15T06:00:00.000Z",
    heartbeat_at: "2026-08-15T06:03:55.000Z",
    expires_at: "2026-08-15T06:10:00.000Z",
    lease_age_ms: 240_000,
    heartbeat_age_ms: 5_000,
    stale: false,
    has_worktree: true,
    last_failure: null,
    ...overrides,
  };
}

function humanReviewTask(overrides: Partial<UiHumanReviewTask> = {}): UiHumanReviewTask {
  return {
    file: "1240-alpha.md",
    task_id: "1240-alpha",
    title: "Alpha",
    preview: "",
    actions: [],
    ...overrides,
  };
}

function refill(overrides: Partial<UiWaveRefillDecision> = {}): UiWaveRefillDecision {
  return {
    episode: 1,
    worker_id: "w2",
    task_id: "1250-refill",
    granted: false,
    reason: "pool-exhausted",
    hard_capped: 0,
    decided_at: "2026-08-15T06:00:00.000Z",
    rejected: [],
    ...overrides,
  };
}

function input(overrides: Partial<QueuePipelineInput> = {}): QueuePipelineInput {
  return {
    now: NOW,
    buckets: [],
    loopSlots: [],
    waveSlots: undefined,
    humanReview: [],
    rejections: [],
    refillDecisions: [],
    ...overrides,
  };
}

function columnOf(board: PipelineBoardView, id: PipelineColumnId) {
  const found = board.columns.find((column) => column.id === id);
  if (!found) throw new Error(`column ${id} is missing`);
  return found;
}

describe("buildQueuePipeline structure", () => {
  it("always returns all five columns, even when every source is empty", () => {
    const board = buildQueuePipeline(input());

    expect(board.columns.map((column) => column.id)).toEqual(["ready", "running", "blocked", "failed", "done"]);
    for (const column of board.columns) {
      // Dingęs stulpelis paslėptų faktą, kad jis tuščias.
      expect(column.rows).toEqual([]);
      expect(column.total).toBe(0);
      expect(column.truncated).toBe(false);
    }
    expect(board.sources).toEqual({ wavesKnown: false, dashboardKnown: false });
  });

  it("names the missing sources instead of showing an empty board as a fact", () => {
    const known = buildQueuePipeline(input({ buckets: [bucket("queue", [])], waveSlots: [] }));

    expect(known.sources).toEqual({ wavesKnown: true, dashboardKnown: true });
  });

  it("keeps the server-side total when only a slice of tasks was sent", () => {
    const board = buildQueuePipeline(input({ buckets: [bucket("queue", ["0001-a.md", "0002-b.md"], 42)] }));
    const ready = columnOf(board, "ready");

    expect(ready.rows).toHaveLength(2);
    expect(ready.total).toBe(42);
    expect(ready.truncated).toBe(true);
  });
});

describe("buildQueuePipeline ready column", () => {
  it("sorts queued tasks lexicographically, because that is the execution order", () => {
    const board = buildQueuePipeline(
      input({ buckets: [bucket("queue", ["1233-c.md", "0011-a.md", "0940-b.md"])] }),
    );

    expect(columnOf(board, "ready").rows.map((row) => row.label)).toEqual(["0011-a", "0940-b", "1233-c"]);
  });
});

describe("buildQueuePipeline running column", () => {
  it("merges a bucket file into the slot that already runs it and keeps the attempt count", () => {
    const board = buildQueuePipeline(
      input({
        buckets: [bucket("delegated", ["1233-foo.md"])],
        loopSlots: [slot({ taskId: "1233", attempt: 3 })],
        waveSlots: [waveSlot({ task_id: "1233" })],
      }),
    );
    const running = columnOf(board, "running");

    expect(running.rows).toHaveLength(1);
    expect(running.rows[0]).toMatchObject({
      label: "1233",
      taskId: "1233",
      attempts: 3,
      streamIndex: 1,
      worktree: "yes",
      ageMs: 240_000,
    });
  });

  it("shows both rows rather than merging on a guess when the names do not match", () => {
    const board = buildQueuePipeline(
      input({
        buckets: [bucket("delegated", ["1233b-foo.md"])],
        loopSlots: [slot({ taskId: "1233", attempt: 1 })],
      }),
    );
    const running = columnOf(board, "running");

    expect(running.rows.map((row) => row.label)).toEqual(["1233", "1233b-foo"]);
  });

  it("matches an exact file name and an ID prefix, but never a partial one", () => {
    expect(matchesTask("1233.md", "1233")).toBe(true);
    expect(matchesTask("1233-foo.md", "1233")).toBe(true);
    expect(matchesTask("1233b-foo.md", "1233")).toBe(false);
    expect(matchesTask("a-1233.md", "1233")).toBe(false);
  });

  it("orders running rows by stream number and leaves stream-less rows at the end", () => {
    const board = buildQueuePipeline(
      input({
        buckets: [bucket("active", ["0999-validating.md"])],
        loopSlots: [
          slot({ workerId: "w2", index: 2, taskId: "1234" }),
          slot({ workerId: "w1", index: 1, taskId: "1233" }),
        ],
      }),
    );

    expect(columnOf(board, "running").rows.map((row) => row.label)).toEqual(["1233", "1234", "0999-validating"]);
  });

  it("refuses another task's lease for the timer and the worktree flag", () => {
    const board = buildQueuePipeline(
      input({
        loopSlots: [slot({ taskId: "1233", attempt: 1 })],
        // Žinomas „reused-lease" defektas: lease'as neša KITOS užduoties vardą.
        waveSlots: [waveSlot({ task_id: "1230-finished" })],
      }),
    );

    expect(columnOf(board, "running").rows[0]).toMatchObject({ worktree: "unknown", ageMs: null });
  });

  it("separates a task under validation from one an agent is working on", () => {
    const board = buildQueuePipeline(
      input({ buckets: [bucket("active", ["0999-a.md"]), bucket("delegated", ["1000-b.md"])] }),
    );

    expect(columnOf(board, "running").rows.map((row) => row.stateLabelKey)).toEqual([
      "Under validation",
      "Agent is working",
    ]);
  });
});

describe("buildQueuePipeline blocked column", () => {
  it("reports a task waiting for a human once, with the strongest reason", () => {
    const rejections: UiWaveRejection[] = [{ task_id: "1240-alpha", reason: "legacy-reads", detail: "stop-status" }];
    const board = buildQueuePipeline(
      input({
        humanReview: [humanReviewTask({ blocked_by: "supervisor approval" })],
        rejections,
      }),
    );
    const blocked = columnOf(board, "blocked");

    expect(blocked.rows).toHaveLength(1);
    expect(blocked.rows[0].reason).toEqual({ kind: "blocked_by", text: "supervisor approval" });
  });

  it("falls back to the plain reason when nothing blocks the task explicitly", () => {
    const board = buildQueuePipeline(input({ humanReview: [humanReviewTask({ reason: "needs a decision" })] }));

    expect(columnOf(board, "blocked").rows[0].reason).toEqual({ kind: "reason", text: "needs a decision" });
  });

  it("keeps the wave rejection code together with its detail", () => {
    const board = buildQueuePipeline(
      input({ rejections: [{ task_id: "1245-beta", reason: "legacy-reads", detail: "stop-status read" }] }),
    );

    expect(columnOf(board, "blocked").rows[0].reason).toEqual({
      kind: "rejection",
      text: "legacy-reads — stop-status read",
    });
  });

  it("ignores granted refills and marks a hard cap as such", () => {
    const board = buildQueuePipeline(
      input({
        refillDecisions: [
          refill({ task_id: "1250-granted", granted: true, reason: "ok" }),
          refill({ task_id: "1251-capped", granted: false, reason: "hard-cap", hard_capped: 2 }),
        ],
      }),
    );
    const blocked = columnOf(board, "blocked");

    expect(blocked.rows).toHaveLength(1);
    expect(blocked.rows[0]).toMatchObject({
      taskId: "1251-capped",
      stateLabelKey: "Hard cap reached",
      reason: { kind: "waiting_for", text: "hard-cap (hard_capped=2)" },
    });
  });

  it("says a stream is simply missing when no hard cap was hit", () => {
    const board = buildQueuePipeline(input({ refillDecisions: [refill({ hard_capped: 0 })] }));

    expect(columnOf(board, "blocked").rows[0]).toMatchObject({
      stateLabelKey: "Waiting for a slot",
      reason: { kind: "waiting_for", text: "pool-exhausted" },
    });
  });
});

describe("buildQueuePipeline failed and done columns", () => {
  it("keeps a recoverable error apart from a task that exhausted its retries", () => {
    const board = buildQueuePipeline(
      input({ buckets: [bucket("error", ["1260-e.md"]), bucket("failed", ["1261-f.md"])] }),
    );
    const failed = columnOf(board, "failed");

    expect(failed.rows.map((row) => [row.stateLabelKey, row.tone])).toEqual([
      ["Recovery in progress", "warning"],
      ["Retries exhausted", "error"],
    ]);
    expect(failed.total).toBe(2);
  });

  it("caps the done column and stays honest about how much was cut", () => {
    const files = Array.from({ length: 12 }, (_, index) => `13${String(index).padStart(2, "0")}-done.md`);
    const board = buildQueuePipeline(input({ buckets: [bucket("done", files, 42)] }));
    const done = columnOf(board, "done");

    expect(done.rows).toHaveLength(10);
    expect(done.total).toBe(42);
    expect(done.truncated).toBe(true);
  });

  it("does not claim truncation when the whole column fits", () => {
    const board = buildQueuePipeline(input({ buckets: [bucket("done", ["1300-done.md"], 1)] }));
    const done = columnOf(board, "done");

    expect(done.rows).toHaveLength(1);
    expect(done.truncated).toBe(false);
  });
});
