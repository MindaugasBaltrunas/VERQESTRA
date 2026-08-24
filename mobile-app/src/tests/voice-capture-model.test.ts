import assert from "node:assert/strict";
import test from "node:test";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";
import {
  clampTranscript,
  isLowConfidence,
  voiceLowConfidenceThreshold,
  voiceTranscriptMaxLength,
  type SpeechUnavailableReason,
  type VoiceCaptureFailureCode,
  type VoiceCaptureState,
} from "../model/voice.js";

// The Model's half of push-to-talk: which recogniser answer is allowed to change
// what, and which one is dropped because it belongs to a capture nobody is
// waiting for any more. Nothing here touches an adapter — a transcript that
// cannot exist in the Model can never be sent, whatever a controller decides.

function stateWith(...events: readonly AppEvent[]): AppState {
  return events.reduce(reduceAppState, initialAppState);
}

function transcribed(text: string, confidence: number | null = 0.9): AppEvent {
  return { type: "voice.transcribed", text, mode: "on-device", confidence };
}

const requested: AppEvent = { type: "voice.capture-requested" };
const started: AppEvent = { type: "voice.capture-started", mode: "on-device" };
const finalizing: AppEvent = { type: "voice.capture-finalizing" };

/** Shortest event sequence that leaves the Model in each capture phase. */
const phaseEvents: Readonly<Record<VoiceCaptureState, readonly AppEvent[]>> = Object.freeze({
  "idle": [],
  "starting": [requested],
  "listening": [requested, started],
  "finalizing": [requested, started, finalizing],
  "review": [requested, started, finalizing, transcribed("run the tests")],
  // `no-speech` ends a capture without claiming anything about the device.
  "failed": [{ type: "voice.capture-failed", failure: "no-speech" }],
});

const allPhases: readonly VoiceCaptureState[] = [
  "idle",
  "starting",
  "listening",
  "finalizing",
  "review",
  "failed",
];

/** Every voice event, used to sweep the invariants below over the whole surface. */
const allVoiceEvents: readonly AppEvent[] = Object.freeze([
  {
    type: "voice.availability",
    availability: "available",
    mode: "cloud",
    reason: null,
    cloudConsent: true,
  },
  {
    type: "voice.availability",
    availability: "unavailable",
    mode: "on-device",
    reason: "offline-model-missing",
    cloudConsent: false,
  },
  { type: "voice.cloud-consent", granted: true },
  { type: "voice.cloud-consent", granted: false },
  requested,
  started,
  { type: "voice.partial", text: "half a command", confidence: 0.4 },
  finalizing,
  transcribed("run the tests"),
  transcribed("   "),
  { type: "voice.draft-edited", text: "run the tests --watch" },
  { type: "voice.draft-edited", text: "   " },
  { type: "voice.low-confidence-acknowledged" },
  { type: "voice.capture-failed", failure: "recognizer-failed" },
  { type: "voice.cancelled" },
] as const);

test("the phase fixtures cover every capture state the Model can be in", () => {
  assert.deepEqual([...allPhases].sort(), Object.keys(phaseEvents).sort());
  for (const phase of allPhases) {
    assert.equal(stateWith(...phaseEvents[phase]).voiceCapture, phase);
  }
});

test("a voice event that does not belong to the current phase changes nothing at all", () => {
  const guarded: ReadonlyArray<Readonly<{
    event: AppEvent;
    phases: readonly VoiceCaptureState[];
  }>> = [
    { event: { type: "voice.partial", text: "half a command", confidence: 0.9 }, phases: ["listening"] },
    { event: { type: "voice.capture-started", mode: "cloud" }, phases: ["starting"] },
    { event: finalizing, phases: ["listening"] },
    { event: transcribed("run the tests"), phases: ["listening", "finalizing"] },
    { event: { type: "voice.draft-edited", text: "edited" }, phases: ["review"] },
    { event: { type: "voice.low-confidence-acknowledged" }, phases: ["review"] },
  ];

  for (const { event, phases } of guarded) {
    for (const phase of allPhases) {
      const base = stateWith(...phaseEvents[phase]);
      const next = reduceAppState(base, event);
      if (phases.includes(phase)) {
        // Guards that never fire would pass the assertion below vacuously.
        assert.notEqual(next, base, `${event.type} was ignored in its own phase ${phase}`);
        continue;
      }
      assert.equal(next, base, `${event.type} changed the Model in phase ${phase}`);
    }
  }
});

test("a partial is shown but never becomes a draft or a confirmable transcript", () => {
  const listening = stateWith(...phaseEvents["listening"]);
  const withPartial = reduceAppState(listening, {
    type: "voice.partial",
    text: "delete every worktree",
    confidence: 0.95,
  });

  assert.equal(withPartial.voicePartial, "delete every worktree");
  assert.equal(withPartial.voiceDraft, "");
  assert.equal(withPartial.voiceConfirmationRequired, false);
  assert.equal(withPartial.voiceMode, null);

  // Not even a stream of confident partials may produce something sendable.
  const many = [0.9, 0.95, 0.99].reduce(
    (state, confidence) => reduceAppState(state, {
      type: "voice.partial",
      text: "delete every worktree",
      confidence,
    }),
    listening,
  );
  assert.equal(many.voiceDraft, "");
  assert.equal(many.voiceConfirmationRequired, false);
});

test("a final that arrives after the capture was cancelled cannot revive the panel", () => {
  const cancelled = stateWith(...phaseEvents["finalizing"], { type: "voice.cancelled" });
  const late = reduceAppState(cancelled, transcribed("rm -rf /"));

  assert.equal(late, cancelled);
  assert.equal(late.voiceCapture, "idle");
  assert.equal(late.voiceDraft, "");
  assert.equal(late.voiceConfirmationRequired, false);
});

test("a silent final ends the capture instead of offering an empty transcript", () => {
  for (const text of ["", "   ", "\n\t "]) {
    const silent = stateWith(...phaseEvents["finalizing"], transcribed(text));

    assert.equal(silent.voiceCapture, "failed");
    assert.equal(silent.voiceError, "no-speech");
    assert.equal(silent.voiceDraft, "");
    assert.equal(silent.voiceConfirmationRequired, false);
  }
});

test("editing a transcript down to nothing withdraws the confirmation but stays in review", () => {
  const emptied = stateWith(...phaseEvents["review"], { type: "voice.draft-edited", text: "   " });

  assert.equal(emptied.voiceCapture, "review");
  assert.equal(emptied.voiceConfirmationRequired, false);
  assert.equal(emptied.voiceDraftEdited, true);

  // And typing something back restores it, so the panel is not a dead end.
  const refilled = reduceAppState(emptied, { type: "voice.draft-edited", text: "run the tests" });
  assert.equal(refilled.voiceConfirmationRequired, true);
});

test("a confirmable transcript always means a non-empty draft under review", () => {
  for (const phase of allPhases) {
    const base = stateWith(...phaseEvents[phase]);
    for (const event of allVoiceEvents) {
      const next = reduceAppState(base, event);
      if (!next.voiceConfirmationRequired) continue;
      const label = `${phase} + ${event.type}`;
      assert.equal(next.voiceCapture, "review", label);
      assert.notEqual(next.voiceDraft.trim(), "", label);
    }
  }
});

test("cancelling clears the capture but keeps what the device can do", () => {
  const ready = stateWith(
    {
      type: "voice.availability",
      availability: "unavailable",
      mode: "cloud",
      reason: "consent-required",
      cloudConsent: false,
    },
    ...phaseEvents["review"],
  );
  const cancelled = reduceAppState(ready, { type: "voice.cancelled" });

  assert.equal(cancelled.voiceCapture, "idle");
  assert.equal(cancelled.voiceDraft, "");
  assert.equal(cancelled.voicePartial, "");
  assert.equal(cancelled.voiceMode, null);
  assert.equal(cancelled.voiceConfidence, null);
  assert.equal(cancelled.voiceDraftEdited, false);
  assert.equal(cancelled.voiceLowConfidenceAcknowledged, false);
  assert.equal(cancelled.voiceConfirmationRequired, false);
  assert.equal(cancelled.voiceError, null);

  // What the device can do is untouched, so the operator can hold the button
  // again immediately instead of waiting for another probe.
  assert.equal(cancelled.voiceAvailability, ready.voiceAvailability);
  assert.equal(cancelled.voiceUnavailableReason, ready.voiceUnavailableReason);
  assert.equal(cancelled.voiceBackendMode, ready.voiceBackendMode);
  assert.equal(cancelled.voiceCloudConsent, ready.voiceCloudConsent);
  assert.equal(cancelled.voiceAvailability, "unavailable");
  assert.equal(cancelled.voiceUnavailableReason, "consent-required");
  assert.equal(cancelled.voiceCloudConsent, false);
  // The backend badge follows the capture that actually ran, not the probe that
  // preceded it, and a cancel does not roll it back either.
  assert.equal(ready.voiceBackendMode, "on-device");
});

test("only a failure that describes the device lowers what the device can do", () => {
  const deviceFailures: Readonly<Record<VoiceCaptureFailureCode, SpeechUnavailableReason | null>> =
    Object.freeze({
      "unavailable": "unsupported",
      "permission-denied": "permission-denied",
      "consent-required": "consent-required",
      "no-speech": null,
      "aborted": null,
      "recognizer-failed": null,
    });
  const failureCodes: readonly VoiceCaptureFailureCode[] = [
    "unavailable",
    "permission-denied",
    "consent-required",
    "no-speech",
    "aborted",
    "recognizer-failed",
  ];
  // The Record above is exhaustive by type; this keeps the loop exhaustive too.
  assert.deepEqual([...failureCodes].sort(), Object.keys(deviceFailures).sort());
  const available = stateWith({
    type: "voice.availability",
    availability: "available",
    mode: "on-device",
    reason: null,
    cloudConsent: false,
  });

  for (const failure of failureCodes) {
    const reason = deviceFailures[failure];
    const failed = reduceAppState(available, { type: "voice.capture-failed", failure });

    assert.equal(failed.voiceCapture, "failed", failure);
    assert.equal(failed.voiceError, failure, failure);
    assert.equal(failed.voiceAvailability, reason === null ? "available" : "unavailable", failure);
    assert.equal(failed.voiceUnavailableReason, reason, failure);
  }
});

test("withdrawing cloud consent makes a cloud-only device unusable, and granting it restores use", () => {
  const cloudReady = stateWith({
    type: "voice.availability",
    availability: "available",
    mode: "cloud",
    reason: null,
    cloudConsent: true,
  });

  const withdrawn = reduceAppState(cloudReady, { type: "voice.cloud-consent", granted: false });
  assert.equal(withdrawn.voiceCloudConsent, false);
  assert.equal(withdrawn.voiceAvailability, "unavailable");
  assert.equal(withdrawn.voiceUnavailableReason, "consent-required");

  const restored = reduceAppState(withdrawn, { type: "voice.cloud-consent", granted: true });
  assert.equal(restored.voiceCloudConsent, true);
  assert.equal(restored.voiceAvailability, "available");
  assert.equal(restored.voiceUnavailableReason, null);

  // An on-device recogniser is not blocked by a consent it does not need.
  const onDevice = stateWith({
    type: "voice.availability",
    availability: "available",
    mode: "on-device",
    reason: null,
    cloudConsent: true,
  });
  const stillAvailable = reduceAppState(onDevice, { type: "voice.cloud-consent", granted: false });
  assert.equal(stillAvailable.voiceAvailability, "available");
  assert.equal(stillAvailable.voiceUnavailableReason, null);
});

test("a transcript is truncated at the bound instead of being rejected", () => {
  assert.equal(clampTranscript("").length, 0);
  const exact = "x".repeat(voiceTranscriptMaxLength);
  assert.equal(clampTranscript(exact), exact);

  const overlong = "x".repeat(voiceTranscriptMaxLength + 1);
  assert.equal(clampTranscript(overlong).length, voiceTranscriptMaxLength);

  const final = stateWith(...phaseEvents["finalizing"], transcribed(overlong));
  assert.equal(final.voiceDraft.length, voiceTranscriptMaxLength);
  assert.equal(final.voiceCapture, "review");

  const partial = stateWith(...phaseEvents["listening"], {
    type: "voice.partial",
    text: overlong,
    confidence: null,
  });
  assert.equal(partial.voicePartial.length, voiceTranscriptMaxLength);

  const edited = stateWith(...phaseEvents["review"], { type: "voice.draft-edited", text: overlong });
  assert.equal(edited.voiceDraft.length, voiceTranscriptMaxLength);
});

test("a recogniser that reports no usable confidence is treated as uncertain", () => {
  assert.equal(isLowConfidence(null), true);
  assert.equal(isLowConfidence(Number.NaN), true);
  assert.equal(isLowConfidence(Number.POSITIVE_INFINITY), true);

  // The threshold itself counts as confident; anything under it does not.
  assert.equal(isLowConfidence(voiceLowConfidenceThreshold), false);
  assert.equal(isLowConfidence(voiceLowConfidenceThreshold - 0.0001), true);
  assert.equal(isLowConfidence(1), false);
  assert.equal(isLowConfidence(0), true);
});

test("no voice event touches the terminal, the stream or the shared error", () => {
  const busy = stateWith(
    { type: "connection.changed", state: "live" },
    { type: "terminal.state", state: "live" },
    { type: "terminal.output", lines: ["first line", "second line"] },
    { type: "error", message: "an earlier problem" },
  );

  for (const phase of allPhases) {
    const base = phaseEvents[phase].reduce(reduceAppState, busy);
    for (const event of [...allVoiceEvents, ...phaseEvents[phase]]) {
      const next = reduceAppState(base, event);
      const label = `${phase} + ${event.type}`;
      assert.equal(next.connection, "live", label);
      assert.equal(next.terminalState, "live", label);
      assert.deepEqual(next.terminalLines, ["first line", "second line"], label);
      assert.equal(next.terminalHistoryTruncated, false, label);
      assert.equal(next.error, "an earlier problem", label);
    }
  }
});
