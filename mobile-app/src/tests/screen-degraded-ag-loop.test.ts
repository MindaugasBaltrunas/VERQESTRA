import assert from "node:assert/strict";
import test from "node:test";

import { presentDashboard, presentTasks } from "../controller/presentation/ag-loop-presenter.js";
import type { AgLoopReadFailureCode } from "../model/ag-loop-read.js";
import type { SessionReviewFailureCode } from "../model/session-review-read.js";
import type { AppState } from "../model/state.js";
import {
  assertCoverage,
  assertReadOnlyFrame,
  bucketSnapshot,
  compose,
  dashboardFrame,
  dashboardSnapshot,
  forbiddenMutationKeys,
  reduce,
  reviewSnapshot,
  sessionId,
  sessionReviewFrame,
  tasksFrame,
  type Step,
} from "./screen-degraded-doubles.js";

/**
 * Cross-screen sweep over the states a screen reaches when the host is slow,
 * unreachable, or answering with less than it used to. Not a set of examples:
 * the situations are enumerated, and every frame each space renders in them has
 * to satisfy the same invariants.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas). Čia — AG LOOP ir SESIJOS PERŽIŪRA. Host'o sritys
 * (Connections, Projects) — `screen-degraded-host.test.ts`; terminalas —
 * `screen-degraded-terminal.test.ts`; bendri teiginiai — `screen-degraded-doubles.ts`.
 *
 * Du buvę defektai (task 122): `ag-loop.tasks` sėkmė nesutvarkydavo nei `agLoopLink`, nei
 * `agLoopReadError` — abu buvo bendri su Dashboard kanalu. Ištaisyta padalijant kanalus:
 * Tasks ekranas dabar turi savo `agLoopTasksLink`/`agLoopTasksReadError`
 * (`src/model/reducer.ts`, `src/model/state.ts`), o `presentTasks` (`ag-loop-presenter.ts`)
 * skaito iš jų, ne iš Dashboard laukų. Regresijos testai — žemiau, pažymėti "task 122".
 */

const agLoopFailures: readonly AgLoopReadFailureCode[] = [
  "unavailable",
  "unauthorized",
  "invalid_response",
  "transport_failed",
];

/** How much of the AG Loop channel had ever worked before things went wrong. */
const agLoopBases: readonly Step[] = [
  { name: "never read", events: [] },
  {
    name: "dashboard and bucket cached",
    events: [
      { type: "ag-loop.read-started" },
      { type: "ag-loop.dashboard", snapshot: dashboardSnapshot() },
      { type: "ag-loop.tasks", snapshot: bucketSnapshot() },
      { type: "ag-loop.read-settled" },
    ],
  },
  {
    name: "AG Loop itself reported offline",
    events: [
      { type: "ag-loop.read-started" },
      { type: "ag-loop.dashboard", snapshot: dashboardSnapshot({ availability: "offline" }) },
      { type: "ag-loop.read-settled" },
    ],
  },
  {
    // Reachable through `AgLoopReadController.selectBucket`, which reads a bucket
    // without touching the dashboard: opening Tasks first is enough.
    name: "bucket cached without a dashboard",
    events: [
      { type: "ag-loop.read-started" },
      { type: "ag-loop.tasks", snapshot: bucketSnapshot() },
      { type: "ag-loop.read-settled" },
    ],
  },
];

const agLoopFailureSteps: readonly Step[] = [
  { name: "no failure", events: [] },
  ...agLoopFailures.map((failure): Step => ({
    name: `after ${failure}`,
    events: [
      { type: "ag-loop.read-started" },
      { type: "ag-loop.read-failed", failure },
      { type: "ag-loop.read-settled" },
    ],
  })),
];

/** What the channel is doing at the moment the frame is rendered. */
const agLoopTails: readonly Step[] = [
  { name: "idle", events: [] },
  { name: "retry in flight", events: [{ type: "ag-loop.read-started" }] },
  {
    name: "failing read not settled yet",
    events: [
      { type: "ag-loop.read-started" },
      { type: "ag-loop.read-failed", failure: "transport_failed" },
    ],
  },
  {
    name: "unreachable read not settled yet",
    events: [
      { type: "ag-loop.read-started" },
      { type: "ag-loop.read-failed", failure: "unavailable" },
    ],
  },
  {
    // A read that settles with neither a snapshot nor a failure: the reducer
    // drops a late bucket answer for a bucket the operator already left.
    name: "read settled without a result",
    events: [
      { type: "ag-loop.read-started" },
      { type: "ag-loop.read-settled" },
    ],
  },
];

function agLoopCombination(state: AppState): string {
  return [
    state.agLoopLink,
    state.agLoopDashboard === null ? "no-snapshot" : "cached",
    state.agLoopReadsInFlight > 0 ? "reading" : "not-reading",
  ].join("/");
}

test("every AG Loop degraded frame explains itself, dates itself and keeps a way back", () => {
  const combinations = new Set<string>();
  let frames = 0;

  for (const base of agLoopBases) {
    for (const failure of agLoopFailureSteps) {
      for (const tail of agLoopTails) {
        const situation = compose(base, failure, tail);
        combinations.add(agLoopCombination(situation.state));
        assertReadOnlyFrame(dashboardFrame(situation));
        assertReadOnlyFrame(tasksFrame(situation));
        frames += 2;
      }
    }
  }

  assert.equal(frames, agLoopBases.length * agLoopFailureSteps.length * agLoopTails.length * 2);
  // task 122: `agLoopLink` can no longer be `connecting` while no read is in
  // flight — `ag-loop.read-settled` now resolves a channel still `connecting`
  // to `offline` once the last outstanding read of a cycle drains to zero (see
  // `src/model/reducer.ts`), which is exactly the fix for the spinner that used
  // to outlive its read. `connecting` therefore now implies a read in flight,
  // for this channel, with or without a cached snapshot — both combinations
  // below are provably unreachable now, not merely unobserved.
  assertCoverage(combinations, "AG Loop", {
    skip: ["connecting/no-snapshot/not-reading", "connecting/cached/not-reading"],
  });
});

const sessionReviewFailures: readonly SessionReviewFailureCode[] = [
  "not_found",
  "unavailable",
  "unauthorized",
  "invalid_response",
  "transport_failed",
];

const sessionReviewBases: readonly Step[] = [
  { name: "no session selected", events: [] },
  { name: "session selected, never read", events: [{ type: "session-review.selected", sessionId }] },
  {
    name: "review cached",
    events: [
      { type: "session-review.selected", sessionId },
      { type: "session-review.read-started" },
      { type: "session-review.snapshot", snapshot: reviewSnapshot() },
      { type: "session-review.read-settled" },
    ],
  },
];

const sessionReviewFailureSteps: readonly Step[] = [
  { name: "no failure", events: [] },
  ...sessionReviewFailures.map((failure): Step => ({
    name: `after ${failure}`,
    events: [
      { type: "session-review.read-started" },
      { type: "session-review.read-failed", failure },
      { type: "session-review.read-settled" },
    ],
  })),
];

const sessionReviewTails: readonly Step[] = [
  { name: "idle", events: [] },
  { name: "retry in flight", events: [{ type: "session-review.read-started" }] },
  {
    name: "failing read not settled yet",
    events: [
      { type: "session-review.read-started" },
      { type: "session-review.read-failed", failure: "transport_failed" },
    ],
  },
  {
    name: "missing review read not settled yet",
    events: [
      { type: "session-review.read-started" },
      { type: "session-review.read-failed", failure: "not_found" },
    ],
  },
  {
    name: "read settled without a result",
    events: [
      { type: "session-review.read-started" },
      { type: "session-review.read-settled" },
    ],
  },
];

function sessionReviewCombination(state: AppState): string {
  return [
    state.sessionReviewLink,
    state.sessionReview === null ? "no-snapshot" : "cached",
    state.sessionReviewReadsInFlight > 0 ? "reading" : "not-reading",
  ].join("/");
}

test("every Session review degraded frame explains itself, dates itself and keeps a way back", () => {
  const combinations = new Set<string>();
  let frames = 0;

  for (const base of sessionReviewBases) {
    for (const failure of sessionReviewFailureSteps) {
      for (const tail of sessionReviewTails) {
        const situation = compose(base, failure, tail);
        combinations.add(sessionReviewCombination(situation.state));
        assertReadOnlyFrame(sessionReviewFrame(situation));
        frames += 1;
      }
    }
  }

  assert.equal(
    frames,
    sessionReviewBases.length * sessionReviewFailureSteps.length * sessionReviewTails.length,
  );
  assertCoverage(combinations, "Session review");
});

test("a degraded read-only space grows no affordance it lacks when healthy", () => {
  // The happy-path check on the Dashboard already exists; the point here is that
  // *losing* the host is not what puts a write path on a read-only screen. Every
  // failure code is walked over every cache state, on all three spaces.
  let checked = 0;
  for (const failure of agLoopFailures) {
    for (const base of agLoopBases) {
      const situation = compose(base, {
        name: `after ${failure}`,
        events: [
          { type: "ag-loop.read-started" },
          { type: "ag-loop.read-failed", failure },
          { type: "ag-loop.read-settled" },
        ],
      });
      for (const frame of [dashboardFrame(situation), tasksFrame(situation)]) {
        assert.equal(frame.readOnly, true, `${frame.screen} — ${frame.situation}`);
        const serialized = JSON.stringify(frame.view);
        for (const forbidden of forbiddenMutationKeys) {
          assert.ok(
            !serialized.includes(forbidden),
            `${frame.screen} leaks ${forbidden} while degraded`,
          );
        }
        checked += 1;
      }
    }
  }
  for (const failure of sessionReviewFailures) {
    for (const base of sessionReviewBases) {
      const situation = compose(base, {
        name: `after ${failure}`,
        events: [
          { type: "session-review.read-started" },
          { type: "session-review.read-failed", failure },
          { type: "session-review.read-settled" },
        ],
      });
      const frame = sessionReviewFrame(situation);
      assert.equal(frame.readOnly, true, `${frame.screen} — ${frame.situation}`);
      const serialized = JSON.stringify(frame.view);
      // A review offers no merge and no re-run even after the read that produced
      // it failed on the next refresh.
      for (const forbidden of [...forbiddenMutationKeys, "merge", "approve", "rerun"]) {
        assert.ok(
          !serialized.includes(forbidden),
          `${frame.screen} leaks ${forbidden} while degraded`,
        );
      }
      checked += 1;
    }
  }
  assert.equal(
    checked,
    agLoopFailures.length * agLoopBases.length * 2 +
      sessionReviewFailures.length * sessionReviewBases.length,
  );
});

/**
 * task 122, defect 1/2: a bucket read used to leave the Tasks badge dialling
 * forever (`ag-loop.tasks` never resolved `agLoopLink`) and, once a later
 * read failed, never marked the cached rows stale (staleness was keyed to the
 * dashboard snapshot, which a bucket-only session never has). Fixed by giving
 * Tasks its own `agLoopTasksLink`/`agLoopTasksReadError`, settled by its own
 * success and failure — see `ag-loop.tasks` and `ag-loop.read-failed` in
 * `src/model/reducer.ts`.
 */
test("a bucket read confirms its own channel, independent of the dashboard", () => {
  // `AgLoopReadController.selectBucket` reads a bucket without a dashboard, so
  // this is the state of a session that opened Tasks first.
  const bucketOnly = reduce([
    { type: "ag-loop.read-started" },
    { type: "ag-loop.tasks", snapshot: bucketSnapshot() },
    { type: "ag-loop.read-settled" },
  ]);
  const fresh = presentTasks(bucketOnly);
  assert.deepEqual(fresh.rows, ["0042-do-a-thing.md", "0043-do-another-thing.md"]);
  assert.equal(fresh.showUnavailablePlaceholder, false);
  // The bucket read itself proves the channel is reachable: no read is
  // running and the badge must not be left dialling.
  assert.equal(fresh.connection.link, "connected");
  assert.equal(fresh.connection.label, "Connected");
  assert.equal(fresh.connection.refreshing, false);
  assert.equal(fresh.connection.stale, false);

  const failedRefresh = reduce([
    { type: "ag-loop.read-started" },
    { type: "ag-loop.tasks", snapshot: bucketSnapshot() },
    { type: "ag-loop.read-settled" },
    { type: "ag-loop.read-started" },
    { type: "ag-loop.read-failed", failure: "transport_failed" },
    { type: "ag-loop.read-settled" },
  ]);
  const stale = presentTasks(failedRefresh);
  assert.deepEqual(stale.rows, ["0042-do-a-thing.md", "0043-do-another-thing.md"]);
  assert.equal(stale.connection.errorMessage, "AG Loop read channel failed.");
  assert.equal(stale.connection.canRetry, true, "the operator can at least retry");
  // The rows on screen are cached and this read's failure is charged to the
  // bucket channel, so they must now read as unconfirmed.
  assert.equal(stale.connection.stale, true, "cached bucket rows are unconfirmed after the failure");
});

/**
 * task 122, defect 1/2 (Dashboard side): a bucket-only session used to leave
 * `agLoopLink` stuck at `connecting` forever, because nothing in that cycle
 * ever resolved the dashboard channel. Fixed in `ag-loop.read-settled`: once
 * the last outstanding read of a cycle drains to zero, a channel still stuck
 * at `connecting` falls back to `offline` — see `src/model/reducer.ts`.
 */
test("a bucket-only session leaves the Dashboard honestly unread, not spinning forever", () => {
  const bucketOnly = reduce([
    { type: "ag-loop.read-started" },
    { type: "ag-loop.tasks", snapshot: bucketSnapshot() },
    { type: "ag-loop.read-settled" },
  ]);
  const view = presentDashboard(bucketOnly);

  assert.equal(bucketOnly.agLoopReadsInFlight, 0, "no read is running");
  assert.equal(view.showLoadingPlaceholder, false, "nothing is loading once the read settles");
  assert.equal(view.connection.refreshing, false);
  assert.equal(view.showUnavailablePlaceholder, true, "the dashboard channel itself was never read");
  // The dashboard channel was never attempted in this session, so it reads as
  // unconfigured rather than as a network failure — the same rule the very
  // first frame of the app already gets, in "an unwired read channel is
  // presented as not configured, not as a network failure" above.
  assert.equal(view.connection.label, "Not configured");
  assert.equal(view.connection.canRetry, false);
});
