import assert from "node:assert/strict";
import test from "node:test";

import { presentProjects } from "../controller/presentation/projects-presenter.js";
import { ProjectsController } from "../controller/projects-controller.js";
import {
  ProjectsReadError,
  type ProjectRepositoryStatus,
  type ProjectsReadPort,
  type ProjectSummary,
} from "../model/projects-read.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";

const alpha = "8f1c2b6a-0f2e-4c53-9d64-1f4a7f0c8d21";
const beta = "1b7d3f90-5a44-4f2d-9c11-2e6b8a5c7d33";

const projects: readonly ProjectSummary[] = Object.freeze([
  Object.freeze({
    projectId: alpha,
    name: "widgets",
    repository: "acme/widgets",
    branch: "main",
    agLoopUi: "online" as const,
  }),
]);

const repository: ProjectRepositoryStatus = Object.freeze({
  repository: "acme/widgets",
  branch: "main",
  dirty: false,
  ahead: 0,
  behind: 0,
});

class FakeProjectsPort implements ProjectsReadPort {
  readonly repositoryCalls: string[] = [];
  listCalls = 0;

  constructor(
    private readonly listResult: () => Promise<readonly ProjectSummary[]>,
    private readonly repositoryResult: (projectId: string) => Promise<ProjectRepositoryStatus>,
  ) {}

  async readProjects(): Promise<readonly ProjectSummary[]> {
    this.listCalls += 1;
    return this.listResult();
  }

  async readRepositoryStatus(input: Readonly<{ projectId: string }>): Promise<ProjectRepositoryStatus> {
    this.repositoryCalls.push(input.projectId);
    return this.repositoryResult(input.projectId);
  }
}

function healthyPort(): FakeProjectsPort {
  return new FakeProjectsPort(async () => projects, async () => repository);
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

test("a refresh without a selected project reads the registry only", async () => {
  const port = healthyPort();
  const sink = recorder();

  await new ProjectsController(port, sink.dispatch).refresh({ projectId: null });

  assert.deepEqual(sink.events.map((event) => event.type), [
    "projects.read-started",
    "projects.list",
    "projects.read-settled",
  ]);
  assert.deepEqual(port.repositoryCalls, []);
  assert.equal(sink.state().projectsLink, "connected");
});

test("a refresh with a selected project reads its repository state as well", async () => {
  const port = healthyPort();
  const sink = recorder();
  sink.dispatch({ type: "project.selected", projectId: alpha });

  await new ProjectsController(port, sink.dispatch).refresh({ projectId: alpha });

  assert.deepEqual(port.repositoryCalls, [alpha]);
  const state = sink.state();
  assert.deepEqual(state.projectRepository, repository);
  assert.equal(state.projectsReadsInFlight, 0, "both reads settled");
});

test("selecting a project opens it and reads only its repository state", async () => {
  const port = healthyPort();
  const sink = recorder();

  await new ProjectsController(port, sink.dispatch).selectProject({ projectId: beta });

  assert.deepEqual(sink.events.map((event) => event.type), [
    "project.selected",
    "projects.read-started",
    "projects.repository-status",
    "projects.read-settled",
  ]);
  assert.equal(port.listCalls, 0, "a selection must not re-read the registry");
  assert.equal(sink.state().selectedProjectId, beta);
});

test("refreshing an open project re-reads its binding without re-selecting it", async () => {
  const port = healthyPort();
  const sink = recorder();
  sink.dispatch({ type: "project.selected", projectId: alpha });

  await new ProjectsController(port, sink.dispatch).refreshRepository({ projectId: alpha });

  assert.deepEqual(sink.events.map((event) => event.type), [
    "project.selected",
    "projects.read-started",
    "projects.repository-status",
    "projects.read-settled",
  ]);
  assert.equal(port.listCalls, 0);
  assert.deepEqual(sink.state().projectRepository, repository);
});

test("a failed registry read still lets the selected project's binding through", async () => {
  const port = new FakeProjectsPort(
    async () => {
      throw new ProjectsReadError("transport_failed", "read failed");
    },
    async () => repository,
  );
  const sink = recorder();
  sink.dispatch({ type: "project.selected", projectId: alpha });

  await new ProjectsController(port, sink.dispatch).refresh({ projectId: alpha });

  const state = sink.state();
  assert.equal(state.projectsError, "transport_failed");
  assert.deepEqual(state.projectRepository, repository, "the binding the host did answer is shown");
});

test("a repository failure keeps its own wording and never sinks the registry", async () => {
  const port = new FakeProjectsPort(
    async () => projects,
    async () => {
      throw new ProjectsReadError("repository_not_bound", "no repository");
    },
  );
  const sink = recorder();
  sink.dispatch({ type: "project.selected", projectId: alpha });

  await new ProjectsController(port, sink.dispatch).refresh({ projectId: alpha });

  const view = presentProjects(sink.state());
  assert.equal(view.connection.link, "connected");
  assert.equal(view.connection.errorMessage, null);
  assert.equal(view.repository.errorMessage, "No repository is bound to this project.");
});

test("an unknown port rejection is classified as a transport failure", async () => {
  const port = new FakeProjectsPort(
    async () => {
      throw new TypeError("network request failed");
    },
    async () => {
      throw new TypeError("network request failed");
    },
  );
  const sink = recorder();
  sink.dispatch({ type: "project.selected", projectId: alpha });

  await new ProjectsController(port, sink.dispatch).refresh({ projectId: alpha });

  const state = sink.state();
  assert.equal(state.projectsError, "transport_failed");
  assert.equal(state.projectRepositoryError, "transport_failed");
});

test("a reconnect after a failure restores the connected registry", async () => {
  let healthy = false;
  const port = new FakeProjectsPort(
    async () => {
      if (!healthy) throw new ProjectsReadError("unavailable", "registry unreachable");
      return projects;
    },
    async () => repository,
  );
  const sink = recorder();
  const controller = new ProjectsController(port, sink.dispatch);

  await controller.refresh({ projectId: null });
  assert.equal(sink.state().projectsLink, "offline");

  healthy = true;
  await controller.refresh({ projectId: null });

  const state = sink.state();
  assert.equal(state.projectsLink, "connected");
  assert.equal(state.projectsError, null);
});

test("the controller and its port expose no way to change a project", () => {
  const port: ProjectsReadPort = healthyPort();
  const portSurface = Object.getOwnPropertyNames(Object.getPrototypeOf(port) as object)
    .filter((name) => name !== "constructor");
  const controllerSurface = Object.getOwnPropertyNames(ProjectsController.prototype as object)
    .filter((name) => name !== "constructor");

  assert.deepEqual(portSurface.sort(), ["readProjects", "readRepositoryStatus"]);
  // The whole runtime surface, `private` helpers included: TypeScript's `private`
  // is erased, so a mutating method would still be callable from JavaScript.
  assert.deepEqual(controllerSurface.sort(), [
    "readProjects",
    "refresh",
    "refreshRepository",
    "selectProject",
  ]);
});
