import assert from "node:assert/strict";
import test from "node:test";
import { presentTerminal } from "../controller/presentation/terminal-presenter.js";
import { reduceAppState } from "../model/reducer.js";
import { initialAppState } from "../model/state.js";

test("voice transcript always requires an explicit confirmation", () => {
  // A final is only accepted for a capture that is actually running, so the hold
  // is played out here rather than injecting a transcript from nowhere.
  const requested = reduceAppState(initialAppState, { type: "voice.capture-requested" });
  const listening = reduceAppState(requested, {
    type: "voice.capture-started",
    mode: "on-device",
  });
  const transcribed = reduceAppState(listening, {
    type: "voice.transcribed",
    text: "fix failing tests",
    mode: "on-device",
    confidence: 0.9,
  });
  assert.equal(transcribed.voiceConfirmationRequired, true);
  assert.equal(transcribed.voiceDraft, "fix failing tests");
  assert.equal(transcribed.voiceCapture, "review");
  const cancelled = reduceAppState(transcribed, { type: "voice.cancelled" });
  assert.equal(cancelled.voiceConfirmationRequired, false);
  assert.equal(cancelled.voiceDraft, "");
  assert.equal(cancelled.voiceCapture, "idle");
});

test("terminal can start only with live connection, project and provider", () => {
  let state = reduceAppState(initialAppState, { type: "connection.changed", state: "live" });
  state = reduceAppState(state, { type: "project.selected", projectId: "project-1" });
  assert.equal(presentTerminal(state).canStart, false);
  state = reduceAppState(state, { type: "provider.selected", provider: "codex" });
  assert.equal(presentTerminal(state).canStart, true);
  state = reduceAppState(state, { type: "terminal.state", state: "live" });
  assert.equal(presentTerminal(state).canSubmit, true);
});

test("terminal output is bounded in the pure model", () => {
  const lines = Array.from({ length: 2_100 }, (_, index) => `line-${index}`);
  const state = reduceAppState(initialAppState, { type: "terminal.output", lines });
  assert.equal(state.terminalLines.length, 2_000);
  assert.equal(state.terminalLines[0], "line-100");
});

test("terminal output chunks preserve lines across frame boundaries", () => {
  let state = reduceAppState(initialAppState, {
    type: "terminal.output-chunk",
    data: "hel",
  });
  state = reduceAppState(state, {
    type: "terminal.output-chunk",
    data: "lo\r\nworld",
  });
  assert.deepEqual(state.terminalLines, ["hello", "world"]);
});
