import assert from "node:assert/strict";
import test from "node:test";

import {
  clampAgentConnections,
  type AgentConnection,
  type GitHubConnection,
  type HostConnectionsSnapshot,
} from "../model/connections-read.js";
import { linkAfterReadFailed, linkAfterReadStarted } from "../model/read-channel.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";

function apply(events: readonly AppEvent[], from: AppState = initialAppState): AppState {
  return events.reduce(reduceAppState, from);
}

const claudeReady: AgentConnection = Object.freeze({
  provider: "claude-code",
  status: "ready",
  version: "1.2.3",
});

const codexBusy: AgentConnection = Object.freeze({
  provider: "codex",
  status: "busy",
  version: null,
});

const githubConnected: GitHubConnection = Object.freeze({
  status: "connected",
  account: "octocat",
  authorizationPending: false,
});

function snapshot(overrides: Partial<HostConnectionsSnapshot> = {}): HostConnectionsSnapshot {
  return Object.freeze({
    agents: Object.freeze([claudeReady, codexBusy]),
    github: githubConnected,
    ...overrides,
  });
}

test("a first read reports the channel as dialling, and a refresh over it does not", () => {
  const dialling = apply([{ type: "connections.read-started" }]);
  assert.equal(dialling.connectionsLink, "connecting");
  assert.equal(dialling.connectionsReadsInFlight, 1);

  const refreshing = apply([
    { type: "connections.snapshot", snapshot: snapshot() },
    { type: "connections.read-started" },
  ]);
  assert.equal(refreshing.connectionsLink, "connected", "a healthy link must not flash 'connecting'");
});

test("an accepted snapshot connects the channel and clears the previous failure", () => {
  const state = apply([
    { type: "connections.read-failed", failure: "transport_failed" },
    { type: "connections.snapshot", snapshot: snapshot() },
  ]);

  assert.equal(state.connectionsLink, "connected");
  assert.equal(state.connectionsError, null);
  assert.deepEqual(state.agentConnections, [claudeReady, codexBusy]);
  assert.deepEqual(state.githubConnection, githubConnected);
});

test("a failure without any state on screen is offline, not degraded", () => {
  for (const failure of ["unauthorized", "invalid_response", "transport_failed", "unavailable"] as const) {
    const state = apply([{ type: "connections.read-failed", failure }]);
    assert.equal(state.connectionsLink, "offline", failure);
    assert.equal(state.connectionsError, failure);
  }
});

test("a failure over a usable snapshot degrades the link and keeps the snapshot", () => {
  const state = apply([
    { type: "connections.snapshot", snapshot: snapshot() },
    { type: "connections.read-failed", failure: "transport_failed" },
  ]);

  assert.equal(state.connectionsLink, "degraded");
  assert.equal(state.connectionsError, "transport_failed");
  assert.deepEqual(state.agentConnections, [claudeReady, codexBusy]);
});

test("an unreachable host is offline even while a snapshot is still readable", () => {
  const state = apply([
    { type: "connections.snapshot", snapshot: snapshot() },
    { type: "connections.read-failed", failure: "unavailable" },
  ]);

  assert.equal(state.connectionsLink, "offline");
  assert.notEqual(state.agentConnections, null, "the last known state stays on screen");
});

test("a host that stops reporting providers erases the previous provider state", () => {
  const state = apply([
    { type: "connections.snapshot", snapshot: snapshot() },
    { type: "connections.snapshot", snapshot: snapshot({ agents: null, github: null }) },
  ]);

  assert.equal(state.agentConnections, null, "an unconfirmed provider state must not survive");
  assert.equal(state.githubConnection, null);
});

test("an empty provider list is an answer, and is not read as a missing one", () => {
  const state = apply([{ type: "connections.snapshot", snapshot: snapshot({ agents: [] }) }]);

  assert.deepEqual(state.agentConnections, []);
  assert.notEqual(state.agentConnections, null);
});

test("unmatched settles never make a later read look permanently in flight", () => {
  const state = apply([
    { type: "connections.read-settled" },
    { type: "connections.read-settled" },
  ]);

  assert.equal(state.connectionsReadsInFlight, 0);
});

test("a host answering twice for one provider cannot produce two rows", () => {
  const duplicated = clampAgentConnections([
    claudeReady,
    Object.freeze({ provider: "claude-code", status: "error", version: null }),
    codexBusy,
  ]);

  assert.deepEqual(duplicated, [claudeReady, codexBusy], "the first answer for a provider wins");
});

test("a provider the client does not know is dropped rather than rendered blank", () => {
  // `as unknown as` is the point of the case, not a shortcut around the types: a
  // hostile or newer host CAN put this on the wire, and the only way to assert
  // that the clamp drops it is to hand it something the type system forbids.
  const unknown = { provider: "some-other-cli", status: "ready", version: null } as unknown as AgentConnection;

  assert.deepEqual(clampAgentConnections([unknown, claudeReady]), [claudeReady]);
});

test("the read-channel rules keep or lower the reported quality, never raise it", () => {
  assert.equal(linkAfterReadStarted({ current: "offline", hasSnapshot: true }), "connecting");
  assert.equal(linkAfterReadStarted({ current: "connected", hasSnapshot: true }), "connected");
  assert.equal(linkAfterReadStarted({ current: "degraded", hasSnapshot: false }), "connecting");

  assert.equal(
    linkAfterReadFailed({ current: "connected", hasSnapshot: true, unreachable: false }),
    "degraded",
  );
  assert.equal(
    linkAfterReadFailed({ current: "connected", hasSnapshot: true, unreachable: true }),
    "offline",
  );
  assert.equal(
    linkAfterReadFailed({ current: "offline", hasSnapshot: true, unreachable: false }),
    "offline",
    "a link already known to be offline must not look better after another failure",
  );
  assert.equal(
    linkAfterReadFailed({ current: "connecting", hasSnapshot: false, unreachable: false }),
    "offline",
  );
});
