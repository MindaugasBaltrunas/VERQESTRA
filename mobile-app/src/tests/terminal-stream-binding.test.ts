import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalStreamObserver } from "../controller/terminal-stream-binding.js";
import { reduceAppState } from "../model/reducer.js";
import { initialAppState } from "../model/state.js";

test("terminal stream observer drives model state without exposing transport details", () => {
  let state = initialAppState;
  const observer = createTerminalStreamObserver((event) => {
    state = reduceAppState(state, event);
  });
  observer.onConnectionChanged("reconnecting");
  observer.onError("transport_error");
  observer.onSnapshot({
    sessionId: "123e4567-e89b-42d3-a456-426614174031",
    state: "live",
    ownerDeviceId: "123e4567-e89b-42d3-a456-426614174032",
    leaseGeneration: 1,
    leaseExpiresAt: "2026-07-26T12:05:00.000Z",
    nextSequence: 8,
    historyTruncated: true,
  });
  observer.onOutput("hel", 6);
  observer.onOutput("lo\n", 7);
  observer.onConnectionChanged("live");

  assert.equal(state.connection, "live");
  assert.equal(state.terminalState, "live");
  assert.equal(state.terminalHistoryTruncated, true);
  assert.deepEqual(state.terminalLines, ["hello", ""]);
  assert.equal(state.error, null);
});
