import assert from "node:assert/strict";
import test from "node:test";
import {
  presentTerminal,
  terminalInputMaxLength as presentationInputMaxLength,
} from "../controller/presentation/terminal-presenter.js";
import { terminalInputCharacterLimit } from "../controller/terminal-controller.js";
import { reduceAppState } from "../model/reducer.js";
import type { AppState } from "../model/state.js";
import { action, liveState, projectId, stateWith } from "./terminal-presentation-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 542 eilutės). Čia — VALDIKLIAI:
 * kuris provider'is pasirenkamas, kuris gyvenimo ciklo veiksmas įjungtas ir ką kompozeris
 * priima. Transkriptas, srauto būsena ir ciklas ekrane —
 * `terminal-transcript-presentation.test.ts`; bendra fikstūra — `terminal-presentation-doubles.ts`.
 */

test("both agent providers are offered and the choice is frozen once a session exists", () => {
  const chosen = stateWith({ type: "provider.selected", provider: "codex" });
  const view = presentTerminal(chosen);

  assert.deepEqual(view.providers.map((option) => option.provider), ["claude-code", "codex"]);
  assert.deepEqual(view.providers.map((option) => option.label), ["Claude Code", "Codex"]);
  assert.deepEqual(view.providers.map((option) => option.selected), [false, true]);
  assert.ok(view.providers.every((option) => option.enabled));
  assert.equal(view.providerLabel, "Codex");

  // A running session is bound to its provider; the chips must not invite a swap.
  const running = reduceAppState(chosen, { type: "terminal.state", state: "live" });
  assert.ok(presentTerminal(running).providers.every((option) => !option.enabled));
});

test("a session can be started without a stream, and again after the previous one ended", () => {
  // The stream only exists once a session does, so requiring a live stream to
  // start one would make the button permanently unreachable.
  const ready = stateWith(
    { type: "project.selected", projectId },
    { type: "provider.selected", provider: "claude-code" },
  );
  assert.equal(ready.connection, "disconnected");
  assert.equal(presentTerminal(ready).canStart, true);

  assert.equal(presentTerminal(stateWith({ type: "provider.selected", provider: "codex" })).canStart, false);
  assert.equal(presentTerminal(stateWith({ type: "project.selected", projectId })).canStart, false);
  assert.equal(
    presentTerminal(reduceAppState(ready, { type: "connection.changed", state: "offline" })).canStart,
    false,
  );

  assert.equal(presentTerminal(liveState()).canStart, false);
  assert.equal(
    presentTerminal(liveState({ type: "terminal.state", state: "creating" })).canStart,
    false,
  );
  assert.equal(presentTerminal(liveState({ type: "terminal.state", state: "ended" })).canStart, true);
});

test("lifecycle actions are enabled exactly where they can act", () => {
  const live = liveState();
  assert.equal(action(live, "interrupt").enabled, true);
  assert.equal(action(live, "close").enabled, true);
  assert.equal(action(live, "detach").enabled, true);

  const readOnly = liveState({ type: "terminal.state", state: "read-only" });
  assert.equal(presentTerminal(readOnly).readOnly, true);
  // Without the writer lease there is nothing to interrupt, but the session can
  // still be closed.
  assert.equal(action(readOnly, "interrupt").enabled, false);
  assert.equal(action(readOnly, "close").enabled, true);

  const failed = liveState({ type: "terminal.state", state: "failed" });
  assert.equal(action(failed, "close").enabled, true, "a failed session must stay closable");
  assert.equal(action(failed, "start").enabled, false);

  const ended = liveState({ type: "terminal.state", state: "ended" });
  assert.equal(action(ended, "close").enabled, false);
  assert.equal(action(ended, "interrupt").enabled, false);

  // Detach only drops the stream, so it is offered exactly while one is running.
  assert.equal(action(stateWith(), "detach").enabled, false);
  assert.equal(
    action(liveState({ type: "connection.changed", state: "reconnecting" }), "detach").enabled,
    true,
  );
  assert.equal(
    action(liveState({ type: "connection.changed", state: "disconnected" }), "detach").enabled,
    false,
  );
  assert.deepEqual(
    presentTerminal(live).actions.filter((entry) => entry.destructive).map((entry) => entry.id),
    ["close"],
  );
});

test("composer explains every reason input cannot be sent", () => {
  const reason = (state: AppState, draft: string): string | null =>
    presentTerminal(state, { composerDraft: draft }).composer.blockedReason;

  assert.equal(reason(stateWith(), "ls"), "Start a session to send input.");
  assert.equal(reason(liveState({ type: "terminal.state", state: "creating" }), "ls"), "The session is still starting.");
  assert.equal(reason(liveState({ type: "terminal.state", state: "closing" }), "ls"), "The session is closing.");
  assert.match(reason(liveState({ type: "terminal.state", state: "read-only" }), "ls") ?? "", /^Read-only/);
  assert.match(reason(liveState({ type: "terminal.state", state: "failed" }), "ls") ?? "", /^The session failed/);
  assert.match(
    reason(liveState({ type: "connection.changed", state: "reconnecting" }), "ls") ?? "",
    /reconnect/,
  );
  assert.equal(reason(liveState(), "   "), "Type a command to send.");
  assert.match(reason(liveState(), "x".repeat(presentationInputMaxLength + 1)) ?? "", /longer than/);

  const sendable = presentTerminal(liveState(), { composerDraft: "run tests" }).composer;
  assert.equal(sendable.canSend, true);
  assert.equal(sendable.blockedReason, null);
  assert.equal(sendable.editable, true);
  assert.equal(sendable.characterCount, "run tests".length);
  assert.equal(sendable.tooLong, false);

  // The draft is view-owned: nothing about it leaks into the Model.
  assert.equal(presentTerminal(liveState()).composer.draft, "");
  assert.equal(
    presentTerminal(liveState({ type: "terminal.state", state: "read-only" })).composer.editable,
    false,
  );
});

test("the composer offers exactly the input length the controller accepts", () => {
  assert.equal(presentationInputMaxLength, terminalInputCharacterLimit);
});

test("the composer accepts exactly the maximum input and refuses one character more", () => {
  const atLimit = presentTerminal(liveState(), {
    composerDraft: "x".repeat(presentationInputMaxLength),
  }).composer;
  assert.equal(atLimit.characterCount, presentationInputMaxLength);
  assert.equal(atLimit.maxLength, presentationInputMaxLength);
  assert.equal(atLimit.tooLong, false);
  assert.equal(atLimit.canSend, true);
  assert.equal(atLimit.blockedReason, null);

  const overLimit = presentTerminal(liveState(), {
    composerDraft: "x".repeat(presentationInputMaxLength + 1),
  }).composer;
  assert.equal(overLimit.characterCount, presentationInputMaxLength + 1);
  assert.equal(overLimit.tooLong, true);
  assert.equal(overLimit.canSend, false);
  assert.ok(overLimit.blockedReason?.includes(String(presentationInputMaxLength)));
  // Over-long text stays editable, so the operator can trim it instead of
  // retyping a command the composer refuses to hand back.
  assert.equal(overLimit.editable, true);
  assert.equal(overLimit.draft.length, presentationInputMaxLength + 1);

  // `canSend` and `blockedReason` are one decision reported twice; they may never
  // disagree, whatever the session or draft.
  const drafts = ["", " ", "ok", "x".repeat(presentationInputMaxLength + 1)];
  const states = [
    stateWith(),
    liveState(),
    liveState({ type: "terminal.state", state: "read-only" }),
    liveState({ type: "connection.changed", state: "reconnecting" }),
  ];
  for (const draft of drafts) {
    for (const state of states) {
      const view = presentTerminal(state, { composerDraft: draft });
      assert.equal(view.composer.canSend, view.composer.blockedReason === null);
      assert.equal(view.composer.editable, view.canSubmit);
      assert.equal(
        view.composer.placeholder,
        view.canSubmit ? "Type a command for the agent" : "Input is unavailable",
      );
      // Nothing may be sendable without a live session behind it.
      assert.ok(!view.composer.canSend || view.canSubmit);
    }
  }
});

test("every lifecycle action stays labelled and only closing is destructive", () => {
  const terminalStates = [
    "none",
    "creating",
    "live",
    "read-only",
    "closing",
    "ended",
    "failed",
  ] as const;
  const connections = ["disconnected", "connecting", "live", "reconnecting", "offline"] as const;

  for (const terminal of terminalStates) {
    for (const connection of connections) {
      const view = presentTerminal(liveState(
        { type: "connection.changed", state: connection },
        { type: "terminal.state", state: terminal },
      ));
      assert.deepEqual(view.actions.map((entry) => entry.id), ["start", "interrupt", "close", "detach"]);
      assert.deepEqual(
        view.actions.filter((entry) => entry.destructive).map((entry) => entry.id),
        ["close"],
        `${connection}:${terminal} mislabels which action ends the host process`,
      );
      for (const entry of view.actions) {
        assert.ok(entry.label.length > 0, `${entry.id} has no label`);
        assert.ok(entry.hint.length > 0, `${entry.id} has no hint`);
      }
      // Starting and interrupting are mutually exclusive by construction.
      const enabled = new Set(view.actions.filter((entry) => entry.enabled).map((entry) => entry.id));
      assert.ok(!(enabled.has("start") && enabled.has("interrupt")));
      assert.equal(enabled.has("start"), view.canStart);
      assert.ok(!view.canSubmit || enabled.has("interrupt"), "sendable input implies an interruptible agent");
    }
  }
});

test("terminal view state carries no AG Loop write affordance and stays frozen", () => {
  const view = presentTerminal(liveState());
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.actions));
  assert.ok(Object.isFrozen(view.providers));
  assert.equal(view.title, "Mobile Terminal");
  assert.match(view.scopeNotice, /worktree/);
  assert.equal(view.statusLabel, "live:live");
  assert.equal(view.voice.confirmationRequired, false);
});

test("the terminal screen is never mistaken for the read-only AG Loop UI", () => {
  const view = presentTerminal(liveState());
  // The two spaces must stay visually and textually distinguishable: neither
  // wording nor a shared label may let an operator confuse a mutable mobile
  // terminal with the read-only AG Loop UI it sits next to.
  assert.equal(view.title, "Mobile Terminal");
  assert.doesNotMatch(view.title, /AG Loop/i);
  assert.doesNotMatch(view.title, /read-only/i);
  assert.doesNotMatch(view.scopeNotice, /AG Loop UI/i);
});

test("the terminal screen never carries an AG UI process id as a lock signal", () => {
  // Nothing in the terminal view state — labels, hints, status — may name a
  // host process id: the mobile terminal's own writer lease is the only
  // concurrency signal it is allowed to show.
  const view = presentTerminal(liveState({ type: "terminal.state", state: "read-only" }));
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /\bpid\b/i);
  assert.doesNotMatch(serialized, /ui[_-]?pid/i);
});

test("the worktree indicator names the active branch once the host reports one", () => {
  const idle = presentTerminal(stateWith());
  assert.equal(idle.activeBranch, null);
  assert.equal(idle.scopeNotice, "Isolated worktree — separate from the AG Loop terminal.");

  const live = presentTerminal(liveState(), { activeBranch: "mobile/session-42" });
  assert.equal(live.activeBranch, "mobile/session-42");
  assert.match(live.scopeNotice, /mobile\/session-42/);
  assert.match(live.scopeNotice, /worktree/);
  assert.match(live.scopeNotice, /separate from the AG Loop terminal/);

  // A branch reported for one session must not linger once the session ends and
  // the caller stops supplying it — the input is the single source of truth.
  const afterEnd = presentTerminal(liveState({ type: "terminal.state", state: "ended" }));
  assert.equal(afterEnd.activeBranch, null);
});
