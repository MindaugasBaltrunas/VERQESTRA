import assert from "node:assert/strict";
import test from "node:test";

import { presentDashboard, presentTasks } from "../controller/presentation/ag-loop-presenter.js";
import { presentTerminal } from "../controller/presentation/terminal-presenter.js";
import type { AgLoopDashboardSnapshot } from "../model/ag-loop-read.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";

function dashboard(overrides: Partial<AgLoopDashboardSnapshot> = {}): AgLoopDashboardSnapshot {
  return Object.freeze({
    availability: "online",
    currentTask: Object.freeze({ id: "0042-do-a-thing", state: "active" }),
    queueCounts: Object.freeze({ done: 12, queue: 3, "human-review": 1 }),
    runtime: Object.freeze([Object.freeze({ name: "orchestrator", status: "running" as const })]),
    reviewCount: 2,
    updatedAt: "2026-08-10T10:00:00.000Z",
    ...overrides,
  });
}

function reduce(...events: readonly AppEvent[]): AppState {
  return events.reduce(reduceAppState, initialAppState);
}

test("an unwired read channel is presented as not configured, not as a network failure", () => {
  const view = presentDashboard(initialAppState);

  assert.equal(view.connection.label, "Not configured");
  assert.equal(view.connection.canRetry, false);
  assert.equal(view.connection.errorMessage, null);
  assert.equal(view.showLoadingPlaceholder, false);
  assert.equal(view.showUnavailablePlaceholder, true, "an empty screen must say why it is empty");
  assert.equal(view.currentTaskLabel, "No active task");

  const tasks = presentTasks(initialAppState);
  assert.equal(tasks.showLoadingPlaceholder, false);
  assert.equal(tasks.showUnavailablePlaceholder, true, "an unread bucket list is not silently blank");
  assert.equal(tasks.isEmpty, false, "an unread bucket is unknown, not empty");
});

test("an offline link with a cached snapshot keeps showing it, marked stale", () => {
  const view = presentDashboard(reduce(
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.read-failed", failure: "unavailable" },
    { type: "ag-loop.read-settled" },
  ));

  assert.equal(view.connection.link, "offline");
  assert.equal(view.connection.stale, true, "an unconfirmed cached snapshot must be marked stale");
  assert.equal(view.showUnavailablePlaceholder, false, "cached data is still rendered");
  assert.equal(view.currentTaskLabel, "0042-do-a-thing");
});

test("each reconnect state reaches the Dashboard with its own label", () => {
  const connecting = presentDashboard(reduce({ type: "ag-loop.read-started" }));
  assert.equal(connecting.connection.link, "connecting");
  assert.equal(connecting.connection.label, "Connecting");
  assert.equal(connecting.showLoadingPlaceholder, true, "a first read has nothing to show yet");
  assert.equal(connecting.connection.canRetry, false, "a read is already in flight");

  const connected = presentDashboard(reduce(
    { type: "ag-loop.read-started" },
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.read-settled" },
  ));
  assert.equal(connected.connection.link, "connected");
  assert.equal(connected.connection.label, "Connected");
  assert.equal(connected.connection.stale, false);
  assert.equal(connected.connection.canRetry, true);

  const degraded = presentDashboard(reduce(
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.read-failed", failure: "transport_failed" },
    { type: "ag-loop.read-settled" },
  ));
  assert.equal(degraded.connection.link, "degraded");
  assert.equal(degraded.connection.label, "Reconnecting — last known state");
  assert.equal(degraded.connection.stale, true, "cached data must be marked as stale");
  assert.equal(degraded.connection.errorMessage, "AG Loop read channel failed.");
  assert.equal(degraded.currentTaskLabel, "0042-do-a-thing", "the cached snapshot stays readable");

  const offline = presentDashboard(reduce(
    { type: "ag-loop.read-started" },
    { type: "ag-loop.read-failed", failure: "unavailable" },
    { type: "ag-loop.read-settled" },
  ));
  assert.equal(offline.connection.link, "offline");
  assert.equal(offline.connection.label, "Offline");
  assert.equal(offline.connection.stale, false);
  assert.equal(offline.connection.errorMessage, "AG Loop UI is not reachable.");
  assert.equal(offline.connection.canRetry, true, "the user may retry an offline link");
});

test("a first read that fails is reported as offline, not as an unwired channel", () => {
  // `unauthorized` leaves the last known availability at `not-configured`, so a
  // presenter that keyed on availability alone would tell the user the feature
  // was never set up instead of surfacing a pairing failure it can retry.
  const view = presentDashboard(reduce(
    { type: "ag-loop.read-started" },
    { type: "ag-loop.read-failed", failure: "unauthorized" },
    { type: "ag-loop.read-settled" },
  ));

  assert.equal(view.connection.link, "offline");
  assert.equal(view.connection.label, "Offline");
  assert.equal(view.connection.errorMessage, "Device pairing is required.");
  assert.equal(view.connection.canRetry, true);
  assert.equal(view.connection.stale, false, "there is no cached snapshot that could be stale");
  assert.equal(view.showUnavailablePlaceholder, true);
});

test("a retry in flight withdraws its own button without hiding the failure", () => {
  const view = presentDashboard(reduce(
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.read-failed", failure: "transport_failed" },
    { type: "ag-loop.read-settled" },
    { type: "ag-loop.read-started" },
  ));

  assert.equal(view.connection.refreshing, true);
  assert.equal(view.connection.canRetry, false, "a second retry must not be offered while one is in flight");
  assert.equal(view.connection.link, "degraded", "a retry must not flash a better link than the last result");
  assert.equal(view.connection.stale, true);
  assert.equal(view.connection.errorMessage, "AG Loop read channel failed.");
});

test("Dashboard orders queue rows by AG Loop bucket order and labels them", () => {
  const view = presentDashboard(reduce({ type: "ag-loop.dashboard", snapshot: dashboard() }));

  assert.deepEqual(view.queueRows.map((row) => row.bucket), ["queue", "human-review", "done"]);
  assert.deepEqual(view.queueRows.map((row) => row.label), ["Queue", "Human review", "Done"]);
  assert.equal(view.reviewCount, 2);
  assert.deepEqual(view.runtimeRows, [{ name: "orchestrator", status: "running" }]);
  assert.equal(view.updatedAtLabel, "2026-08-10T10:00:00.000Z");
  assert.equal(view.isEmpty, false);
});

test("an idle AG Loop is presented as empty rather than as missing data", () => {
  const view = presentDashboard(reduce({
    type: "ag-loop.dashboard",
    snapshot: dashboard({
      currentTask: Object.freeze({ id: null, state: "none" }),
      queueCounts: Object.freeze({ queue: 0 }),
      runtime: Object.freeze([]),
      reviewCount: 0,
    }),
  }));

  assert.equal(view.isEmpty, true);
  assert.equal(view.showLoadingPlaceholder, false);
  assert.equal(view.connection.link, "connected");
});

test("the Dashboard view state carries no AG Loop mutation affordance", () => {
  const view = presentDashboard(reduce({ type: "ag-loop.dashboard", snapshot: dashboard() }));

  assert.equal(view.readOnly, true);
  const serialized = JSON.stringify(view);
  for (const forbidden of ["loop_controls", "\"route\"", "endpoint", "method", "command", "actions", "root"]) {
    assert.ok(!serialized.includes(forbidden), `dashboard view state leaks ${forbidden}`);
  }
});

test("Tasks presents every bucket tab with its dashboard count", () => {
  const view = presentTasks(reduce(
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.tasks", snapshot: Object.freeze({
      bucket: "queue",
      tasks: Object.freeze(["0042-do-a-thing.md"]),
      totalCount: 3,
    }) },
  ));

  assert.deepEqual(
    view.tabs.map((tab) => tab.bucket),
    ["queue", "active", "delegated", "human-review", "error", "failed", "done"],
  );
  assert.deepEqual(view.tabs.filter((tab) => tab.selected).map((tab) => tab.bucket), ["queue"]);
  assert.equal(view.tabs[0]?.count, 3);
  assert.equal(view.tabs[1]?.count, null, "a bucket absent from the projection has no count");
  assert.deepEqual(view.rows, ["0042-do-a-thing.md"]);
  assert.equal(view.hiddenCount, 2, "the capped remainder must stay visible as a number");
  assert.equal(view.readOnly, true);
});

test("an empty bucket shows its own empty label, not a spinner", () => {
  const view = presentTasks(reduce(
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.bucket-selected", bucket: "error" },
    { type: "ag-loop.tasks", snapshot: Object.freeze({
      bucket: "error",
      tasks: Object.freeze([]),
      totalCount: 0,
    }) },
    { type: "ag-loop.read-settled" },
  ));

  assert.equal(view.isEmpty, true);
  assert.equal(view.showLoadingPlaceholder, false);
  assert.equal(view.emptyLabel, "No tasks in Error");
  assert.equal(view.rows.length, 0);
});

test("switching buckets shows a placeholder instead of the previous bucket's rows", () => {
  const view = presentTasks(reduce(
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.tasks", snapshot: Object.freeze({
      bucket: "queue",
      tasks: Object.freeze(["0042-do-a-thing.md"]),
      totalCount: 1,
    }) },
    { type: "ag-loop.bucket-selected", bucket: "done" },
    { type: "ag-loop.read-started" },
  ));

  assert.equal(view.selectedBucket, "done");
  assert.deepEqual(view.rows, []);
  assert.equal(view.showLoadingPlaceholder, true);
  assert.equal(view.isEmpty, false, "an unread bucket is unknown, not empty");
});

test("the Tasks screen chooses its placeholder from the link state too", () => {
  const connecting = presentTasks(reduce({ type: "ag-loop.read-started" }));
  assert.equal(connecting.connection.link, "connecting");
  assert.equal(connecting.connection.label, "Connecting");
  assert.equal(connecting.showLoadingPlaceholder, true);
  assert.equal(connecting.showUnavailablePlaceholder, false, "a read in flight is not an unavailable list");

  const offline = presentTasks(reduce(
    { type: "ag-loop.read-started" },
    { type: "ag-loop.read-failed", failure: "unavailable" },
    { type: "ag-loop.read-settled" },
  ));
  assert.equal(offline.connection.link, "offline");
  assert.equal(offline.connection.label, "Offline");
  assert.equal(offline.showLoadingPlaceholder, false, "an offline list must not spin forever");
  assert.equal(offline.showUnavailablePlaceholder, true);
  assert.equal(offline.isEmpty, false, "an unread bucket is unknown, not empty");
});

test("bucket tabs exist before the first dashboard read, without inventing counts", () => {
  const view = presentTasks(reduce({ type: "ag-loop.read-started" }));

  assert.equal(view.tabs.length, 7, "every AG Loop bucket is reachable from the first frame");
  assert.deepEqual(view.tabs.map((tab) => tab.count), [null, null, null, null, null, null, null]);
  assert.deepEqual(view.tabs.filter((tab) => tab.selected).map((tab) => tab.bucket), ["queue"]);
  assert.equal(view.totalCount, 0);
  assert.equal(view.hiddenCount, 0);
});

test("a bucket total below the listed rows never shows a negative remainder", () => {
  const view = presentTasks(reduce(
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.tasks", snapshot: Object.freeze({
      bucket: "queue",
      tasks: Object.freeze(["0042-do-a-thing.md", "0043-do-another.md"]),
      // A gateway total that lags behind the rows it just sent must not turn
      // into a "-1 more not shown" footer.
      totalCount: 1,
    }) },
  ));

  assert.equal(view.hiddenCount, 0);
  assert.deepEqual(view.rows, ["0042-do-a-thing.md", "0043-do-another.md"], "the sent rows stay listed");
});

test("the read-only spaces are labelled distinctly from the mobile terminal", () => {
  const dashboardView = presentDashboard(reduce({ type: "ag-loop.dashboard", snapshot: dashboard() }));
  const tasksView = presentTasks(reduce({ type: "ag-loop.dashboard", snapshot: dashboard() }));
  const terminalView = presentTerminal(initialAppState);

  assert.equal(dashboardView.title, "AG Loop UI — read-only");
  assert.equal(tasksView.title, "AG Loop tasks — read-only");
  assert.match(dashboardView.title, /read-only/);
  assert.match(tasksView.title, /read-only/);
  assert.doesNotMatch(terminalView.title, /read-only/i);

  // Every title is distinct, and the read-only titles carry "AG Loop" while the
  // terminal title never does — an operator scanning tab titles alone must be
  // able to tell which space can mutate anything.
  const titles = [dashboardView.title, tasksView.title, terminalView.title];
  assert.equal(new Set(titles).size, titles.length);
  assert.doesNotMatch(terminalView.title, /AG Loop/i);
});

test("a failed bucket read keeps the Tasks screen readable and retryable", () => {
  const view = presentTasks(reduce(
    { type: "ag-loop.dashboard", snapshot: dashboard() },
    { type: "ag-loop.tasks", snapshot: Object.freeze({
      bucket: "queue",
      tasks: Object.freeze(["0042-do-a-thing.md"]),
      totalCount: 1,
    }) },
    { type: "ag-loop.read-failed", failure: "unauthorized" },
    { type: "ag-loop.read-settled" },
  ));

  assert.equal(view.connection.link, "degraded");
  assert.equal(view.connection.errorMessage, "Device pairing is required.");
  assert.deepEqual(view.rows, ["0042-do-a-thing.md"]);
  assert.equal(view.connection.canRetry, true);
});
