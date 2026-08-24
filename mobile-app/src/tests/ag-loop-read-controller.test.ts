import assert from "node:assert/strict";
import test from "node:test";

import { presentTasks } from "../controller/presentation/ag-loop-presenter.js";
import { AgLoopReadController } from "../controller/ag-loop-read-controller.js";
import {
  AgLoopReadError,
  type AgLoopDashboardSnapshot,
  type AgLoopTaskBucket,
  type AgLoopTaskBucketSnapshot,
  type AgLoopUiReadPort,
} from "../model/ag-loop-read.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";

const projectId = "8f1c2b6a-0f2e-4c53-9d64-1f4a7f0c8d21";

function dashboard(availability: "online" | "offline" = "online"): AgLoopDashboardSnapshot {
  return Object.freeze({
    availability,
    currentTask: Object.freeze({ id: "0042-do-a-thing", state: "active" as const }),
    queueCounts: Object.freeze({ queue: 1 }),
    runtime: Object.freeze([]),
    reviewCount: 0,
    updatedAt: "2026-08-10T10:00:00.000Z",
  });
}

class FakeReadPort implements AgLoopUiReadPort {
  readonly dashboardCalls: string[] = [];
  readonly bucketCalls: AgLoopTaskBucket[] = [];

  constructor(
    private readonly dashboardResult: () => Promise<AgLoopDashboardSnapshot>,
    private readonly bucketResult: (bucket: AgLoopTaskBucket) => Promise<AgLoopTaskBucketSnapshot>,
  ) {}

  async readDashboard(input: Readonly<{ projectId: string }>): Promise<AgLoopDashboardSnapshot> {
    this.dashboardCalls.push(input.projectId);
    return this.dashboardResult();
  }

  async readTaskBucket(input: Readonly<{
    projectId: string;
    bucket: AgLoopTaskBucket;
  }>): Promise<AgLoopTaskBucketSnapshot> {
    this.bucketCalls.push(input.bucket);
    return this.bucketResult(input.bucket);
  }
}

function recorder(): Readonly<{
  dispatch: (event: AppEvent) => void;
  events: readonly AppEvent[];
  state: () => AppState;
}> {
  const events: AppEvent[] = [];
  return {
    dispatch: (event) => void events.push(event),
    events,
    state: () => events.reduce(reduceAppState, initialAppState),
  };
}

function bucketSnapshot(bucket: AgLoopTaskBucket): AgLoopTaskBucketSnapshot {
  return Object.freeze({ bucket, tasks: Object.freeze([`${bucket}-task.md`]), totalCount: 1 });
}

type Pending = Readonly<{ resolve: (snapshot: AgLoopTaskBucketSnapshot) => void }>;

/**
 * A read port whose bucket reads never settle on their own, so a test can decide
 * the answer order and reproduce an overlapping read. Everything stays on the
 * microtask queue: no timers, no polling, no flakiness.
 */
function gatedBucketPort(): Readonly<{ port: FakeReadPort; pending: Map<AgLoopTaskBucket, Pending> }> {
  const pending = new Map<AgLoopTaskBucket, Pending>();
  const port = new FakeReadPort(
    async () => dashboard(),
    (bucket) => new Promise<AgLoopTaskBucketSnapshot>((resolve) => {
      pending.set(bucket, Object.freeze({ resolve }));
    }),
  );
  return { port, pending };
}

/** Lets every already-scheduled continuation run without advancing real time. */
async function settleMicrotasks(): Promise<void> {
  for (let step = 0; step < 16; step += 1) await Promise.resolve();
}

function pendingRead(
  pending: Map<AgLoopTaskBucket, Pending>,
  bucket: AgLoopTaskBucket,
): Pending {
  const gate = pending.get(bucket);
  assert.ok(gate, `no read is in flight for ${bucket}`);
  return gate;
}

test("a successful refresh reaches connected with both projections", async () => {
  const port = new FakeReadPort(async () => dashboard(), async (bucket) => bucketSnapshot(bucket));
  const sink = recorder();

  await new AgLoopReadController(port, sink.dispatch).refresh({ projectId, bucket: "queue" });

  assert.deepEqual(sink.events.map((event) => event.type), [
    "ag-loop.read-started",
    "ag-loop.dashboard",
    "ag-loop.tasks",
    "ag-loop.read-settled",
  ]);
  const state = sink.state();
  assert.equal(state.agLoopLink, "connected");
  assert.equal(state.agLoopReadsInFlight, 0);
  assert.deepEqual(state.agLoopTaskBucket?.tasks, ["queue-task.md"]);
  assert.deepEqual(port.dashboardCalls, [projectId]);
});

test("an offline AG Loop UI is not asked for task buckets", async () => {
  const port = new FakeReadPort(
    async () => dashboard("offline"),
    async () => {
      throw new Error("task buckets must not be read while AG Loop is offline");
    },
  );
  const sink = recorder();

  await new AgLoopReadController(port, sink.dispatch).refresh({ projectId, bucket: "queue" });

  assert.deepEqual(port.bucketCalls, []);
  const state = sink.state();
  assert.equal(state.agLoopLink, "offline");
  assert.equal(state.agLoopReadError, null, "an offline AG Loop is a state, not a read failure");
});

test("a port failure becomes screen state instead of a thrown command error", async () => {
  const port = new FakeReadPort(
    async () => {
      throw new AgLoopReadError("unavailable", "AG Loop UI is not reachable");
    },
    async (bucket) => bucketSnapshot(bucket),
  );
  const sink = recorder();

  await new AgLoopReadController(port, sink.dispatch).refresh({ projectId, bucket: "queue" });

  assert.deepEqual(sink.events.map((event) => event.type), [
    "ag-loop.read-started",
    "ag-loop.read-failed",
    "ag-loop.read-settled",
  ]);
  const state = sink.state();
  assert.equal(state.agLoopLink, "offline");
  assert.equal(state.agLoopReadError, "unavailable");
  assert.equal(state.agLoopReadsInFlight, 0, "the refresh must settle even after a failure");
});

test("an unknown port rejection is classified as a transport failure", async () => {
  const port = new FakeReadPort(
    async () => {
      throw new TypeError("network request failed");
    },
    async (bucket) => bucketSnapshot(bucket),
  );
  const sink = recorder();

  await new AgLoopReadController(port, sink.dispatch).refresh({ projectId, bucket: "queue" });

  assert.equal(sink.state().agLoopReadError, "transport_failed");
});

test("a reconnect after a failure restores the connected link", async () => {
  let healthy = false;
  const port = new FakeReadPort(
    async () => {
      if (!healthy) throw new AgLoopReadError("transport_failed", "read failed");
      return dashboard();
    },
    async (bucket) => bucketSnapshot(bucket),
  );
  const sink = recorder();
  const controller = new AgLoopReadController(port, sink.dispatch);

  await controller.refresh({ projectId, bucket: "queue" });
  assert.equal(sink.state().agLoopLink, "offline");

  healthy = true;
  await controller.refresh({ projectId, bucket: "queue" });

  const state = sink.state();
  assert.equal(state.agLoopLink, "connected");
  assert.equal(state.agLoopReadError, null);
  assert.deepEqual(port.bucketCalls, ["queue"]);
});

test("selecting a bucket reads only that bucket", async () => {
  const port = new FakeReadPort(async () => dashboard(), async (bucket) => bucketSnapshot(bucket));
  const sink = recorder();
  const controller = new AgLoopReadController(port, sink.dispatch);

  await controller.refresh({ projectId, bucket: "queue" });
  await controller.selectBucket({ projectId, bucket: "human-review" });

  assert.deepEqual(port.dashboardCalls, [projectId], "bucket selection must not re-read the dashboard");
  assert.deepEqual(port.bucketCalls, ["queue", "human-review"]);
  const state = sink.state();
  assert.equal(state.agLoopSelectedBucket, "human-review");
  assert.deepEqual(state.agLoopTaskBucket?.tasks, ["human-review-task.md"]);
});

test("a failed bucket selection degrades the link but keeps the dashboard", async () => {
  let bucketFails = false;
  const port = new FakeReadPort(
    async () => dashboard(),
    async (bucket) => {
      if (bucketFails) throw new AgLoopReadError("transport_failed", "read failed");
      return bucketSnapshot(bucket);
    },
  );
  const sink = recorder();
  const controller = new AgLoopReadController(port, sink.dispatch);

  await controller.refresh({ projectId, bucket: "queue" });
  bucketFails = true;
  await controller.selectBucket({ projectId, bucket: "error" });

  const state = sink.state();
  assert.equal(state.agLoopLink, "degraded");
  assert.equal(state.agLoopReadError, "transport_failed");
  assert.notEqual(state.agLoopDashboard, null);
  assert.equal(state.agLoopTaskBucket, null);
});

test("a refresh answering late never lands under the bucket the user moved to", async () => {
  const { port, pending } = gatedBucketPort();
  const sink = recorder();
  const controller = new AgLoopReadController(port, sink.dispatch);

  const refreshing = controller.refresh({ projectId, bucket: "queue" });
  await settleMicrotasks();
  const queueRead = pendingRead(pending, "queue");

  // The user switches tabs while the refresh is still waiting for `queue`.
  const selecting = controller.selectBucket({ projectId, bucket: "done" });
  await settleMicrotasks();
  const doneRead = pendingRead(pending, "done");

  queueRead.resolve(bucketSnapshot("queue"));
  await refreshing;
  doneRead.resolve(bucketSnapshot("done"));
  await selecting;

  const state = sink.state();
  assert.equal(state.agLoopSelectedBucket, "done", "the user's selection outranks an in-flight read");
  assert.deepEqual(state.agLoopTaskBucket?.tasks, ["done-task.md"], "the abandoned rows must not be shown");
  assert.equal(state.agLoopReadsInFlight, 0, "both reads settled");
  assert.equal(state.agLoopReadError, null, "a superseded read is not a failure");
});

test("an overlapping read keeps the channel busy until the last one settles", async () => {
  const { port, pending } = gatedBucketPort();
  const sink = recorder();
  const controller = new AgLoopReadController(port, sink.dispatch);

  const refreshing = controller.refresh({ projectId, bucket: "queue" });
  await settleMicrotasks();
  const selecting = controller.selectBucket({ projectId, bucket: "done" });
  await settleMicrotasks();

  // The first read settles while the second is still waiting. A boolean flag
  // would report the channel as idle here, and the Tasks screen would drop its
  // spinner for a "nothing received yet" placeholder before the answer arrives.
  pendingRead(pending, "queue").resolve(bucketSnapshot("queue"));
  await refreshing;

  const midFlight = sink.state();
  assert.equal(midFlight.agLoopReadsInFlight, 1, "the second read is still outstanding");
  assert.equal(presentTasks(midFlight).showLoadingPlaceholder, true);
  assert.equal(presentTasks(midFlight).showUnavailablePlaceholder, false);
  assert.equal(presentTasks(midFlight).connection.canRetry, false);

  pendingRead(pending, "done").resolve(bucketSnapshot("done"));
  await selecting;

  const settled = sink.state();
  assert.equal(settled.agLoopReadsInFlight, 0);
  assert.equal(presentTasks(settled).showLoadingPlaceholder, false);
  assert.deepEqual(settled.agLoopTaskBucket?.tasks, ["done-task.md"]);
});

test("the last bucket selection wins even when an earlier read answers after it", async () => {
  const { port, pending } = gatedBucketPort();
  const sink = recorder();
  const controller = new AgLoopReadController(port, sink.dispatch);

  const first = controller.selectBucket({ projectId, bucket: "error" });
  await settleMicrotasks();
  const errorRead = pendingRead(pending, "error");

  const second = controller.selectBucket({ projectId, bucket: "failed" });
  await settleMicrotasks();
  const failedRead = pendingRead(pending, "failed");

  failedRead.resolve(bucketSnapshot("failed"));
  await second;
  // The abandoned `error` read answers last and must not clobber the screen.
  errorRead.resolve(bucketSnapshot("error"));
  await first;

  const state = sink.state();
  assert.equal(state.agLoopSelectedBucket, "failed");
  assert.deepEqual(state.agLoopTaskBucket?.tasks, ["failed-task.md"]);
  assert.deepEqual(port.bucketCalls, ["error", "failed"], "each selection reads exactly its own bucket");
});

test("the read port exposes no mutating method", () => {
  const port: AgLoopUiReadPort = new FakeReadPort(
    async () => dashboard(),
    async (bucket) => bucketSnapshot(bucket),
  );
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(port) as object)
    .filter((name) => name !== "constructor");

  assert.deepEqual(surface.sort(), ["readDashboard", "readTaskBucket"]);
});
