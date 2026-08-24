import assert from "node:assert/strict";
import test from "node:test";

import {
  clampProjectList,
  countDistinctProjects,
  maxListedProjects,
  type ProjectRepositoryStatus,
  type ProjectSummary,
} from "../model/projects-read.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";

const alpha = "8f1c2b6a-0f2e-4c53-9d64-1f4a7f0c8d21";
const beta = "1b7d3f90-5a44-4f2d-9c11-2e6b8a5c7d33";

function project(projectId: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return Object.freeze({
    projectId,
    name: `project-${projectId.slice(0, 4)}`,
    repository: "acme/widgets",
    branch: "main",
    agLoopUi: "online" as const,
    ...overrides,
  });
}

const repository: ProjectRepositoryStatus = Object.freeze({
  repository: "acme/widgets",
  branch: "feature/mobile",
  dirty: true,
  ahead: 2,
  behind: 1,
});

function apply(events: readonly AppEvent[], from: AppState = initialAppState): AppState {
  return events.reduce(reduceAppState, from);
}

test("an accepted list connects the channel and clears the previous failure", () => {
  const state = apply([
    { type: "projects.read-failed", failure: "transport_failed" },
    { type: "projects.list", projects: [project(alpha), project(beta)] },
  ]);

  assert.equal(state.projectsLink, "connected");
  assert.equal(state.projectsError, null);
  assert.equal(state.projects?.length, 2);
  assert.equal(state.projectsTotalCount, 2);
});

test("an empty registry is an answer, and is not read as a missing one", () => {
  const state = apply([{ type: "projects.list", projects: [] }]);

  assert.deepEqual(state.projects, []);
  assert.notEqual(state.projects, null);
  assert.equal(state.projectsTotalCount, 0);
  assert.equal(state.projectsLink, "connected");
});

test("a failure over a usable list degrades the link and keeps the list", () => {
  const state = apply([
    { type: "projects.list", projects: [project(alpha)] },
    { type: "projects.read-failed", failure: "unauthorized" },
  ]);

  assert.equal(state.projectsLink, "degraded");
  assert.equal(state.projectsError, "unauthorized");
  assert.equal(state.projects?.length, 1);
});

test("an unreachable registry is offline whether or not a list is on screen", () => {
  const withList = apply([
    { type: "projects.list", projects: [project(alpha)] },
    { type: "projects.read-failed", failure: "unavailable" },
  ]);
  const withoutList = apply([{ type: "projects.read-failed", failure: "unavailable" }]);

  assert.equal(withList.projectsLink, "offline");
  assert.equal(withoutList.projectsLink, "offline");
});

test("a duplicated project id yields one row and one count", () => {
  const duplicated = [project(alpha), project(alpha, { branch: "other" }), project(beta)];

  assert.deepEqual(
    clampProjectList(duplicated).map((entry) => entry.projectId),
    [alpha, beta],
    "the first answer for an id wins",
  );
  assert.equal(countDistinctProjects(duplicated), 2);
});

test("an unbounded host answer is capped while the reported total sees past the cap", () => {
  const many = Array.from(
    { length: maxListedProjects + 5 },
    (_unused, index) => project(`${index}`.padStart(8, "0")),
  );

  const state = apply([{ type: "projects.list", projects: many }]);

  assert.equal(state.projects?.length, maxListedProjects);
  assert.equal(state.projectsTotalCount, maxListedProjects + 5);
});

test("a repository state answered for another project never lands on the open one", () => {
  const state = apply([
    { type: "project.selected", projectId: alpha },
    { type: "projects.repository-status", projectId: beta, status: repository },
  ]);

  assert.equal(state.projectRepository, null);
});

test("moving to another project drops the previous repository state", () => {
  const state = apply([
    { type: "project.selected", projectId: alpha },
    { type: "projects.repository-status", projectId: alpha, status: repository },
    { type: "project.selected", projectId: beta },
  ]);

  assert.equal(state.projectRepository, null, "one project's branch must not show under another");
  assert.equal(state.projectRepositoryError, null);
});

test("re-selecting the open project changes nothing at all", () => {
  // The Projects list hands the same id back whenever its open row is tapped.
  // Anything this event resets — the repository pane, and the live terminal
  // session with its transcript — would be lost to a stray tap.
  const opened = apply([
    { type: "project.selected", projectId: alpha },
    { type: "projects.repository-status", projectId: alpha, status: repository },
    { type: "terminal.state", state: "live" },
    { type: "terminal.output", lines: ["$ pnpm test", "ok"] },
  ]);

  const reselected = reduceAppState(opened, { type: "project.selected", projectId: alpha });

  assert.equal(reselected, opened, "re-selecting the open project must be a no-op");
  assert.deepEqual(reselected.projectRepository, repository);
  assert.equal(reselected.terminalState, "live");
  assert.deepEqual(reselected.terminalLines, ["$ pnpm test", "ok"]);
});

test("a repository read never dials the registry channel", () => {
  // The two reads share one in-flight counter but not one link: a repository
  // read dispatches no list result, so a link it moved to `connecting` would
  // stay there after it settled — an eternal spinner over the project list.
  const failedList = apply([
    { type: "projects.read-started", scope: "list" },
    { type: "projects.read-failed", failure: "unauthorized" },
    { type: "projects.read-settled" },
    { type: "project.selected", projectId: alpha },
  ]);
  assert.equal(failedList.projectsLink, "offline");

  const afterRepositoryRead = apply([
    { type: "projects.read-started", scope: "repository" },
    { type: "projects.repository-status", projectId: alpha, status: repository },
    { type: "projects.read-settled" },
  ], failedList);

  assert.equal(afterRepositoryRead.projectsLink, "offline", "the registry link is untouched");
  assert.equal(afterRepositoryRead.projectsError, "unauthorized", "the failure stays visible");
  assert.deepEqual(afterRepositoryRead.projectRepository, repository);
});

test("a repository state with no project selected is dropped", () => {
  const state = apply([
    { type: "projects.repository-status", projectId: alpha, status: repository },
  ]);

  assert.equal(state.selectedProjectId, null);
  assert.equal(state.projectRepository, null);
  assert.equal(state.projectRepositoryError, null);
});

test("a binding the host disproved is erased; one it merely failed to read is kept", () => {
  const opened: readonly AppEvent[] = [
    { type: "project.selected", projectId: alpha },
    { type: "projects.repository-status", projectId: alpha, status: repository },
  ];

  for (const failure of ["repository_not_bound", "not_found"] as const) {
    const state = apply([...opened, { type: "projects.repository-failed", projectId: alpha, failure }]);
    assert.equal(state.projectRepository, null, failure);
    assert.equal(state.projectRepositoryError, failure);
  }

  for (const failure of ["transport_failed", "unavailable", "invalid_response", "unauthorized"] as const) {
    const state = apply([...opened, { type: "projects.repository-failed", projectId: alpha, failure }]);
    assert.deepEqual(state.projectRepository, repository, failure);
    assert.equal(state.projectRepositoryError, failure);
  }
});

test("a repository failure for another project leaves the open pane untouched", () => {
  const state = apply([
    { type: "project.selected", projectId: alpha },
    { type: "projects.repository-status", projectId: alpha, status: repository },
    { type: "projects.repository-failed", projectId: beta, failure: "repository_not_bound" },
  ]);

  assert.deepEqual(state.projectRepository, repository);
  assert.equal(state.projectRepositoryError, null);
});

test("a repository failure is not a channel failure", () => {
  const state = apply([
    { type: "projects.list", projects: [project(alpha)] },
    { type: "project.selected", projectId: alpha },
    { type: "projects.repository-failed", projectId: alpha, failure: "repository_not_bound" },
  ]);

  assert.equal(state.projectsLink, "connected", "one project's binding must not sink the registry");
  assert.equal(state.projectsError, null);
});

test("unmatched settles never make a later read look permanently in flight", () => {
  const state = apply([{ type: "projects.read-settled" }, { type: "projects.read-settled" }]);

  assert.equal(state.projectsReadsInFlight, 0);
});
