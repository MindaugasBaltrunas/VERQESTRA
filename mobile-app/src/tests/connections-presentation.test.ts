import assert from "node:assert/strict";
import test from "node:test";

import { presentConnections } from "../controller/presentation/connections-presenter.js";
import { agentProviders, type HostConnectionsSnapshot } from "../model/connections-read.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";

function apply(events: readonly AppEvent[]): AppState {
  return events.reduce(reduceAppState, initialAppState);
}

function view(events: readonly AppEvent[]) {
  return presentConnections(apply(events));
}

const fullSnapshot: HostConnectionsSnapshot = Object.freeze({
  agents: Object.freeze([
    Object.freeze({ provider: "claude-code" as const, status: "ready" as const, version: "1.2.3" }),
    Object.freeze({ provider: "codex" as const, status: "busy" as const, version: null }),
  ]),
  github: Object.freeze({
    status: "connected" as const,
    account: "octocat",
    authorizationPending: false,
  }),
});

test("an unwired channel says so instead of blaming the network", () => {
  const state = view([]);

  assert.equal(state.connection.label, "Not configured");
  assert.equal(state.connection.canRetry, false);
  assert.equal(state.showLoadingPlaceholder, false);
  assert.equal(state.showUnavailablePlaceholder, true);
  assert.equal(state.agents.available, false);
  assert.equal(state.github.available, false);
});

test("a read in flight shows the loading placeholder and offers no retry", () => {
  const state = view([{ type: "connections.read-started" }]);

  assert.equal(state.showLoadingPlaceholder, true);
  assert.equal(state.showUnavailablePlaceholder, false);
  assert.equal(state.connection.refreshing, true);
  assert.equal(state.connection.canRetry, false);
});

test("an offline channel keeps its placeholder and offers a retry", () => {
  const state = view([
    { type: "connections.read-started" },
    { type: "connections.read-failed", failure: "unavailable" },
    { type: "connections.read-settled" },
  ]);

  assert.equal(state.connection.link, "offline");
  assert.equal(state.connection.label, "Offline");
  assert.equal(state.connection.errorMessage, "The host connection surface is not reachable.");
  assert.equal(state.connection.canRetry, true);
  assert.equal(state.connection.stale, false, "nothing is on screen, so nothing can be stale");
  assert.equal(state.showUnavailablePlaceholder, true);
});

test("an unauthorized read asks for pairing and shows no connection state", () => {
  const state = view([
    { type: "connections.read-started" },
    { type: "connections.read-failed", failure: "unauthorized" },
    { type: "connections.read-settled" },
  ]);

  assert.equal(state.connection.errorMessage, "Device pairing is required.");
  assert.equal(state.agents.available, false);
  assert.equal(state.github.available, false);
  for (const row of state.agents.rows) {
    assert.equal(row.status, null, `${row.provider} must not claim a state nobody reported`);
    assert.equal(row.ready, false);
  }
});

test("a stale snapshot is marked as last known state rather than silently kept", () => {
  const state = view([
    { type: "connections.snapshot", snapshot: fullSnapshot },
    { type: "connections.read-failed", failure: "transport_failed" },
  ]);

  assert.equal(state.connection.link, "degraded");
  assert.equal(state.connection.stale, true);
  assert.equal(state.connection.label, "Reconnecting — last known state");
  assert.equal(state.agents.rows[0]?.statusLabel, "Ready");
});

test("both providers get a row, and a provider the host skipped says it was not reported", () => {
  const state = view([{
    type: "connections.snapshot",
    snapshot: Object.freeze({
      agents: Object.freeze([
        Object.freeze({ provider: "claude-code" as const, status: "ready" as const, version: null }),
      ]),
      github: null,
    }),
  }]);

  assert.deepEqual(state.agents.rows.map((row) => row.provider), [...agentProviders]);
  const codex = state.agents.rows.find((row) => row.provider === "codex");
  assert.equal(codex?.statusLabel, "Not reported by the host");
  assert.equal(codex?.ready, false);
  assert.equal(codex?.needsAttention, false, "an unknown provider is not an actionable one");
});

test("an empty provider answer is worded as an empty answer, not as a missing one", () => {
  const state = view([{
    type: "connections.snapshot",
    snapshot: Object.freeze({ agents: Object.freeze([]), github: null }),
  }]);

  assert.equal(state.agents.available, true);
  assert.equal(state.agents.isEmpty, true);
  assert.equal(state.agents.emptyLabel, "The host reported no agent provider.");
  assert.equal(state.agents.rows.length, agentProviders.length);
  assert.equal(state.showUnavailablePlaceholder, false, "the host did answer");
});

test("every agent status the contract declares reaches the screen with its own wording", () => {
  const labels = new Set<string>();
  for (const status of ["unavailable", "authentication_required", "ready", "busy", "error"] as const) {
    const state = view([{
      type: "connections.snapshot",
      snapshot: Object.freeze({
        agents: Object.freeze([Object.freeze({ provider: "claude-code" as const, status, version: null })]),
        github: null,
      }),
    }]);
    const row = state.agents.rows[0];
    assert.equal(row?.status, status);
    assert.ok(row && row.statusLabel.length > 0, status);
    labels.add(row.statusLabel);
    assert.equal(row.ready, status === "ready", status);
  }
  assert.equal(labels.size, 5, "each status must be distinguishable on screen");
});

test("a ready provider shows its host version and a busy one is not offered as ready", () => {
  const state = view([{ type: "connections.snapshot", snapshot: fullSnapshot }]);

  const claude = state.agents.rows.find((row) => row.provider === "claude-code");
  assert.equal(claude?.ready, true);
  assert.equal(claude?.detailLabel, "Version 1.2.3");

  const codex = state.agents.rows.find((row) => row.provider === "codex");
  assert.equal(codex?.statusLabel, "Busy — a session is running");
  assert.equal(codex?.ready, false);
  assert.equal(codex?.needsAttention, false);
  assert.equal(codex?.detailLabel, null);
});

test("every GitHub status the contract declares reaches the screen", () => {
  for (const status of ["disconnected", "authorization_required", "connected", "error"] as const) {
    const state = view([{
      type: "connections.snapshot",
      snapshot: Object.freeze({
        agents: null,
        github: Object.freeze({ status, account: null, authorizationPending: false }),
      }),
    }]);

    assert.equal(state.github.status, status);
    assert.equal(state.github.connected, status === "connected");
    assert.equal(state.github.needsAttention, status !== "connected", status);
    assert.equal(state.github.accountLabel, null);
  }
});

test("a pending GitHub authorization is stated, never offered as a link", () => {
  const state = view([{
    type: "connections.snapshot",
    snapshot: Object.freeze({
      agents: null,
      github: Object.freeze({
        status: "authorization_required" as const,
        account: "octocat",
        authorizationPending: true,
      }),
    }),
  }]);

  assert.equal(state.github.accountLabel, "Account octocat");
  assert.equal(
    state.github.authorizationLabel,
    "An authorization is waiting to be completed on the host.",
  );
  // The whole projected view is searched, not just this field: an authorization
  // URL anywhere in it would be a tappable path into a host auth flow, which
  // this read-only space must not carry.
  assert.doesNotMatch(JSON.stringify(state), /https?:\/\//i);
});

test("the Connections view state carries no mutation affordance at all", () => {
  const state = view([{ type: "connections.snapshot", snapshot: fullSnapshot }]);

  assert.equal(state.readOnly, true);
  assert.doesNotMatch(JSON.stringify(state), /authorizationUrl|token|secret|credential/i);
});
