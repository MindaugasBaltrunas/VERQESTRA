import assert from "node:assert/strict";
import test from "node:test";

import { presentTerminal } from "../controller/presentation/terminal-presenter.js";
import type { AppEvent } from "../model/reducer.js";
import type { ConnectionState, TerminalState } from "../model/state.js";
import type { VoiceCaptureState } from "../model/voice.js";
import { projectId, reduce, type Situation } from "./screen-degraded-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; žr. `screen-degraded-doubles.ts`). Čia — TERMINALAS.
 * Jis netikrinamas `assertReadOnlyFrame` funkcija sąmoningai: terminalas VIENINTELIS iš
 * penkių ekranų turi rašymo kelią, tad jo pažadai kiti — ne „nieko negalima", o „kiekvienas
 * atsisakymas įvardytas". Būtent todėl bendras teiginys jam netinka ir jo šešėlyje jis
 * nepasislepia.
 */

const connectionStates: readonly ConnectionState[] = [
  "disconnected",
  "connecting",
  "live",
  "reconnecting",
  "offline",
];

const terminalStates: readonly TerminalState[] = [
  "none",
  "creating",
  "live",
  "read-only",
  "closing",
  "ended",
  "failed",
];

const sweptVoicePhases: readonly VoiceCaptureState[] = ["idle", "review", "failed"];

const outputEvent: AppEvent = {
  type: "terminal.output",
  lines: Object.freeze(["$ pnpm test", "ok"]),
};

const screenErrorEvent: AppEvent = {
  type: "error",
  message: "The gateway refused the last write.",
};

function voiceEvents(phase: VoiceCaptureState): readonly AppEvent[] {
  switch (phase) {
    case "review":
      return [
        { type: "voice.capture-requested" },
        { type: "voice.capture-started", mode: "on-device" },
        { type: "voice.capture-finalizing" },
        { type: "voice.transcribed", text: "run the tests", mode: "on-device", confidence: 0.95 },
      ];
    case "failed":
      return [{ type: "voice.capture-failed", failure: "no-speech" }];
    default:
      return [];
  }
}

function terminalSituation(options: Readonly<{
  connection: ConnectionState;
  terminalState: TerminalState;
  hasOutput: boolean;
  phase: VoiceCaptureState;
  hasError: boolean;
}>): Situation {
  // `project.selected` resets the session and the buffer, so it goes first: a
  // situation assembled in another order would silently be a different one.
  const events: readonly AppEvent[] = [
    { type: "project.selected", projectId },
    { type: "provider.selected", provider: "claude-code" },
    ...(options.hasOutput ? [outputEvent] : []),
    { type: "terminal.state", state: options.terminalState },
    { type: "connection.changed", state: options.connection },
    ...voiceEvents(options.phase),
    {
      type: "voice.availability",
      availability: "available",
      mode: "on-device",
      reason: null,
      cloudConsent: false,
    },
    ...(options.hasError ? [screenErrorEvent] : []),
  ];
  return {
    name: `${options.connection}/${options.terminalState}/` +
      `${options.hasOutput ? "output" : "no output"}/${options.phase}/` +
      `${options.hasError ? "error" : "no error"}`,
    state: reduce(events),
  };
}

test("a terminal that is not live refuses input in words, and never silently", () => {
  let frames = 0;
  for (const connection of connectionStates) {
    for (const terminalState of terminalStates) {
      for (const hasOutput of [false, true]) {
        for (const phase of sweptVoicePhases) {
          for (const hasError of [false, true]) {
            const situation = terminalSituation({
              connection,
              terminalState,
              hasOutput,
              phase,
              hasError,
            });
            const label = situation.name;
            // The builder is asserted, not trusted: a reducer change that made a
            // phase unreachable would otherwise leave this sweep counting the
            // right number of frames while visiting the wrong states.
            assert.equal(situation.state.voiceCapture, phase, `unreachable phase: ${label}`);
            const view = presentTerminal(situation.state);
            frames += 1;

            // 1. The screen never goes blank without an explanation of its own.
            assert.equal(view.isEmpty, view.rows.length === 0, `emptiness: ${label}`);
            if (view.isEmpty) {
              assert.ok(view.emptyLabel.trim().length > 0, `a blank terminal must say why: ${label}`);
            }
            assert.ok(view.sessionLabel.trim().length > 0, `the session badge must read: ${label}`);
            assert.ok(view.connection.label.trim().length > 0, `the link badge must read: ${label}`);

            // 2. Output that no live stream confirms is marked as such, and
            //    output that never existed is not.
            assert.equal(
              view.connection.stale,
              view.rows.length > 0 && terminalState !== "none" && connection !== "live",
              `staleness: ${label}`,
            );

            // 6. Sending is possible exactly when both the session and the
            //    stream are live, and every refusal is worded — for the keyboard
            //    and for the microphone alike.
            assert.equal(
              view.canSubmit,
              connection === "live" && terminalState === "live",
              `canSubmit: ${label}`,
            );
            assert.equal(
              view.composer.canSend,
              view.composer.blockedReason === null,
              `composer: ${label}`,
            );
            if (connection !== "live") {
              assert.equal(view.canSubmit, false, `a dead stream must not accept input: ${label}`);
              assert.equal(view.composer.canSend, false, `composer: ${label}`);
              assert.ok(
                (view.composer.blockedReason ?? "").trim().length > 0,
                `the composer refused without saying why: ${label}`,
              );
              assert.equal(view.composer.editable, false, `composer editable: ${label}`);
              assert.equal(view.voice.canCapture, false, `push-to-talk: ${label}`);
              assert.ok(
                (view.voice.captureBlockedReason ?? "").trim().length > 0,
                `push-to-talk refused without saying why: ${label}`,
              );
            }

            // 4. A read-only session is a lease held elsewhere, not a broken
            //    one: it is visible as read-only and it accepts nothing.
            assert.equal(view.readOnly, terminalState === "read-only", `readOnly: ${label}`);
            if (view.readOnly) {
              assert.equal(view.canSubmit, false, `a read-only session accepted input: ${label}`);
              assert.equal(
                view.composer.blockedReason,
                "Read-only: the writer lease is held by another device.",
                `read-only wording: ${label}`,
              );
            }

            // 3. Whatever went wrong is worded, and no control is disabled mutely.
            assert.equal(
              view.errorMessage,
              hasError ? "The gateway refused the last write." : null,
              `errorMessage: ${label}`,
            );
            if (!view.voice.canCapture) {
              assert.notEqual(view.voice.captureBlockedReason, null, `mute microphone: ${label}`);
            }
            if (!view.voice.canConfirm) {
              assert.notEqual(view.voice.confirmBlockedReason, null, `mute confirmation: ${label}`);
            }
            for (const action of view.actions) {
              assert.ok(action.hint.trim().length > 0, `${action.id} has no hint: ${label}`);
              assert.ok(action.label.trim().length > 0, `${action.id} has no label: ${label}`);
            }

            // 5. Nothing the screen was handed can be edited under it.
            assert.ok(Object.isFrozen(view), `view state is mutable: ${label}`);
            assert.ok(Object.isFrozen(view.connection), `connection is mutable: ${label}`);
            assert.ok(Object.isFrozen(view.composer), `composer is mutable: ${label}`);
            assert.ok(Object.isFrozen(view.voice), `voice is mutable: ${label}`);
            assert.ok(Object.isFrozen(view.voice.privacy), `privacy is mutable: ${label}`);
            assert.ok(Object.isFrozen(view.actions), `actions are mutable: ${label}`);
          }
        }
      }
    }
  }
  assert.equal(
    frames,
    connectionStates.length * terminalStates.length * 2 * sweptVoicePhases.length * 2,
  );
});

test("an unconfirmed transcript survives every stream and session state it is caught by", () => {
  // Losing the host mid-review must not send the transcript, and must not throw
  // it away either: it stays on screen, unsendable, with the reason on it.
  for (const connection of connectionStates) {
    for (const terminalState of terminalStates) {
      const situation = terminalSituation({
        connection,
        terminalState,
        hasOutput: true,
        phase: "review",
        hasError: false,
      });
      const voice = presentTerminal(situation.state).voice;
      assert.equal(situation.state.voiceDraft, "run the tests", situation.name);
      assert.equal(voice.draft, "run the tests", situation.name);
      assert.equal(voice.confirmationRequired, true, situation.name);
      assert.equal(voice.canDiscard, true, `no way out of the review: ${situation.name}`);
      if (connection !== "live" || terminalState !== "live") {
        assert.equal(voice.canConfirm, false, `sent into a dead session: ${situation.name}`);
        assert.notEqual(voice.confirmBlockedReason, null, situation.name);
      }
    }
  }
});
