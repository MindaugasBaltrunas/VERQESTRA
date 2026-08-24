import assert from "node:assert/strict";
import test from "node:test";
import {
  presentTerminal,
  terminalInputMaxLength,
} from "../controller/presentation/terminal-presenter.js";
import { terminalInputCharacterLimit } from "../controller/terminal-controller.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState, type ConnectionState, type TerminalState } from "../model/state.js";
import {
  voiceTranscriptMaxLength,
  type SpeechUnavailableReason,
  type VoiceAvailability,
  type VoiceCaptureFailureCode,
  type VoiceCaptureState,
} from "../model/voice.js";
import type { TerminalVoiceViewState } from "../view/terminal-view-state.js";

// Presentation for push-to-talk. The screen renders these decisions and takes
// none of its own, so every "may I?" answered here has to agree with the reason
// shown next to it: a disabled control that says nothing, or an enabled one with
// a blocking reason underneath, is how an operator sends a command twice.

const projectId = "123e4567-e89b-42d3-a456-426614174060";

const terminalStates: readonly TerminalState[] = [
  "none",
  "creating",
  "live",
  "read-only",
  "closing",
  "ended",
  "failed",
];

const connectionStates: readonly ConnectionState[] = [
  "disconnected",
  "connecting",
  "live",
  "reconnecting",
  "offline",
];

const capturePhases: readonly VoiceCaptureState[] = [
  "idle",
  "starting",
  "listening",
  "finalizing",
  "review",
  "failed",
];

const availabilities: readonly VoiceAvailability[] = ["unknown", "available", "unavailable"];

type SceneOptions = Readonly<{
  terminalState?: TerminalState;
  connection?: ConnectionState;
  phase?: VoiceCaptureState;
  availability?: VoiceAvailability;
  reason?: SpeechUnavailableReason;
  backendMode?: "on-device" | "cloud";
  cloudConsent?: boolean;
  confidence?: number | null;
  acknowledge?: boolean;
  transcript?: string;
}>;

function captureEvents(options: SceneOptions): readonly AppEvent[] {
  const phase = options.phase ?? "idle";
  const transcript = options.transcript ?? "run the tests";
  const confidence = options.confidence === undefined ? 0.92 : options.confidence;
  const requested: AppEvent = { type: "voice.capture-requested" };
  const started: AppEvent = { type: "voice.capture-started", mode: "on-device" };
  const finalizing: AppEvent = { type: "voice.capture-finalizing" };
  const final: AppEvent = {
    type: "voice.transcribed",
    text: transcript,
    mode: "on-device",
    confidence,
  };
  switch (phase) {
    case "idle":
      return [];
    case "starting":
      return [requested];
    case "listening":
      return [requested, started, { type: "voice.partial", text: "run the", confidence }];
    case "finalizing":
      return [requested, started, finalizing];
    case "review":
      return [
        requested,
        started,
        finalizing,
        final,
        ...(options.acknowledge === true
          ? [{ type: "voice.low-confidence-acknowledged" } as const]
          : []),
      ];
    case "failed":
      return [{ type: "voice.capture-failed", failure: "no-speech" }];
  }
}

/**
 * A whole screen situation, built through the reducer only: a view state the
 * Model could never produce would prove nothing about the screen.
 */
function scene(options: SceneOptions = {}): AppState {
  const availability = options.availability ?? "available";
  const events: readonly AppEvent[] = [
    { type: "project.selected", projectId },
    { type: "provider.selected", provider: "codex" },
    { type: "terminal.state", state: options.terminalState ?? "live" },
    { type: "connection.changed", state: options.connection ?? "live" },
    ...captureEvents(options),
    // Availability last, and deliberately so: it describes the device, never the
    // capture, so it must be safe to learn it in the middle of a review.
    {
      type: "voice.availability",
      availability,
      mode: options.backendMode ?? "on-device",
      reason: availability === "unavailable" ? options.reason ?? "permission-denied" : null,
      cloudConsent: options.cloudConsent ?? false,
    },
  ];
  return events.reduce(reduceAppState, initialAppState);
}

function voiceOf(options: SceneOptions = {}): TerminalVoiceViewState {
  return presentTerminal(scene(options)).voice;
}

test("every voice situation states a reason exactly when the control is unavailable", () => {
  let reviewed = 0;
  for (const terminalState of terminalStates) {
    for (const connection of connectionStates) {
      for (const phase of capturePhases) {
        for (const availability of availabilities) {
          for (const confidence of [0.95, 0.1, null] as const) {
            for (const acknowledge of [false, true]) {
              const state = scene({
                terminalState,
                connection,
                phase,
                availability,
                confidence,
                acknowledge,
              });
              const label =
                `${terminalState}/${connection}/${phase}/${availability}/${confidence}/${acknowledge}`;
              assert.equal(state.voiceCapture, phase, label);

              const voice = presentTerminal(state).voice;
              reviewed += 1;
              assert.equal(voice.canCapture, voice.captureBlockedReason === null, `capture: ${label}`);
              assert.equal(voice.canConfirm, voice.confirmBlockedReason === null, `confirm: ${label}`);
              assert.equal(
                voice.acknowledgementRequired,
                voice.lowConfidenceWarning !== null,
                `warning: ${label}`,
              );
              assert.equal(
                voice.privacy.consentRequired && !voice.privacy.consentGranted,
                voice.privacy.consentPrompt !== null,
                `consent: ${label}`,
              );
              // A sendable transcript always needs the operator's confirmation.
              assert.ok(!voice.canConfirm || voice.confirmationRequired, `unconfirmed: ${label}`);
            }
          }
        }
      }
    }
  }
  assert.equal(reviewed, terminalStates.length * connectionStates.length * capturePhases.length *
    availabilities.length * 3 * 2);
});

test("the consent prompt is offered only where cloud transcription is what would happen", () => {
  const cloudWithout = voiceOf({ backendMode: "cloud", cloudConsent: false });
  assert.equal(cloudWithout.privacy.consentRequired, true);
  assert.equal(cloudWithout.privacy.consentGranted, false);
  assert.notEqual(cloudWithout.privacy.consentPrompt, null);

  const cloudWith = voiceOf({ backendMode: "cloud", cloudConsent: true });
  assert.equal(cloudWith.privacy.consentRequired, true);
  assert.equal(cloudWith.privacy.consentGranted, true);
  assert.equal(cloudWith.privacy.consentPrompt, null);

  const onDevice = voiceOf({ backendMode: "on-device", cloudConsent: false });
  assert.equal(onDevice.privacy.consentRequired, false);
  assert.equal(onDevice.privacy.consentPrompt, null);
});

test("the privacy badge names the backend that produced the transcript on screen", () => {
  // Before any probe the badge admits it does not know, rather than guessing the
  // more private answer.
  const unprobed = presentTerminal(initialAppState).voice.privacy;
  assert.equal(unprobed.mode, null);
  assert.equal(unprobed.onDevice, false);
  assert.equal(unprobed.badge, "Unknown");
  assert.match(unprobed.label, /not known yet/i);

  const onDevice = voiceOf({ backendMode: "on-device" }).privacy;
  assert.equal(onDevice.mode, "on-device");
  assert.equal(onDevice.onDevice, true);
  assert.match(onDevice.badge, /on-device/i);
  assert.match(onDevice.label, /this device/i);

  const cloud = voiceOf({ backendMode: "cloud", cloudConsent: true }).privacy;
  assert.equal(cloud.mode, "cloud");
  assert.equal(cloud.onDevice, false);
  assert.match(cloud.badge, /cloud/i);
  assert.notEqual(cloud.badge, onDevice.badge);
  assert.notEqual(cloud.label, onDevice.label);

  // The device says it would record on-device, but this transcript came back
  // from the cloud. The badge above the text must describe the text.
  const mixedEvents: readonly AppEvent[] = [
    { type: "terminal.state", state: "live" },
    { type: "connection.changed", state: "live" },
    {
      type: "voice.availability",
      availability: "available",
      mode: "on-device",
      reason: null,
      cloudConsent: true,
    },
    { type: "voice.capture-requested" },
    { type: "voice.capture-started", mode: "on-device" },
    { type: "voice.capture-finalizing" },
    { type: "voice.transcribed", text: "run the tests", mode: "cloud", confidence: 0.9 },
  ];
  const state = mixedEvents.reduce(reduceAppState, initialAppState);
  const mixed = presentTerminal(state).voice.privacy;

  assert.equal(state.voiceBackendMode, "on-device");
  assert.equal(mixed.mode, "cloud");
  assert.equal(mixed.onDevice, false);
  assert.equal(mixed.badge, cloud.badge);
  assert.equal(mixed.label, cloud.label);
});

test("live recogniser text is visible while listening and can never be edited or sent", () => {
  const listening = voiceOf({ phase: "listening" });

  assert.equal(listening.listening, true);
  assert.equal(listening.partial, "run the");
  assert.equal(listening.editable, false);
  assert.equal(listening.canConfirm, false);
  assert.equal(listening.confirmationRequired, false);
  assert.equal(listening.draft, "");
  assert.notEqual(listening.confirmBlockedReason, null);
});

test("a reviewed transcript is editable and sendable only once every condition holds", () => {
  const ready = voiceOf({ phase: "review" });
  assert.equal(ready.editable, true);
  assert.equal(ready.confirmationRequired, true);
  assert.equal(ready.canConfirm, true);
  assert.equal(ready.confirmBlockedReason, null);
  assert.equal(ready.acknowledgementRequired, false);

  const uncertain = voiceOf({ phase: "review", confidence: 0.1 });
  assert.equal(uncertain.lowConfidence, true);
  assert.equal(uncertain.acknowledgementRequired, true);
  assert.equal(uncertain.canConfirm, false);
  assert.match(uncertain.confirmBlockedReason ?? "", /read the uncertain transcript/i);

  const acknowledged = voiceOf({ phase: "review", confidence: 0.1, acknowledge: true });
  assert.equal(acknowledged.acknowledgementRequired, false);
  assert.equal(acknowledged.canConfirm, true);

  // A transcript with no confidence at all is uncertain too, and is stopped by
  // the same second look.
  const unscored = voiceOf({ phase: "review", confidence: null });
  assert.equal(unscored.lowConfidence, true);
  assert.equal(unscored.canConfirm, false);

  const detached = voiceOf({ phase: "review", connection: "reconnecting" });
  assert.equal(detached.canConfirm, false);
  assert.match(detached.confirmBlockedReason ?? "", /stream/i);
});

test("there is always a way out of a capture, and nothing to abandon when idle", () => {
  for (const phase of capturePhases) {
    const voice = voiceOf({ phase });
    assert.equal(voice.canDiscard, phase !== "idle", phase);
  }
});

test("the transcript bound is one number the Model, the presenter and the controller share", () => {
  assert.equal(terminalInputMaxLength, voiceTranscriptMaxLength);
  assert.equal(terminalInputMaxLength, terminalInputCharacterLimit);
  assert.equal(voiceOf().maxLength, terminalInputMaxLength);
  assert.equal(presentTerminal(initialAppState).composer.maxLength, terminalInputMaxLength);

  // The Model truncates at exactly that bound, so a recognised transcript can
  // never reach the composer's "too long" state at all.
  const clamped = voiceOf({ phase: "review", transcript: "x".repeat(voiceTranscriptMaxLength + 500) });
  assert.equal(clamped.characterCount, voiceTranscriptMaxLength);
  assert.equal(clamped.tooLong, false);
  assert.equal(clamped.canConfirm, true);
});

test("every capture failure and every unavailable reason has its own wording", () => {
  // A Record keyed by the union: a new code stops compiling here rather than
  // silently reaching the operator as an empty line.
  const failureCodes: Readonly<Record<VoiceCaptureFailureCode, true>> = Object.freeze({
    "unavailable": true,
    "permission-denied": true,
    "consent-required": true,
    "no-speech": true,
    "aborted": true,
    "recognizer-failed": true,
  });
  const everyFailure: readonly VoiceCaptureFailureCode[] = [
    "unavailable",
    "permission-denied",
    "consent-required",
    "no-speech",
    "aborted",
    "recognizer-failed",
  ];
  assert.deepEqual([...everyFailure].sort(), Object.keys(failureCodes).sort());

  const failureMessages = new Map<string, string>();
  for (const failure of everyFailure) {
    const events: readonly AppEvent[] = [
      { type: "terminal.state", state: "live" },
      { type: "connection.changed", state: "live" },
      { type: "voice.capture-failed", failure },
    ];
    const message = presentTerminal(events.reduce(reduceAppState, initialAppState)).voice.errorMessage;

    assert.ok(message !== null && message.trim().length > 0, `no wording for ${failure}`);
    assert.equal(failureMessages.get(message), undefined, `duplicate wording for ${failure}`);
    failureMessages.set(message, failure);
  }
  assert.equal(failureMessages.size, Object.keys(failureCodes).length);
  assert.equal(presentTerminal(initialAppState).voice.errorMessage, null);

  const unavailableReasons: Readonly<Record<SpeechUnavailableReason, true>> = Object.freeze({
    "unsupported": true,
    "permission-denied": true,
    "consent-required": true,
    "offline-model-missing": true,
  });
  const everyReason: readonly SpeechUnavailableReason[] = [
    "unsupported",
    "permission-denied",
    "consent-required",
    "offline-model-missing",
  ];
  assert.deepEqual([...everyReason].sort(), Object.keys(unavailableReasons).sort());

  const reasonMessages = new Map<string, string>();
  for (const reason of everyReason) {
    const voice = voiceOf({ availability: "unavailable", reason });

    assert.equal(voice.canCapture, false, reason);
    const message = voice.captureBlockedReason;
    assert.ok(message !== null && message.trim().length > 0, `no wording for ${reason}`);
    assert.equal(reasonMessages.get(message), undefined, `duplicate wording for ${reason}`);
    reasonMessages.set(message, reason);
  }
  assert.equal(reasonMessages.size, Object.keys(unavailableReasons).length);

  // Every capture phase says where it stands, and no two mean the same thing.
  const phaseLabels = new Set(capturePhases.map((phase) => voiceOf({ phase }).statusLabel));
  assert.equal(phaseLabels.size, capturePhases.length);
});
