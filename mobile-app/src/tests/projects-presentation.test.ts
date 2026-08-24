import assert from "node:assert/strict";
import test from "node:test";

import { presentProjects } from "../controller/presentation/projects-presenter.js";
import { maxListedProjects, type ProjectSummary } from "../model/projects-read.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";

const alpha = "8f1c2b6a-0f2e-4c53-9d64-1f4a7f0c8d21";
const beta = "1b7d3f90-5a44-4f2d-9c11-2e6b8a5c7d33";

function project(projectId: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return Object.freeze({
    projectId,
    name: "widgets",
    repository: "acme/widgets",
    branch: "main",
    agLoopUi: "online" as const,
    ...overrides,
  });
}

function apply(events: readonly AppEvent[]): AppState {
  return events.reduce(reduceAppState, initialAppState);
}

function view(events: readonly AppEvent[]) {
  return presentProjects(apply(events));
}

test("an unwired channel says so instead of blaming the network", () => {
  const state = view([]);

  assert.equal(state.connection.label, "Not configured");
  assert.equal(state.connection.canRetry, false);
  assert.equal(state.showUnavailablePlaceholder, true);
  assert.equal(state.isEmpty, false, "nothing was received, so the registry is not known to be empty");
  assert.equal(state.repository.noSelection, true);
  assert.equal(state.repository.unavailableLabel, "Select a project to see its repository state.");
});

test("a read in flight shows the loading placeholder and offers no retry", () => {
  const state = view([{ type: "projects.read-started" }]);

  assert.equal(state.showLoadingPlaceholder, true);
  assert.equal(state.showUnavailablePlaceholder, false);
  assert.equal(state.connection.canRetry, false);
});

test("an offline registry keeps its placeholder and offers a retry", () => {
  const state = view([
    { type: "projects.read-started" },
    { type: "projects.read-failed", failure: "unavailable" },
    { type: "projects.read-settled" },
  ]);

  assert.equal(state.connection.link, "offline");
  assert.equal(state.connection.errorMessage, "The project registry is not reachable.");
  assert.equal(state.connection.canRetry, true);
  assert.equal(state.rows.length, 0);
  assert.equal(state.showUnavailablePlaceholder, true);
});

test("an unauthorized read asks for pairing and lists nothing", () => {
  const state = view([
    { type: "projects.read-started" },
    { type: "projects.read-failed", failure: "unauthorized" },
    { type: "projects.read-settled" },
  ]);

  assert.equal(state.connection.errorMessage, "Device pairing is required.");
  assert.equal(state.rows.length, 0);
  assert.equal(state.isEmpty, false);
});

test("an empty registry is worded as empty, not as unavailable", () => {
  const state = view([{ type: "projects.list", projects: [] }]);

  assert.equal(state.isEmpty, true);
  assert.equal(state.emptyLabel, "No project is registered on the host.");
  assert.equal(state.showUnavailablePlaceholder, false);
  assert.equal(state.showLoadingPlaceholder, false);
  assert.equal(state.totalCount, 0);
  assert.equal(state.hiddenCount, 0);
});

test("each project row carries its binding, branch and AG Loop UI state", () => {
  const state = view([
    {
      type: "projects.list",
      projects: [
        project(alpha),
        project(beta, { name: "gadgets", branch: "release", agLoopUi: "not_configured" }),
      ],
    },
    { type: "project.selected", projectId: beta },
  ]);

  assert.deepEqual(state.rows.map((row) => row.projectId), [alpha, beta]);
  assert.deepEqual(state.rows.map((row) => row.selected), [false, true]);
  assert.equal(state.rows[0]?.repositoryLabel, "acme/widgets");
  assert.equal(state.rows[0]?.branchLabel, "main");
  assert.equal(state.rows[0]?.agLoopUiLabel, "AG Loop UI online");
  assert.equal(state.rows[1]?.agLoopUiLabel, "AG Loop UI not configured");
  assert.equal(state.selectedProjectId, beta);
});

test("a project the host registered without a binding says so rather than rendering blank", () => {
  const state = view([{
    type: "projects.list",
    projects: [project(alpha, { repository: "", branch: "" })],
  }]);

  assert.equal(state.rows[0]?.repositoryLabel, "No repository bound");
  assert.equal(state.rows[0]?.branchLabel, "No branch reported");
});

test("every AG Loop UI state the contract declares is distinguishable on screen", () => {
  const labels = new Set<string>();
  for (const agLoopUi of ["online", "offline", "not_configured"] as const) {
    const state = view([{ type: "projects.list", projects: [project(alpha, { agLoopUi })] }]);
    assert.equal(state.rows[0]?.agLoopUi, agLoopUi);
    labels.add(state.rows[0]?.agLoopUiLabel ?? "");
  }
  assert.equal(labels.size, 3);
});

test("a capped list still reports how many projects the host named", () => {
  const many = Array.from(
    { length: maxListedProjects + 3 },
    (_unused, index) => project(`${index}`.padStart(8, "0")),
  );

  const state = view([{ type: "projects.list", projects: many }]);

  assert.equal(state.rows.length, maxListedProjects);
  assert.equal(state.totalCount, maxListedProjects + 3);
  assert.equal(state.hiddenCount, 3);
});

test("the repository pane reports the branch, the working tree and the divergence", () => {
  const state = view([
    { type: "projects.list", projects: [project(alpha)] },
    { type: "project.selected", projectId: alpha },
    {
      type: "projects.repository-status",
      projectId: alpha,
      status: Object.freeze({
        repository: "acme/widgets",
        branch: "feature/mobile",
        dirty: true,
        ahead: 2,
        behind: 1,
      }),
    },
  ]);

  assert.equal(state.repository.available, true);
  assert.equal(state.repository.noSelection, false);
  assert.equal(state.repository.repositoryLabel, "acme/widgets");
  assert.equal(state.repository.branchLabel, "feature/mobile");
  assert.equal(state.repository.dirtyLabel, "Uncommitted changes in the host checkout");
  assert.equal(state.repository.divergenceLabel, "2 ahead · 1 behind");
  assert.equal(state.repository.errorMessage, null);
});

test("a clean checkout in step with its remote is worded plainly", () => {
  const state = view([
    { type: "project.selected", projectId: alpha },
    {
      type: "projects.repository-status",
      projectId: alpha,
      status: Object.freeze({
        repository: "acme/widgets",
        branch: "main",
        dirty: false,
        ahead: 0,
        behind: 0,
      }),
    },
  ]);

  assert.equal(state.repository.dirtyLabel, "Working tree clean");
  assert.equal(state.repository.divergenceLabel, "In sync with the remote");
});

test("a project with no repository bound says so without degrading the registry", () => {
  const state = view([
    { type: "projects.list", projects: [project(alpha)] },
    { type: "project.selected", projectId: alpha },
    { type: "projects.repository-failed", projectId: alpha, failure: "repository_not_bound" },
  ]);

  assert.equal(state.repository.available, false);
  assert.equal(state.repository.errorMessage, "No repository is bound to this project.");
  assert.equal(state.repository.stale, false);
  assert.equal(state.connection.link, "connected");
  assert.equal(state.connection.errorMessage, null);
});

test("a binding the last read could not confirm stays on screen, marked stale", () => {
  const state = view([
    { type: "project.selected", projectId: alpha },
    {
      type: "projects.repository-status",
      projectId: alpha,
      status: Object.freeze({
        repository: "acme/widgets",
        branch: "main",
        dirty: false,
        ahead: 0,
        behind: 0,
      }),
    },
    { type: "projects.repository-failed", projectId: alpha, failure: "transport_failed" },
  ]);

  assert.equal(state.repository.available, true);
  assert.equal(state.repository.stale, true);
  assert.equal(state.repository.errorMessage, "The project read failed.");
});

test("a repository read shows no spinner over a list that failed to arrive", () => {
  const state = view([
    { type: "projects.read-started", scope: "list" },
    { type: "projects.read-failed", failure: "unauthorized" },
    { type: "projects.read-settled" },
    { type: "project.selected", projectId: alpha },
    { type: "projects.read-started", scope: "repository" },
  ]);

  assert.equal(state.showLoadingPlaceholder, false, "no listing is being read");
  assert.equal(state.showUnavailablePlaceholder, true);
  assert.equal(state.connection.errorMessage, "Device pairing is required.");
});

test("the Projects view state carries no mutation affordance at all", () => {
  const state = view([{ type: "projects.list", projects: [project(alpha)] }]);

  assert.equal(state.readOnly, true);
  // A host path would be the one thing a logical repository name must never
  // become; the registry projects a name, and the screen shows only that.
  assert.doesNotMatch(JSON.stringify(state), /[A-Za-z]:\\\\|\/home\/|\/Users\/|token|secret/i);
});
