import assert from "node:assert/strict";
import test from "node:test";

import { presentDashboard, presentTasks } from "../controller/presentation/ag-loop-presenter.js";
import type {
  AgLoopDashboardSnapshot,
  AgLoopTaskBucketSnapshot,
} from "../model/ag-loop-read.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";

function dashboard(overrides: Partial<AgLoopDashboardSnapshot> = {}): AgLoopDashboardSnapshot {
  return Object.freeze({
    availability: "online",
    currentTask: Object.freeze({ id: "0042-do-a-thing", state: "active" }),
    queueCounts: Object.freeze({ queue: 3, active: 1, done: 12 }),
    runtime: Object.freeze([Object.freeze({ name: "orchestrator", status: "running" as const })]),
    reviewCount: 2,
    updatedAt: "2026-08-10T10:00:00.000Z",
    ...overrides,
  });
}

function bucket(overrides: Partial<AgLoopTaskBucketSnapshot> = {}): AgLoopTaskBucketSnapshot {
  return Object.freeze({
    bucket: "queue",
    tasks: Object.freeze(["0042-do-a-thing.md", "0043-do-another.md"]),
    totalCount: 2,
    ...overrides,
  });
}

function reduce(state: AppState, ...events: readonly AppEvent[]): AppState {
  return events.reduce(reduceAppState, state);
}

test("first read reports connecting, then connected once AG Loop answers online", () => {
  const connecting = reduce(initialAppState, { type: "ag-loop.read-started" });
  assert.equal(connecting.agLoopLink, "connecting");
  assert.equal(connecting.agLoopReadsInFlight, 1);

  const connected = reduce(
    connecting,
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.read-settled" },
  );
  assert.equal(connected.agLoopLink, "connected");
  assert.equal(connected.agLoopAvailability, "online");
  assert.equal(connected.agLoopReadsInFlight, 0);
  assert.equal(connected.agLoopReadError, null);
});

test("an AG Loop UI that reports offline is offline, not degraded", () => {
  const state = reduce(initialAppState, {
    type: "ag-loop.dashboard",
    snapshot: dashboard({ availability: "offline" }),
  });

  assert.equal(state.agLoopLink, "offline");
  assert.equal(state.agLoopAvailability, "offline");
  // The projection stays readable so the user still sees the last known counts.
  assert.notEqual(state.agLoopDashboard, null);
});

test("a failed read degrades a link that still has a cached snapshot", () => {
  const connected = reduce(initialAppState, { type: "ag-loop.dashboard", snapshot: dashboard() });

  const degraded = reduce(connected, { type: "ag-loop.read-failed", failure: "transport_failed" });

  assert.equal(degraded.agLoopLink, "degraded");
  assert.equal(degraded.agLoopReadError, "transport_failed");
  assert.deepEqual(degraded.agLoopDashboard, connected.agLoopDashboard);
});

test("a failed read without any snapshot is offline", () => {
  const state = reduce(initialAppState, { type: "ag-loop.read-failed", failure: "unavailable" });

  assert.equal(state.agLoopLink, "offline");
  assert.equal(state.agLoopAvailability, "offline");
  assert.equal(state.agLoopDashboard, null);
});

test("a retry over a degraded link keeps showing the cached state", () => {
  const degraded = reduce(
    initialAppState,
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.read-failed", failure: "transport_failed" },
  );

  const retrying = reduce(degraded, { type: "ag-loop.read-started" });
  assert.equal(retrying.agLoopLink, "degraded", "a retry must not flash `connecting`");
  assert.equal(retrying.agLoopReadsInFlight, 1);
  assert.equal(retrying.agLoopReadError, "transport_failed", "the failure stays visible until it settles");

  const recovered = reduce(
    retrying,
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.read-settled" },
  );
  assert.equal(recovered.agLoopLink, "connected");
  assert.equal(recovered.agLoopReadError, null);
});

test("a failed retry never upgrades a link that AG Loop itself reported offline", () => {
  const offline = reduce(
    initialAppState,
    { type: "ag-loop.dashboard", snapshot: dashboard({ availability: "offline" }) },
    { type: "ag-loop.read-started" },
  );
  assert.equal(offline.agLoopLink, "connecting");

  const failed = reduce(offline, { type: "ag-loop.read-failed", failure: "transport_failed" });

  assert.equal(failed.agLoopLink, "offline", "a failure must not report a better link than before");
  assert.equal(failed.agLoopAvailability, "offline");
  assert.notEqual(failed.agLoopDashboard, null, "the cached snapshot stays readable");
});

test("an unreachable AG Loop UI is offline even when a snapshot is cached", () => {
  const state = reduce(
    initialAppState,
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.read-failed", failure: "unavailable" },
  );

  assert.equal(state.agLoopLink, "offline");
  assert.equal(state.agLoopAvailability, "offline");
});

test("a retry after an offline link reports connecting again", () => {
  const offline = reduce(initialAppState, { type: "ag-loop.read-failed", failure: "unavailable" });

  assert.equal(reduce(offline, { type: "ag-loop.read-started" }).agLoopLink, "connecting");
});

test("an availability report of offline keeps a later failure from looking degraded", () => {
  // The gateway may report AG Loop availability outside a snapshot read; once it
  // says offline, a failing read must not be softened to `degraded` merely
  // because a cached snapshot is still on screen.
  const state = reduce(
    initialAppState,
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.availability", availability: "offline" },
    { type: "ag-loop.read-failed", failure: "transport_failed" },
  );

  assert.equal(state.agLoopLink, "offline");
  assert.equal(state.agLoopAvailability, "offline");
  assert.notEqual(state.agLoopDashboard, null, "the cached snapshot stays readable");
});

test("settling a failed read clears the in-flight count only", () => {
  const failed = reduce(
    initialAppState,
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.read-started" },
    { type: "ag-loop.read-failed", failure: "invalid_response" },
  );

  const settled = reduce(failed, { type: "ag-loop.read-settled" });

  assert.equal(settled.agLoopReadsInFlight, 0);
  assert.equal(settled.agLoopReadError, "invalid_response", "settling is not a recovery");
  assert.equal(settled.agLoopLink, "degraded");
  assert.deepEqual(settled.agLoopDashboard, failed.agLoopDashboard);
});

test("an empty bucket response is accepted as data, not as a failure", () => {
  const state = reduce(
    initialAppState,
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.tasks", snapshot: bucket({ tasks: Object.freeze([]), totalCount: 0 }) },
  );

  assert.equal(state.agLoopLink, "connected");
  assert.equal(state.agLoopReadError, null);
  assert.deepEqual(state.agLoopTaskBucket?.tasks, []);
});

test("selecting another bucket drops the previous rows", () => {
  const loaded = reduce(
    initialAppState,
    { type: "ag-loop.tasks", snapshot: bucket() },
  );
  assert.equal(loaded.agLoopSelectedBucket, "queue");

  const switched = reduce(loaded, { type: "ag-loop.bucket-selected", bucket: "human-review" });
  assert.equal(switched.agLoopSelectedBucket, "human-review");
  assert.equal(switched.agLoopTaskBucket, null);

  // Re-selecting the current bucket is a no-op and keeps the loaded rows.
  const reselected = reduce(loaded, { type: "ag-loop.bucket-selected", bucket: "queue" });
  assert.equal(reselected, loaded);
});

test("a late snapshot of an abandoned bucket never replaces the selected bucket", () => {
  const switched = reduce(
    initialAppState,
    { type: "ag-loop.tasks", snapshot: bucket() },
    { type: "ag-loop.bucket-selected", bucket: "done" },
  );

  // The in-flight `queue` read answers after the user already moved on.
  const late = reduce(switched, { type: "ag-loop.tasks", snapshot: bucket() });

  assert.equal(late, switched, "a stale response must not change any state");
  assert.equal(late.agLoopSelectedBucket, "done");
  assert.equal(late.agLoopTaskBucket, null);
});

/**
 * task 122 regressions: the Dashboard and Tasks channels used to share
 * `agLoopLink`/`agLoopReadError`, so one channel's success could leave the
 * other's spinner running forever or silently launder its error. Both are
 * settled independently now via `agLoopTasksLink`/`agLoopTasksReadError`.
 */
test("task 122 (1/3): a dashboard failure does not stop a later bucket success from settling Tasks", () => {
  const dashboardFailed = reduce(
    initialAppState,
    { type: "ag-loop.read-started" },
    { type: "ag-loop.read-failed", failure: "transport_failed" },
    { type: "ag-loop.read-settled" },
  );
  assert.equal(dashboardFailed.agLoopLink, "offline");
  assert.equal(dashboardFailed.agLoopReadError, "transport_failed");

  const bucketRecovered = reduce(
    dashboardFailed,
    { type: "ag-loop.read-started" },
    { type: "ag-loop.tasks", snapshot: bucket() },
    { type: "ag-loop.read-settled" },
  );

  // The bucket channel confirms itself: no spinner, no leftover error.
  assert.equal(bucketRecovered.agLoopTasksLink, "connected");
  assert.equal(bucketRecovered.agLoopTasksReadError, null);
  assert.equal(presentTasks(bucketRecovered).connection.stale, false);
  // The dashboard channel's own failure is untouched by the bucket's success
  // — a bucket read proves nothing about a dashboard read that never happened.
  assert.equal(bucketRecovered.agLoopLink, "offline");
  assert.equal(bucketRecovered.agLoopReadError, "transport_failed");
});

test("task 122 (2/3): a dashboard success does not launder a live bucket failure", () => {
  const bucketCached = reduce(initialAppState, { type: "ag-loop.tasks", snapshot: bucket() });

  const bucketFailed = reduce(
    bucketCached,
    { type: "ag-loop.read-started" },
    { type: "ag-loop.read-failed", failure: "transport_failed" },
    { type: "ag-loop.read-settled" },
  );
  assert.equal(bucketFailed.agLoopTasksReadError, "transport_failed");

  const dashboardRecovered = reduce(
    bucketFailed,
    { type: "ag-loop.dashboard", snapshot: dashboard() },
  );

  // The dashboard's own success clears its own error, as always.
  assert.equal(dashboardRecovered.agLoopReadError, null);
  // But the bucket's own failure is still live: the cached rows are stale,
  // not silently confirmed by a read that never touched them.
  assert.equal(
    dashboardRecovered.agLoopTasksReadError,
    "transport_failed",
    "a dashboard success must not clear the bucket channel's own error",
  );
  assert.equal(presentTasks(dashboardRecovered).connection.stale, true);
});

test("task 122 (3/3): both channels answering leaves neither stale nor errored", () => {
  const both = reduce(
    initialAppState,
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.tasks", snapshot: bucket() },
  );

  assert.equal(both.agLoopReadError, null);
  assert.equal(both.agLoopTasksReadError, null);
  assert.equal(presentDashboard(both).connection.stale, false);
  assert.equal(presentTasks(both).connection.stale, false);
});

test("the AG Loop link is independent of the mobile terminal connection", () => {
  const state = reduce(
    initialAppState,
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "connection.changed", state: "reconnecting" },
    { type: "terminal.state", state: "failed" },
  );

  assert.equal(state.agLoopLink, "connected");
  assert.equal(state.connection, "reconnecting");
  assert.equal(state.terminalState, "failed");
});
