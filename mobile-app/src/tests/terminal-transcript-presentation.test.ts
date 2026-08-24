import assert from "node:assert/strict";
import test from "node:test";
import {
  presentTerminal,
  terminalVisibleLineLimit,
} from "../controller/presentation/terminal-presenter.js";
import { reduceAppState } from "../model/reducer.js";
import { action, liveState, projectId, stateWith } from "./terminal-presentation-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; žr. `terminal-presentation-doubles.ts`). Čia —
 * TRANSKRIPTAS ir SRAUTAS: ką ekranas rodo, ką jis pripažįsta paslėpęs ir kuo atsijungimas
 * skiriasi nuo pamestos sesijos. Valdikliai — `terminal-presentation.test.ts`.
 */

test("the transcript is windowed and reports what the window hides", () => {
  const lines = Array.from({ length: 1_800 }, (_, index) => `line-${index}`);
  const view = presentTerminal(liveState({ type: "terminal.output", lines }));

  assert.equal(view.rows.length, terminalVisibleLineLimit);
  assert.equal(view.hiddenLineCount, 1_800 - terminalVisibleLineLimit);
  assert.match(view.hiddenLineLabel, /1300/);
  assert.equal(view.rows[0]?.text, `line-${1_800 - terminalVisibleLineLimit}`);
  assert.equal(view.rows.at(-1)?.text, "line-1799");
  // Virtualised lists need unique, non-positional keys for the rendered window.
  assert.equal(new Set(view.rows.map((row) => row.key)).size, view.rows.length);
  assert.equal(view.rows[0]?.key, String(1_800 - terminalVisibleLineLimit));
  assert.equal(view.isEmpty, false);

  const short = presentTerminal(liveState({ type: "terminal.output", lines: ["only"] }));
  assert.equal(short.hiddenLineCount, 0);
  assert.deepEqual(short.rows.map((row) => row.text), ["only"]);
});

test("truncated history and reconnect states stay visible", () => {
  const idle = presentTerminal(stateWith());
  assert.equal(idle.historyTruncated, false);
  assert.equal(idle.isEmpty, true);
  assert.equal(idle.emptyLabel, "Start a session to see agent output.");
  assert.equal(idle.connection.label, "Not connected");
  assert.equal(idle.connection.stale, false);

  const started = presentTerminal(liveState());
  assert.equal(started.emptyLabel, "Waiting for output…");
  assert.equal(started.connection.label, "Live");

  const truncated = presentTerminal(liveState(
    { type: "terminal.output", lines: ["before"] },
    { type: "terminal.history-truncated" },
    { type: "connection.changed", state: "reconnecting" },
  ));
  assert.equal(truncated.historyTruncated, true);
  assert.ok(truncated.historyTruncatedLabel.length > 0);
  assert.equal(truncated.connection.reconnecting, true);
  assert.equal(truncated.connection.showActivity, true);
  assert.equal(truncated.connection.stale, true, "output shown without a live stream is stale");
  assert.match(truncated.connection.label, /Reconnecting/);

  // An explicit detach must not read as a lost terminal: the host keeps running.
  const detached = presentTerminal(liveState({ type: "connection.changed", state: "disconnected" }));
  assert.match(detached.connection.label, /^Detached/);
  assert.equal(detached.canSubmit, false);
});

test("the transcript window is exact at its boundaries", () => {
  const lines = (count: number): readonly string[] =>
    Array.from({ length: count }, (_, index) => `line-${index}`);

  const empty = presentTerminal(liveState());
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.hiddenLineCount, 0);
  assert.equal(empty.isEmpty, true);

  // Exactly the window: everything is rendered and nothing is reported hidden.
  const atLimit = presentTerminal(liveState({
    type: "terminal.output",
    lines: lines(terminalVisibleLineLimit),
  }));
  assert.equal(atLimit.rows.length, terminalVisibleLineLimit);
  assert.equal(atLimit.hiddenLineCount, 0);
  assert.equal(atLimit.rows[0]?.text, "line-0");
  assert.equal(atLimit.rows[0]?.key, "0");
  assert.equal(atLimit.rows.at(-1)?.text, `line-${terminalVisibleLineLimit - 1}`);

  // One line over: the oldest line leaves the window and is counted, not dropped
  // silently — an off-by-one here is exactly what hides output from an operator.
  const oneOver = presentTerminal(liveState({
    type: "terminal.output",
    lines: lines(terminalVisibleLineLimit + 1),
  }));
  assert.equal(oneOver.rows.length, terminalVisibleLineLimit);
  assert.equal(oneOver.hiddenLineCount, 1);
  assert.equal(oneOver.rows[0]?.text, "line-1");
  assert.equal(oneOver.rows[0]?.key, "1");
  assert.equal(oneOver.rows.at(-1)?.text, `line-${terminalVisibleLineLimit}`);

  // Past the Model's own 2 000-line cap the window reports what the buffer still
  // holds, never the lines the Model already trimmed away.
  const overflow = presentTerminal(liveState({ type: "terminal.output", lines: lines(2_600) }));
  assert.equal(overflow.rows.length, terminalVisibleLineLimit);
  assert.equal(overflow.hiddenLineCount, 2_000 - terminalVisibleLineLimit);
  assert.equal(overflow.rows.at(-1)?.text, "line-2599");
  assert.equal(new Set(overflow.rows.map((row) => row.key)).size, terminalVisibleLineLimit);
  assert.equal(overflow.isEmpty, false);
});

test("a start → output → interrupt → close → restart cycle keeps the screen coherent", () => {
  const ready = stateWith(
    { type: "project.selected", projectId },
    { type: "provider.selected", provider: "claude-code" },
  );
  const idle = presentTerminal(ready);
  assert.equal(idle.statusLabel, "disconnected:none");
  assert.equal(idle.canStart, true);
  assert.deepEqual(idle.actions.map((entry) => entry.id), ["start", "interrupt", "close", "detach"]);
  assert.deepEqual(
    idle.actions.filter((entry) => entry.enabled).map((entry) => entry.id),
    ["start"],
    "nothing but starting is possible without a session",
  );

  const creating = [
    { type: "connection.changed", state: "connecting" },
    { type: "terminal.state", state: "creating" },
  ] as const;
  const starting = presentTerminal(creating.reduce(reduceAppState, ready));
  assert.equal(starting.statusLabel, "connecting:creating");
  assert.equal(starting.canStart, false, "a second session must not be startable mid-creation");
  assert.equal(starting.canSubmit, false);
  assert.equal(starting.composer.blockedReason, "The session is still starting.");
  assert.equal(starting.connection.showActivity, true);
  assert.deepEqual(
    starting.actions.filter((entry) => entry.enabled).map((entry) => entry.id),
    ["close", "detach"],
  );

  const running = [
    { type: "connection.changed", state: "live" },
    { type: "terminal.state", state: "live" },
    { type: "terminal.output", lines: ["$ pnpm test", "running…"] },
  ] as const;
  const live = presentTerminal(running.reduce(reduceAppState, creating.reduce(reduceAppState, ready)));
  assert.equal(live.statusLabel, "live:live");
  assert.equal(live.canSubmit, true);
  assert.equal(live.isEmpty, false);
  assert.equal(live.connection.stale, false);
  assert.ok(live.providers.every((option) => !option.enabled), "the provider is bound to the session");
  assert.deepEqual(
    live.actions.filter((entry) => entry.enabled).map((entry) => entry.id),
    ["interrupt", "close", "detach"],
  );

  // An interrupt does not change the session state — the host stays live — so the
  // screen must not lock the composer while the agent is being interrupted.
  const liveStateAfterRun = running.reduce(reduceAppState, creating.reduce(reduceAppState, ready));
  const interrupted = presentTerminal(
    reduceAppState(liveStateAfterRun, { type: "terminal.output", lines: ["^C"] }),
  );
  assert.equal(interrupted.canSubmit, true);
  assert.equal(interrupted.rows.at(-1)?.text, "^C");

  const closing = presentTerminal(
    reduceAppState(liveStateAfterRun, { type: "terminal.state", state: "closing" }),
  );
  assert.equal(closing.composer.blockedReason, "The session is closing.");
  assert.equal(closing.canStart, false);
  assert.deepEqual(
    closing.actions.filter((entry) => entry.enabled).map((entry) => entry.id),
    ["detach"],
    "a session already closing has nothing left to close or interrupt",
  );

  const endedState = ([
    { type: "terminal.state", state: "ended" },
    { type: "connection.changed", state: "disconnected" },
  ] as const).reduce(reduceAppState, liveStateAfterRun);
  const ended = presentTerminal(endedState);
  assert.equal(ended.sessionLabel, "Session ended");
  assert.equal(ended.canStart, true, "the operator must be able to start the next session");
  assert.equal(ended.canSubmit, false);
  assert.ok(ended.providers.every((option) => option.enabled), "the provider is choosable again");
  assert.deepEqual(
    ended.actions.filter((entry) => entry.enabled).map((entry) => entry.id),
    ["start"],
  );
  // The previous transcript stays readable after the session ends.
  assert.deepEqual(ended.rows.map((row) => row.text), ["$ pnpm test", "running…"]);

  const restarted = presentTerminal(reduceAppState(endedState, { type: "terminal.state", state: "creating" }));
  assert.equal(restarted.canStart, false);
  assert.ok(restarted.providers.every((option) => !option.enabled));

  // Only moving to another project clears the transcript and the truncation flag.
  const switched = presentTerminal(reduceAppState(
    reduceAppState(endedState, { type: "terminal.history-truncated" }),
    { type: "project.selected", projectId: "123e4567-e89b-42d3-a456-426614174041" },
  ));
  assert.equal(switched.rows.length, 0);
  assert.equal(switched.historyTruncated, false);
  assert.equal(switched.emptyLabel, "Start a session to see agent output.");
});

test("detaching the stream never presents the session as closed", () => {
  const detachedState = liveState(
    { type: "terminal.output", lines: ["build ok"] },
    { type: "connection.changed", state: "disconnected" },
  );
  const detached = presentTerminal(detachedState);

  // The host process is untouched by a detach: the session is still live, still
  // interruptible and still the thing a close would terminate.
  assert.equal(detached.sessionLabel, "Live");
  assert.equal(detached.statusLabel, "disconnected:live");
  assert.equal(detached.readOnly, false);
  assert.equal(action(detachedState, "interrupt").enabled, true);
  assert.equal(action(detachedState, "close").enabled, true);
  assert.deepEqual(
    detached.actions.filter((entry) => entry.enabled).map((entry) => entry.id),
    ["interrupt", "close"],
    "detach itself is spent, but the session actions remain",
  );
  assert.equal(detached.canStart, false, "a detached session still occupies the slot");
  assert.ok(detached.providers.every((option) => !option.enabled));
  // Output on screen is no longer confirmed by a stream.
  assert.equal(detached.connection.stale, true);
  assert.equal(detached.connection.showActivity, false);
  assert.equal(detached.connection.reconnecting, false);
  assert.deepEqual(detached.rows.map((row) => row.text), ["build ok"]);
  assert.equal(detached.composer.canSend, false);
  assert.match(detached.composer.blockedReason ?? "", /reconnect/);

  // Re-attaching restores exactly what the detach took away.
  const reattachedState = liveState(
    { type: "terminal.output", lines: ["build ok"] },
    { type: "connection.changed", state: "disconnected" },
    { type: "connection.changed", state: "live" },
  );
  const reattached = presentTerminal(reattachedState);
  assert.equal(reattached.canSubmit, true);
  assert.equal(reattached.connection.stale, false);
  assert.equal(action(reattachedState, "detach").enabled, true);

  // An exhausted stream is not a detach: nothing can be started or streamed.
  const offline = presentTerminal(liveState({ type: "connection.changed", state: "offline" }));
  assert.equal(offline.connection.label, "Offline");
  assert.equal(offline.canStart, false);
  assert.deepEqual(
    offline.actions.filter((entry) => entry.enabled).map((entry) => entry.id),
    ["interrupt", "close"],
  );
});

test("an orphaned writer lease is presented as a read-only session, not as a lost one", () => {
  const readOnly = presentTerminal(liveState(
    { type: "terminal.state", state: "read-only" },
    { type: "terminal.output", lines: ["someone else is typing"] },
  ), { composerDraft: "rm -rf /" });

  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.statusLabel, "live:read-only");
  assert.match(readOnly.sessionLabel, /writer lease/);
  // Observation keeps working: the stream is live and the transcript is shown.
  assert.deepEqual(readOnly.rows.map((row) => row.text), ["someone else is typing"]);
  assert.equal(readOnly.connection.stale, false);
  assert.equal(readOnly.canSubmit, false);
  assert.equal(readOnly.composer.canSend, false);
  assert.equal(readOnly.composer.editable, false);
  assert.match(readOnly.composer.blockedReason ?? "", /another device/);
  // A draft typed before the lease was lost must not become sendable.
  assert.equal(readOnly.composer.draft, "rm -rf /");
  assert.equal(readOnly.voice.confirmationRequired, false);
  assert.equal(readOnly.canStart, false);
  assert.deepEqual(
    readOnly.actions.filter((entry) => entry.enabled).map((entry) => entry.id),
    ["close", "detach"],
    "a read-only observer may stop watching or end the session, never write to it",
  );
});
