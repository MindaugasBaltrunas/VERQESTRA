import assert from "node:assert/strict";

import { presentDashboard, presentTasks } from "../controller/presentation/ag-loop-presenter.js";
import { presentConnections } from "../controller/presentation/connections-presenter.js";
import { presentProjects } from "../controller/presentation/projects-presenter.js";
import { presentSessionReview } from "../controller/presentation/session-review-presenter.js";
import type {
  AgLoopDashboardSnapshot,
  AgLoopTaskBucketSnapshot,
} from "../model/ag-loop-read.js";
import type { HostConnectionsSnapshot } from "../model/connections-read.js";
import type { ProjectRepositoryStatus, ProjectSummary } from "../model/projects-read.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import type { SessionReviewSnapshot } from "../model/session-review-read.js";
import { initialAppState, type AppState } from "../model/state.js";

/**
 * Shared fixture for the degraded-screen sweeps.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `screen-degraded-states.test.ts` buvo 1 245
 * eilutės). Fikstūra atskirai, nes `assertReadOnlyFrame` yra VIENINTELIS apibrėžimas, ką
 * pažada read-only ekranas — trys kopijos leistų vienai nepastebimai nutolti, ir sritis,
 * kurios kopija atsiliko, praeitų su pažeidimu.
 */

export const projectId = "123e4567-e89b-42d3-a456-426614174090";
export const sessionId = "0f0a9b2c-1d3e-4f50-8a61-72b3c4d5e6f7";
const sourceCommit = "1f2e3d4c5b6a79880011223344556677889900aa";
const diffDigest = "sha256:8a1c0d5e7f6b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170615243342ab";

/**
 * Field names an AG Loop or session mutation would have to travel in. The
 * read-only spaces are checked against the serialised view state, not against
 * their types: a declared `readOnly: true` says what was intended, the
 * serialisation says what a screen could actually reach for. Kept in step with
 * `ag-loop-presentation.test.ts`, which checks the same list on the happy path.
 */
export const forbiddenMutationKeys: readonly string[] = [
  "loop_controls",
  "\"route\"",
  "endpoint",
  "method",
  "command",
  "actions",
  "root",
];

export function reduce(events: readonly AppEvent[]): AppState {
  return events.reduce(reduceAppState, initialAppState);
}

export function dashboardSnapshot(
  overrides: Partial<AgLoopDashboardSnapshot> = {},
): AgLoopDashboardSnapshot {
  return Object.freeze({
    availability: "online",
    currentTask: Object.freeze({ id: "0042-do-a-thing", state: "active" }),
    queueCounts: Object.freeze({ queue: 3, "human-review": 1, done: 12 }),
    runtime: Object.freeze([Object.freeze({ name: "orchestrator", status: "running" as const })]),
    reviewCount: 2,
    updatedAt: "2026-08-10T10:00:00.000Z",
    ...overrides,
  });
}

export function bucketSnapshot(): AgLoopTaskBucketSnapshot {
  return Object.freeze({
    bucket: "queue",
    tasks: Object.freeze(["0042-do-a-thing.md", "0043-do-another-thing.md"]),
    totalCount: 3,
  });
}

export function reviewSnapshot(): SessionReviewSnapshot {
  return Object.freeze({
    sessionId,
    sessionEnded: true,
    git: Object.freeze({
      sourceBranch: "ag/session-0f0a9b2c",
      sourceCommit,
      targetBranch: "master",
      targetHead: "aabbccddeeff00112233445566778899aabbccdd",
      targetClean: true,
    }),
    changedFiles: Object.freeze({
      paths: Object.freeze(["src/model/state.ts"]),
      totalCount: 1,
    }),
    diff: Object.freeze({
      files: Object.freeze([Object.freeze({
        path: "src/model/state.ts",
        change: "modified" as const,
        binary: false,
        hunks: Object.freeze([Object.freeze({
          header: "@@ src/model/state.ts @@",
          lines: Object.freeze([
            Object.freeze({ kind: "added" as const, text: "const answer = 42;" }),
            Object.freeze({ kind: "removed" as const, text: "const answer = 41;" }),
          ]),
        })]),
        hiddenHunkCount: 0,
      })]),
      totalFileCount: 1,
      addedLineCount: 1,
      removedLineCount: 1,
      truncated: false,
      truncationReason: null,
      digest: diffDigest,
    }),
    gates: null,
    audit: null,
    observedAt: "2026-08-10T10:00:00.000Z",
  });
}

export function connectionsSnapshot(
  overrides: Partial<HostConnectionsSnapshot> = {},
): HostConnectionsSnapshot {
  return Object.freeze({
    agents: Object.freeze([
      Object.freeze({ provider: "claude-code" as const, status: "ready" as const, version: "1.2.3" }),
      Object.freeze({ provider: "codex" as const, status: "authentication_required" as const, version: null }),
    ]),
    github: Object.freeze({
      status: "connected" as const,
      account: "octocat",
      authorizationPending: false,
    }),
    ...overrides,
  });
}

export function projectSummary(): ProjectSummary {
  return Object.freeze({
    projectId,
    name: "widgets",
    repository: "acme/widgets",
    branch: "main",
    agLoopUi: "online" as const,
  });
}

export function repositoryStatus(): ProjectRepositoryStatus {
  return Object.freeze({
    repository: "acme/widgets",
    branch: "main",
    dirty: false,
    ahead: 0,
    behind: 0,
  });
}

export type Step = Readonly<{ name: string; events: readonly AppEvent[] }>;

export type Situation = Readonly<{ name: string; state: AppState }>;

export function compose(...steps: readonly Step[]): Situation {
  return {
    name: steps.map((step) => step.name).join(" · "),
    state: reduce(steps.flatMap((step) => [...step.events])),
  };
}

/**
 * One frame of a read-only space, in the terms all three of them share. They
 * present different payloads but make the same four promises, so they are
 * checked by one function rather than by three that could drift apart.
 */
export type ReadOnlyFrame = Readonly<{
  screen: string;
  situation: string;
  connection: Readonly<{
    label: string;
    refreshing: boolean;
    stale: boolean;
    errorMessage: string | null;
    canRetry: boolean;
  }>;
  readOnly: true;
  showLoadingPlaceholder: boolean;
  showUnavailablePlaceholder: boolean;
  unavailableLabel: string;
  /** A snapshot is being rendered in this frame. */
  hasContent: boolean;
  /**
   * Whether the snapshot the *connection badge* speaks for exists — the
   * dashboard snapshot on Dashboard, the bucket snapshot on Tasks (see
   * `agLoopTasksLink`/`agLoopTasksReadError` in `src/model/state.ts`), matching
   * whichever fields `presentConnection` was actually fed for that screen.
   */
  badgeSnapshot: boolean;
  /** A read failure is recorded on this screen's channel. */
  failed: boolean;
  view: object;
}>;

export function assertReadOnlyFrame(frame: ReadOnlyFrame): void {
  const label = `${frame.screen} — ${frame.situation}`;

  // 1. A screen is never blank without saying why, and never says two things at
  //    once: exactly one of "here is the data", "still loading" and "nothing to
  //    show" holds in every frame.
  const shown = [
    frame.hasContent,
    frame.showLoadingPlaceholder,
    frame.showUnavailablePlaceholder,
  ].filter((flag) => flag).length;
  assert.equal(shown, 1, `content, loading and unavailable must be exclusive: ${label}`);
  if (frame.showUnavailablePlaceholder) {
    assert.ok(frame.unavailableLabel.trim().length > 0, `an empty screen must say why: ${label}`);
  }
  assert.ok(
    frame.connection.label.trim().length > 0,
    `the link badge must read as something: ${label}`,
  );

  // 2. Degraded and offline never lie about freshness: what is on screen is
  //    marked stale exactly when a failure left it unconfirmed, and a screen
  //    with nothing cached has nothing that could have gone stale.
  assert.equal(
    frame.connection.stale,
    frame.badgeSnapshot && frame.failed,
    `staleness must follow "cached snapshot + recorded failure": ${label}`,
  );
  if (frame.connection.stale) {
    assert.notEqual(frame.connection.errorMessage, null, `stale without a reason: ${label}`);
  }
  if (!frame.badgeSnapshot) {
    assert.equal(frame.connection.stale, false, `nothing cached can be stale: ${label}`);
  }

  // 3. Every error has a way back: either the retry is offered, or a read is
  //    already running. A frame with neither is a dead end on a phone.
  assert.equal(
    frame.connection.errorMessage !== null,
    frame.failed,
    `a recorded failure must be worded, and only a recorded one: ${label}`,
  );
  if (frame.connection.errorMessage !== null) {
    assert.ok(
      frame.connection.canRetry || frame.connection.refreshing,
      `an error with neither a retry nor a read in flight: ${label}`,
    );
  }

  // 4. Being degraded never opens a door that is closed when healthy.
  assert.equal(frame.readOnly, true, `read-only is structural: ${label}`);
  const serialized = JSON.stringify(frame.view);
  for (const forbidden of forbiddenMutationKeys) {
    assert.ok(!serialized.includes(forbidden), `${label} leaks ${forbidden}`);
  }

  // 5. Nothing a screen was handed can be edited under it.
  assert.ok(Object.isFrozen(frame.view), `view state is mutable: ${label}`);
  assert.ok(Object.isFrozen(frame.connection), `connection view state is mutable: ${label}`);
}

export function dashboardFrame(situation: Situation): ReadOnlyFrame {
  const view = presentDashboard(situation.state);
  return {
    screen: "Dashboard",
    situation: situation.name,
    connection: view.connection,
    readOnly: view.readOnly,
    showLoadingPlaceholder: view.showLoadingPlaceholder,
    showUnavailablePlaceholder: view.showUnavailablePlaceholder,
    unavailableLabel: view.unavailableLabel,
    hasContent: situation.state.agLoopDashboard !== null,
    badgeSnapshot: situation.state.agLoopDashboard !== null,
    failed: situation.state.agLoopReadError !== null,
    view,
  };
}

export function tasksFrame(situation: Situation): ReadOnlyFrame {
  const view = presentTasks(situation.state);
  return {
    screen: "Tasks",
    situation: situation.name,
    connection: view.connection,
    readOnly: view.readOnly,
    showLoadingPlaceholder: view.showLoadingPlaceholder,
    showUnavailablePlaceholder: view.showUnavailablePlaceholder,
    unavailableLabel: view.unavailableLabel,
    hasContent: situation.state.agLoopTaskBucket !== null,
    // The Tasks badge speaks for the bucket channel, not the dashboard one:
    // `agLoopTasksLink`/`agLoopTasksReadError` settle independently of
    // `agLoopLink`/`agLoopReadError`, so the badge this frame checks must be
    // read from the same fields `presentTasks` actually renders from.
    badgeSnapshot: situation.state.agLoopTaskBucket !== null,
    failed: situation.state.agLoopTasksReadError !== null,
    view,
  };
}

export function sessionReviewFrame(situation: Situation): ReadOnlyFrame {
  const view = presentSessionReview(situation.state);
  return {
    screen: "Session review",
    situation: situation.name,
    connection: view.connection,
    readOnly: view.readOnly,
    showLoadingPlaceholder: view.showLoadingPlaceholder,
    showUnavailablePlaceholder: view.showUnavailablePlaceholder,
    unavailableLabel: view.unavailableLabel,
    hasContent: situation.state.sessionReview !== null,
    badgeSnapshot: situation.state.sessionReview !== null,
    failed: situation.state.sessionReviewError !== null,
    view,
  };
}

export function connectionsFrame(situation: Situation): ReadOnlyFrame {
  const view = presentConnections(situation.state);
  const answered = situation.state.agentConnections !== null ||
    situation.state.githubConnection !== null;
  return {
    screen: "Connections",
    situation: situation.name,
    connection: view.connection,
    readOnly: view.readOnly,
    showLoadingPlaceholder: view.showLoadingPlaceholder,
    showUnavailablePlaceholder: view.showUnavailablePlaceholder,
    unavailableLabel: view.unavailableLabel,
    hasContent: answered,
    badgeSnapshot: answered,
    failed: situation.state.connectionsError !== null,
    view,
  };
}

/**
 * The Projects frame speaks for the registry listing alone. The repository pane
 * has its own state and its own failure, and it is checked separately in
 * `screen-degraded-host.test.ts`: folding it in here would let a bound
 * repository mask a listing that never arrived.
 */
export function projectsFrame(situation: Situation): ReadOnlyFrame {
  const view = presentProjects(situation.state);
  return {
    screen: "Projects",
    situation: situation.name,
    connection: view.connection,
    readOnly: view.readOnly,
    showLoadingPlaceholder: view.showLoadingPlaceholder,
    showUnavailablePlaceholder: view.showUnavailablePlaceholder,
    unavailableLabel: view.unavailableLabel,
    hasContent: situation.state.projects !== null,
    badgeSnapshot: situation.state.projects !== null,
    failed: situation.state.projectsError !== null,
    view,
  };
}

/** Every link/cache/in-flight combination each sweep must actually reach. */
export const requiredCombinations: readonly string[] = [
  "connecting/no-snapshot/reading",
  "connecting/no-snapshot/not-reading",
  "connecting/cached/reading",
  "connecting/cached/not-reading",
  "connected/cached/reading",
  "connected/cached/not-reading",
  "degraded/cached/reading",
  "degraded/cached/not-reading",
  "offline/no-snapshot/reading",
  "offline/no-snapshot/not-reading",
  "offline/cached/reading",
  "offline/cached/not-reading",
];

export function assertCoverage(
  combinations: ReadonlySet<string>,
  channel: string,
  options: Readonly<{ skip?: readonly string[] }> = {},
): void {
  const skip = new Set(options.skip ?? []);
  for (const required of requiredCombinations) {
    if (skip.has(required)) continue;
    assert.ok(combinations.has(required), `${channel}: the sweep never reached ${required}`);
  }
  // The two the Model must never produce: a link cannot claim to be connected,
  // or merely degraded, with nothing it has ever received.
  for (const observed of combinations) {
    if (!observed.includes("no-snapshot")) continue;
    assert.ok(
      !observed.startsWith("connected/") && !observed.startsWith("degraded/"),
      `${channel}: a link claimed ${observed} without ever having received a snapshot`,
    );
  }
}
