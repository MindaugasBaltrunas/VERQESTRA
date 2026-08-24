import assert from "node:assert/strict";
import test from "node:test";

import { presentConnections } from "../controller/presentation/connections-presenter.js";
import { ConnectionsController } from "../controller/connections-controller.js";
import {
  ConnectionsReadError,
  type HostConnectionsReadPort,
  type HostConnectionsSnapshot,
} from "../model/connections-read.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";

const snapshot: HostConnectionsSnapshot = Object.freeze({
  agents: Object.freeze([
    Object.freeze({ provider: "claude-code" as const, status: "ready" as const, version: null }),
  ]),
  github: Object.freeze({ status: "connected" as const, account: null, authorizationPending: false }),
});

class FakeConnectionsPort implements HostConnectionsReadPort {
  calls = 0;

  constructor(private readonly result: () => Promise<HostConnectionsSnapshot>) {}

  async readConnections(): Promise<HostConnectionsSnapshot> {
    this.calls += 1;
    return this.result();
  }
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

test("a successful read reaches connected through the declared event order", async () => {
  const port = new FakeConnectionsPort(async () => snapshot);
  const sink = recorder();

  await new ConnectionsController(port, sink.dispatch).refresh();

  assert.deepEqual(sink.events.map((event) => event.type), [
    "connections.read-started",
    "connections.snapshot",
    "connections.read-settled",
  ]);
  const state = sink.state();
  assert.equal(state.connectionsLink, "connected");
  assert.equal(state.connectionsReadsInFlight, 0);
  assert.equal(port.calls, 1);
});

test("a port failure becomes screen state instead of a thrown command error", async () => {
  const port = new FakeConnectionsPort(async () => {
    throw new ConnectionsReadError("unauthorized", "Device is not paired");
  });
  const sink = recorder();

  await new ConnectionsController(port, sink.dispatch).refresh();

  assert.deepEqual(sink.events.map((event) => event.type), [
    "connections.read-started",
    "connections.read-failed",
    "connections.read-settled",
  ]);
  const state = sink.state();
  assert.equal(state.connectionsError, "unauthorized");
  assert.equal(state.connectionsReadsInFlight, 0, "the read must settle even after a failure");
  assert.equal(presentConnections(state).connection.canRetry, true);
});

test("an unknown port rejection is classified as a transport failure", async () => {
  const port = new FakeConnectionsPort(async () => {
    throw new TypeError("network request failed");
  });
  const sink = recorder();

  await new ConnectionsController(port, sink.dispatch).refresh();

  assert.equal(sink.state().connectionsError, "transport_failed");
});

test("a reconnect after a failure restores the connected channel", async () => {
  let healthy = false;
  const port = new FakeConnectionsPort(async () => {
    if (!healthy) throw new ConnectionsReadError("transport_failed", "read failed");
    return snapshot;
  });
  const sink = recorder();
  const controller = new ConnectionsController(port, sink.dispatch);

  await controller.refresh();
  assert.equal(sink.state().connectionsLink, "offline");

  healthy = true;
  await controller.refresh();

  const state = sink.state();
  assert.equal(state.connectionsLink, "connected");
  assert.equal(state.connectionsError, null);
});

test("the controller and its port expose no way to change a connection", () => {
  const port: HostConnectionsReadPort = new FakeConnectionsPort(async () => snapshot);
  const portSurface = Object.getOwnPropertyNames(Object.getPrototypeOf(port) as object)
    .filter((name) => name !== "constructor");
  const controllerSurface = Object.getOwnPropertyNames(
    ConnectionsController.prototype as object,
  ).filter((name) => name !== "constructor");

  assert.deepEqual(portSurface, ["readConnections"]);
  assert.deepEqual(controllerSurface, ["refresh"]);
});
