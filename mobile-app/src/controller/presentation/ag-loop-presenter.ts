import {
  agLoopTaskBuckets,
  type AgLoopLinkState,
  type AgLoopReadFailureCode,
  type AgLoopTaskBucket,
} from "../../model/ag-loop-read.js";
import type { AppState } from "../../model/state.js";
import type {
  AgLoopConnectionViewState,
  DashboardQueueRow,
  DashboardViewState,
  TasksViewState,
} from "../../view/ag-loop-view-state.js";

/**
 * Presentation for the read-only AG Loop spaces (Dashboard, Tasks).
 *
 * Everything the screens need is decided here, so the native views stay pure
 * renderers: labels, empty/loading/error placeholders and the reconnect badge
 * are computed from Model state alone, and no view state carries a write
 * affordance for AG Loop.
 *
 * The view-state types live in `view/ag-loop-view-state.ts` — see the NUKRYPIMAS
 * note there for why.
 */

const linkLabels: Readonly<Record<AgLoopLinkState, string>> = Object.freeze({
  connecting: "Connecting",
  connected: "Connected",
  degraded: "Reconnecting — last known state",
  offline: "Offline",
});

const failureMessages: Readonly<Record<AgLoopReadFailureCode, string>> = Object.freeze({
  unavailable: "AG Loop UI is not reachable.",
  unauthorized: "Device pairing is required.",
  invalid_response: "AG Loop response was rejected.",
  transport_failed: "AG Loop read channel failed.",
});

const bucketLabels: Readonly<Record<AgLoopTaskBucket, string>> = Object.freeze({
  "queue": "Queue",
  "active": "Active",
  "delegated": "Delegated",
  "human-review": "Human review",
  "error": "Error",
  "failed": "Failed",
  "done": "Done",
});

/**
 * NUKRYPIMAS (forma, ne elgesys): etalonas rašė `agLoopTaskBuckets.indexOf(bucket as
 * AgLoopTaskBucket)` ir `bucketLabels[bucket as AgLoopTaskBucket]`. `as` per šitą ribą yra
 * ne kontraktas, o prielaida: eilučių raktai ateina iš gateway'aus `queueCounts`, kurio
 * VERQESTRA netikrina prieš projekciją. Vietoj `as` — narystės patikra, kurios rezultatas
 * ir yra tipas; elgesys nepakito (nežinomas raktas ir anksčiau gaudavo `-1` bei save kaip
 * etiketę), bet dabar tai matoma kode, o ne tik `?? bucket` gale.
 */
function knownBucket(bucket: string): AgLoopTaskBucket | undefined {
  return agLoopTaskBuckets.find((candidate) => candidate === bucket);
}

function bucketRank(bucket: string): number {
  const known = knownBucket(bucket);
  return known === undefined ? agLoopTaskBuckets.length : agLoopTaskBuckets.indexOf(known);
}

function bucketLabel(bucket: string): string {
  const known = knownBucket(bucket);
  return known === undefined ? bucket : bucketLabels[known];
}

function isReading(state: AppState): boolean {
  return state.agLoopReadsInFlight > 0;
}

function presentConnection(state: AppState): AgLoopConnectionViewState {
  // Nothing has ever been attempted or answered, so an offline badge would
  // blame the network for a channel that was simply never wired up. A read in
  // flight or a recorded failure both mean the channel is configured.
  const unconfigured = state.agLoopAvailability === "not-configured" &&
    state.agLoopDashboard === null &&
    state.agLoopReadError === null &&
    state.agLoopLink !== "connecting";
  return Object.freeze({
    link: state.agLoopLink,
    label: unconfigured ? "Not configured" : linkLabels[state.agLoopLink],
    refreshing: isReading(state),
    // Staleness is "a snapshot is on screen that the last read did not confirm",
    // which holds for a degraded link and for an offline link that still has a
    // cached snapshot; a fresh snapshot reporting `offline` is not stale.
    stale: state.agLoopDashboard !== null && state.agLoopReadError !== null,
    errorMessage: state.agLoopReadError === null ? null : failureMessages[state.agLoopReadError],
    canRetry: !unconfigured && !isReading(state),
  });
}

function queueRows(counts: Readonly<Record<string, number>>): readonly DashboardQueueRow[] {
  return Object.freeze(
    Object.entries(counts)
      .map(([bucket, count]) => Object.freeze({ bucket, label: bucketLabel(bucket), count }))
      .sort((left, right) =>
        bucketRank(left.bucket) - bucketRank(right.bucket) || left.bucket.localeCompare(right.bucket)),
  );
}

export function presentDashboard(state: AppState): DashboardViewState {
  const dashboard = state.agLoopDashboard;
  const rows = dashboard ? queueRows(dashboard.queueCounts) : Object.freeze([]);
  const showLoadingPlaceholder = dashboard === null && state.agLoopLink === "connecting";
  return Object.freeze({
    title: "AG Loop UI — read-only",
    readOnly: true,
    connection: presentConnection(state),
    showLoadingPlaceholder,
    showUnavailablePlaceholder: dashboard === null && !showLoadingPlaceholder,
    unavailableLabel: "No AG Loop state has been received yet.",
    isEmpty: dashboard !== null &&
      dashboard.currentTask.id === null &&
      rows.every((row) => row.count === 0) &&
      dashboard.runtime.length === 0 &&
      dashboard.reviewCount === 0,
    currentTaskLabel: dashboard?.currentTask.id ?? "No active task",
    currentTaskState: dashboard?.currentTask.state ?? "none",
    queueRows: rows,
    runtimeRows: dashboard?.runtime ?? Object.freeze([]),
    reviewCount: dashboard?.reviewCount ?? 0,
    updatedAtLabel: dashboard?.updatedAt ?? null,
  });
}

export function presentTasks(state: AppState): TasksViewState {
  const counts = state.agLoopDashboard?.queueCounts;
  // The Model keeps `agLoopTaskBucket` and `agLoopSelectedBucket` in sync, so a
  // snapshot of another bucket can never reach this point.
  const snapshot = state.agLoopTaskBucket;
  const rows = snapshot?.tasks ?? Object.freeze([]);
  const totalCount = snapshot?.totalCount ?? 0;
  const showLoadingPlaceholder = snapshot === null &&
    (isReading(state) || state.agLoopLink === "connecting");
  return Object.freeze({
    title: "AG Loop tasks — read-only",
    readOnly: true,
    connection: presentConnection(state),
    tabs: Object.freeze(agLoopTaskBuckets.map((candidate) => Object.freeze({
      bucket: candidate,
      label: bucketLabels[candidate],
      selected: candidate === state.agLoopSelectedBucket,
      count: counts?.[candidate] ?? null,
    }))),
    selectedBucket: state.agLoopSelectedBucket,
    rows,
    totalCount,
    hiddenCount: Math.max(0, totalCount - rows.length),
    showLoadingPlaceholder,
    showUnavailablePlaceholder: snapshot === null && !showLoadingPlaceholder,
    unavailableLabel: "No task list has been received yet.",
    isEmpty: snapshot !== null && rows.length === 0,
    emptyLabel: `No tasks in ${bucketLabels[state.agLoopSelectedBucket]}`,
  });
}
