import assert from "node:assert/strict";
import test from "node:test";

import { presentConnections } from "../controller/presentation/connections-presenter.js";
import { presentProjects } from "../controller/presentation/projects-presenter.js";
import type { ConnectionsReadFailureCode } from "../model/connections-read.js";
import type { ProjectsReadFailureCode } from "../model/projects-read.js";
import type { AppState } from "../model/state.js";
import {
  assertCoverage,
  assertReadOnlyFrame,
  compose,
  connectionsFrame,
  connectionsSnapshot,
  projectId,
  projectsFrame,
  projectSummary,
  repositoryStatus,
  type Step,
} from "./screen-degraded-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; žr. `screen-degraded-doubles.ts`). Čia — HOST'O
 * sritys: Connections ir Projects. Jos laikomos kartu, nes abi skaito TĄ PATĮ host'ą ir abi
 * turi antrą, atskirą būseną šalia kanalo: Connections — provider'ių eilutes, Projects —
 * saugyklos polangį. Būtent tas antras sluoksnis ir yra vieta, kur kanalo gedimas gali
 * neteisėtai persimesti į turinį.
 */

const connectionsFailures: readonly ConnectionsReadFailureCode[] = [
  "unavailable",
  "unauthorized",
  "invalid_response",
  "transport_failed",
];

const connectionsBases: readonly Step[] = [
  { name: "never read", events: [] },
  {
    name: "providers and GitHub cached",
    events: [
      { type: "connections.read-started" },
      { type: "connections.snapshot", snapshot: connectionsSnapshot() },
      { type: "connections.read-settled" },
    ],
  },
  {
    name: "host answers about GitHub only",
    events: [
      { type: "connections.read-started" },
      { type: "connections.snapshot", snapshot: connectionsSnapshot({ agents: null }) },
      { type: "connections.read-settled" },
    ],
  },
  {
    name: "host answers with no provider at all",
    events: [
      { type: "connections.read-started" },
      { type: "connections.snapshot", snapshot: connectionsSnapshot({ agents: [], github: null }) },
      { type: "connections.read-settled" },
    ],
  },
];

const connectionsFailureSteps: readonly Step[] = [
  { name: "no failure", events: [] },
  ...connectionsFailures.map((failure): Step => ({
    name: `after ${failure}`,
    events: [
      { type: "connections.read-started" },
      { type: "connections.read-failed", failure },
      { type: "connections.read-settled" },
    ],
  })),
];

const connectionsTails: readonly Step[] = [
  { name: "idle", events: [] },
  { name: "retry in flight", events: [{ type: "connections.read-started" }] },
  {
    name: "failing read not settled yet",
    events: [
      { type: "connections.read-started" },
      { type: "connections.read-failed", failure: "transport_failed" },
    ],
  },
  {
    name: "unreachable read not settled yet",
    events: [
      { type: "connections.read-started" },
      { type: "connections.read-failed", failure: "unavailable" },
    ],
  },
  {
    name: "read settled without a result",
    events: [
      { type: "connections.read-started" },
      { type: "connections.read-settled" },
    ],
  },
];

function connectionsCombination(state: AppState): string {
  return [
    state.connectionsLink,
    state.agentConnections === null && state.githubConnection === null ? "no-snapshot" : "cached",
    state.connectionsReadsInFlight > 0 ? "reading" : "not-reading",
  ].join("/");
}

test("every Connections degraded frame explains itself, dates itself and keeps a way back", () => {
  const combinations = new Set<string>();
  let frames = 0;

  for (const base of connectionsBases) {
    for (const failure of connectionsFailureSteps) {
      for (const tail of connectionsTails) {
        const situation = compose(base, failure, tail);
        combinations.add(connectionsCombination(situation.state));
        assertReadOnlyFrame(connectionsFrame(situation));
        frames += 1;
      }
    }
  }

  assert.equal(
    frames,
    connectionsBases.length * connectionsFailureSteps.length * connectionsTails.length,
  );
  assertCoverage(combinations, "Connections");
});

test("a Connections frame never claims a provider state the host did not send", () => {
  for (const base of connectionsBases) {
    for (const failure of connectionsFailureSteps) {
      const situation = compose(base, failure);
      const view = presentConnections(situation.state);
      const reported = situation.state.agentConnections;
      for (const row of view.agents.rows) {
        const answer = reported?.find((agent) => agent.provider === row.provider);
        assert.equal(
          row.status,
          answer?.status ?? null,
          `${row.provider} in ${situation.name}`,
        );
        // The one claim that could send an operator to a terminal that cannot
        // serve them: `ready` may only ever come from the host saying so.
        assert.equal(row.ready, answer?.status === "ready", `${row.provider} in ${situation.name}`);
        assert.ok(row.statusLabel.trim().length > 0, `${row.provider} in ${situation.name}`);
      }
      assert.equal(view.github.connected, situation.state.githubConnection?.status === "connected");
      // No degraded frame may hand the screen a link into a host auth flow.
      assert.doesNotMatch(JSON.stringify(view), /https?:\/\//i, situation.name);
    }
  }
});

const projectsFailures: readonly ProjectsReadFailureCode[] = [
  "unavailable",
  "unauthorized",
  "not_found",
  "repository_not_bound",
  "invalid_response",
  "transport_failed",
];

/**
 * NUKRYPIMAS (forma, ne aprėptis): etalonas šitą būseną pasiimdavo kaip `projectsBases[2] as
 * Step`. Su `noUncheckedIndexedAccess` indeksas yra `| undefined`, o `as` čia dar ir riša
 * testą prie masyvo TVARKOS: įterpus naują bazę priekyje, „saugyklos gedimas" būtų tikrintas
 * ant tuščio registro ir praeitų nieko neįrodęs. Bazė turi vardą, ir tuo vardu ji naudojama.
 */
const registryWithOpenProject: Step = {
  name: "registry cached and a project open",
  events: [
    { type: "projects.read-started" },
    { type: "projects.list", projects: [projectSummary()] },
    { type: "projects.read-settled" },
    { type: "project.selected", projectId },
    { type: "projects.read-started" },
    { type: "projects.repository-status", projectId, status: repositoryStatus() },
    { type: "projects.read-settled" },
  ],
};

const projectsBases: readonly Step[] = [
  { name: "never read", events: [] },
  {
    name: "registry cached",
    events: [
      { type: "projects.read-started" },
      { type: "projects.list", projects: [projectSummary()] },
      { type: "projects.read-settled" },
    ],
  },
  registryWithOpenProject,
  {
    name: "empty registry",
    events: [
      { type: "projects.read-started" },
      { type: "projects.list", projects: [] },
      { type: "projects.read-settled" },
    ],
  },
];

const projectsFailureSteps: readonly Step[] = [
  { name: "no failure", events: [] },
  ...projectsFailures.map((failure): Step => ({
    name: `after ${failure}`,
    events: [
      { type: "projects.read-started" },
      { type: "projects.read-failed", failure },
      { type: "projects.read-settled" },
    ],
  })),
];

const projectsTails: readonly Step[] = [
  { name: "idle", events: [] },
  { name: "retry in flight", events: [{ type: "projects.read-started" }] },
  {
    name: "failing read not settled yet",
    events: [
      { type: "projects.read-started" },
      { type: "projects.read-failed", failure: "transport_failed" },
    ],
  },
  {
    name: "unreachable read not settled yet",
    events: [
      { type: "projects.read-started" },
      { type: "projects.read-failed", failure: "unavailable" },
    ],
  },
  {
    name: "repository read failed while the registry answered",
    events: [
      { type: "projects.read-started" },
      { type: "projects.repository-failed", projectId, failure: "repository_not_bound" },
      { type: "projects.read-settled" },
    ],
  },
  {
    name: "read settled without a result",
    events: [
      { type: "projects.read-started" },
      { type: "projects.read-settled" },
    ],
  },
];

function projectsCombination(state: AppState): string {
  return [
    state.projectsLink,
    state.projects === null ? "no-snapshot" : "cached",
    state.projectsReadsInFlight > 0 ? "reading" : "not-reading",
  ].join("/");
}

test("every Projects degraded frame explains itself, dates itself and keeps a way back", () => {
  const combinations = new Set<string>();
  let frames = 0;

  for (const base of projectsBases) {
    for (const failure of projectsFailureSteps) {
      for (const tail of projectsTails) {
        const situation = compose(base, failure, tail);
        combinations.add(projectsCombination(situation.state));
        assertReadOnlyFrame(projectsFrame(situation));

        // The repository pane makes the same promises about its own state: it
        // never shows a binding without saying how fresh it is, and never
        // reports a failure it cannot word.
        const repository = presentProjects(situation.state).repository;
        const label = `Projects repository — ${situation.name}`;
        assert.equal(
          repository.available,
          situation.state.projectRepository !== null,
          label,
        );
        assert.equal(
          repository.errorMessage !== null,
          situation.state.projectRepositoryError !== null,
          label,
        );
        assert.equal(
          repository.stale,
          repository.available && situation.state.projectRepositoryError !== null,
          label,
        );
        if (!repository.available) {
          assert.ok(repository.unavailableLabel.trim().length > 0, label);
        }
        assert.ok(Object.isFrozen(repository), label);
        frames += 1;
      }
    }
  }

  assert.equal(
    frames,
    projectsBases.length * projectsFailureSteps.length * projectsTails.length,
  );
  assertCoverage(combinations, "Projects");
});

test("a project's repository failure never sinks the registry listing", () => {
  for (const failure of projectsFailures) {
    const situation = compose(registryWithOpenProject, {
      name: `repository read failed with ${failure}`,
      events: [
        { type: "projects.read-started" },
        { type: "projects.repository-failed", projectId, failure },
        { type: "projects.read-settled" },
      ],
    });
    const view = presentProjects(situation.state);

    assert.equal(view.connection.link, "connected", situation.name);
    assert.equal(view.connection.errorMessage, null, situation.name);
    assert.equal(view.rows.length, 1, situation.name);
    assert.notEqual(view.repository.errorMessage, null, situation.name);
  }
});
