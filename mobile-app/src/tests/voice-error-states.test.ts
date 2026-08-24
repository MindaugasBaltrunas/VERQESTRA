import assert from "node:assert/strict";
import test from "node:test";

import { presentTerminal } from "../controller/presentation/terminal-presenter.js";
import { SecureCloudConsentStore } from "../adapters/speech/cloud-consent-store.js";
import { PushToTalkRecorder } from "../adapters/speech/push-to-talk-recorder.js";
import {
  VoiceCaptureController,
  type VoiceSubmissionTarget,
} from "../controller/voice-capture-controller.js";
import type {
  SecureStoreKey,
  SecureStorePort,
  SpeechCapability,
  SpeechCaptureHandle,
  SpeechFinalResult,
  SpeechPartialResult,
  SpeechRecognitionPort,
} from "../model/ports.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";

/**
 * What happens to a push-to-talk capture that does not end the way it was meant
 * to: a transcript nobody confirmed, a recogniser that fell over while
 * finalising, a review the operator walked away from.
 *
 * There is deliberately no confirmation timeout in production — neither the
 * controller nor the reducer holds a timer — so a pending transcript waits
 * forever. These tests do not invent one; they pin the behaviour that defines
 * the gap: the transcript is never sent by itself, it is never dropped by
 * itself, it blocks the next hold, and the screen says so before the operator
 * tries. If a timeout is ever added, it is these tests that will have to change.
 *
 * The screen half of every claim is checked by feeding the controller's own
 * dispatched events through `reduceAppState`, so the controller and the
 * presenter are never allowed to disagree about the same moment.
 */

const spokenText = "run the tests";
const consentKey: SecureStoreKey = "speech.cloud-consent";

const onDeviceCapability: SpeechCapability = Object.freeze({
  available: true,
  mode: "on-device",
  reason: null,
  onDeviceSupported: true,
});

class MemorySecureStore implements SecureStorePort {
  readonly values = new Map<SecureStoreKey, string>();

  async readSecret(key: SecureStoreKey): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async writeSecret(key: SecureStoreKey, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async deleteSecret(key: SecureStoreKey): Promise<void> {
    this.values.delete(key);
  }
}

/**
 * A recogniser that counts what it was asked to do. "How often was the
 * microphone actually opened" is the whole question in most tests here.
 */
class FakeSpeechPort implements SpeechRecognitionPort {
  capability: SpeechCapability = onDeviceCapability;
  final: SpeechFinalResult = { text: spokenText, mode: "on-device", confidence: 0.95 };
  stopError: unknown;

  starts = 0;
  stops = 0;
  cancels = 0;
  onPartial: ((result: SpeechPartialResult) => void) | undefined;

  async probe(): Promise<SpeechCapability> {
    return this.capability;
  }

  async startCapture(input: Readonly<{
    allowCloud: boolean;
    locale: string;
    onPartial(result: SpeechPartialResult): void;
  }>): Promise<SpeechCaptureHandle> {
    this.starts += 1;
    this.onPartial = input.onPartial;
    return Object.freeze({
      stop: async (): Promise<SpeechFinalResult> => {
        this.stops += 1;
        if (this.stopError !== undefined) throw this.stopError;
        return this.final;
      },
      cancel: async (): Promise<void> => {
        this.cancels += 1;
      },
    });
  }
}

/** Records every submission attempt: "how often" is the point here as well. */
class FakeTerminal implements VoiceSubmissionTarget {
  readonly submitted: string[] = [];

  async submitConfirmedVoice(text: string): Promise<void> {
    this.submitted.push(text);
  }
}

type Fixture = Readonly<{
  speech: FakeSpeechPort;
  store: MemorySecureStore;
  terminal: FakeTerminal;
  controller: VoiceCaptureController;
  events: AppEvent[];
  types(): string[];
  /** Events dispatched since `mark`, by type. */
  typesSince(mark: number): string[];
  /** A whole press-and-release, leaving a transcript under review. */
  speak(): Promise<void>;
  /** The Model as this controller's own events left it, on a live session. */
  screen(): AppState;
}>;

/**
 * The situation the voice controls live in: a live session on a live stream,
 * with a device that can transcribe on-device. Anything less would block the
 * microphone for reasons that have nothing to do with the transcript.
 */
const liveSession: readonly AppEvent[] = [
  { type: "project.selected", projectId: "123e4567-e89b-42d3-a456-426614174091" },
  { type: "provider.selected", provider: "claude-code" },
  { type: "terminal.state", state: "live" },
  { type: "connection.changed", state: "live" },
  {
    type: "voice.availability",
    availability: "available",
    mode: "on-device",
    reason: null,
    cloudConsent: false,
  },
];

function fixture(): Fixture {
  const speech = new FakeSpeechPort();
  const store = new MemorySecureStore();
  const recorder = new PushToTalkRecorder(speech, new SecureCloudConsentStore(store));
  const terminal = new FakeTerminal();
  const events: AppEvent[] = [];
  const controller = new VoiceCaptureController(
    recorder,
    terminal,
    (event) => events.push(event),
    "en-US",
  );
  return {
    speech,
    store,
    terminal,
    controller,
    events,
    types: () => events.map((event) => event.type),
    typesSince: (mark: number) => events.slice(mark).map((event) => event.type),
    speak: async () => {
      await controller.holdStarted();
      await controller.holdEnded();
    },
    screen: () => [...liveSession, ...events].reduce(reduceAppState, initialAppState),
  };
}

test("an unconfirmed transcript is never recorded over: the next hold is refused, not obeyed", async () => {
  const { speech, terminal, controller, events, typesSince, speak, screen } = fixture();
  await speak();
  assert.equal(speech.starts, 1);
  assert.equal(screen().voiceCapture, "review", "the release did not leave a transcript to read");

  const mark = events.length;
  await controller.holdStarted();

  // The recogniser is never reached: recording over the transcript would discard
  // a command the operator has not decided about yet.
  assert.equal(speech.starts, 1, "a new capture was opened over an undecided transcript");
  assert.equal(speech.cancels, 0);
  assert.deepEqual(events.slice(mark), [
    { type: "error", message: "Confirm or discard the transcript first." },
  ]);
  assert.ok(
    !typesSince(mark).includes("voice.capture-requested"),
    "the Model was moved into a capture that never started",
  );

  // And the transcript itself is untouched: the refusal protects it, and the
  // operator can still send exactly what they read.
  const state = screen();
  assert.equal(state.voiceCapture, "review");
  assert.equal(state.voiceDraft, spokenText);
  assert.equal(state.error, "Confirm or discard the transcript first.");
  assert.deepEqual(terminal.submitted, []);
  await controller.confirm(spokenText);
  assert.deepEqual(terminal.submitted, [spokenText]);
});

test("a stuck review is released by cancelling it and by sending it, and by nothing else", async () => {
  // Discarding it.
  const discarded = fixture();
  await discarded.speak();
  discarded.controller.cancel();

  let mark = discarded.events.length;
  await discarded.controller.holdStarted();
  assert.equal(discarded.speech.starts, 2, "the next hold never reached the recogniser");
  assert.deepEqual(discarded.typesSince(mark), ["voice.capture-requested", "voice.capture-started"]);
  assert.ok(!discarded.typesSince(mark).includes("error"), "a discarded transcript still blocked");
  assert.equal(discarded.screen().voiceCapture, "listening");
  assert.deepEqual(discarded.terminal.submitted, [], "cancelling must not send anything");

  // Sending it.
  const sent = fixture();
  await sent.speak();
  await sent.controller.confirm(spokenText);
  assert.deepEqual(sent.terminal.submitted, [spokenText]);

  mark = sent.events.length;
  await sent.controller.holdStarted();
  assert.equal(sent.speech.starts, 2, "the next hold never reached the recogniser");
  assert.deepEqual(sent.typesSince(mark), ["voice.capture-requested", "voice.capture-started"]);
  assert.ok(!sent.typesSince(mark).includes("error"), "a sent transcript still blocked the button");
  assert.equal(sent.screen().voiceCapture, "listening");
});

test("the screen refuses the hold the controller would refuse, in words", async () => {
  const { speech, controller, speak, screen } = fixture();
  await speak();

  const reviewing = screen();
  assert.equal(reviewing.voiceCapture, "review");
  const voice = presentTerminal(reviewing).voice;
  // The screen never offers an action the controller would answer with an error.
  assert.equal(voice.canCapture, false, "the screen offered a hold that would be refused");
  assert.equal(voice.captureBlockedReason, "Finish or discard the current transcript.");
  // ...while still offering both of the ways out.
  assert.equal(voice.canDiscard, true);
  assert.equal(voice.canConfirm, true);
  assert.equal(voice.confirmationRequired, true);

  // Held anyway — a stale render, a double tap — the controller refuses too.
  await controller.holdStarted();
  assert.equal(speech.starts, 1);
  const refused = screen();
  assert.equal(refused.error, "Confirm or discard the transcript first.");
  assert.equal(presentTerminal(refused).voice.canCapture, false);
  assert.equal(
    presentTerminal(refused).voice.captureBlockedReason,
    "Finish or discard the current transcript.",
  );
});

test("a capture that failed leaves the device usable, not a review nobody can clear", async () => {
  const { speech, terminal, speak, screen } = fixture();
  speech.stopError = new Error("recogniser crashed while finalising");

  await speak();

  const failed = screen();
  assert.equal(failed.voiceCapture, "failed");
  assert.equal(failed.voiceError, "recognizer-failed");
  assert.equal(failed.voiceDraft, "", "a failed capture left a transcript behind");
  const failedVoice = presentTerminal(failed).voice;
  assert.equal(failedVoice.errorMessage, "The recogniser failed. Try again.");
  // The failure is worded, and the button is live again: a recogniser fault must
  // not take push-to-talk away for the rest of the session.
  assert.equal(failedVoice.canCapture, true, "a failure locked the microphone");
  assert.equal(failedVoice.captureBlockedReason, null);
  assert.equal(failedVoice.confirmationRequired, false);
  assert.equal(failedVoice.canConfirm, false, "a failed capture offered something to send");

  speech.stopError = undefined;
  await speak();

  assert.equal(speech.starts, 2, "the hold after a failure never reached the recogniser");
  const recovered = screen();
  assert.equal(recovered.voiceCapture, "review");
  assert.equal(recovered.voiceDraft, spokenText);
  assert.equal(recovered.voiceError, null, "the old failure was still on screen");
  assert.deepEqual(terminal.submitted, [], "recovery must not send anything by itself");
});

test("a transcript the operator never confirmed never reaches the host, however long it waits", async () => {
  const { speech, terminal, controller, speak, screen, types } = fixture();
  await speak();

  // There is no timer to advance: the pending transcript has no expiry in the
  // controller or in the Model. "A long pause" is therefore everything else the
  // screen can do in the meantime — repeated holds, releases and second looks.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await controller.holdStarted();
    await controller.holdEnded();
    controller.acknowledgeLowConfidence();
  }

  assert.deepEqual(terminal.submitted, [], "an unconfirmed transcript reached the host");
  assert.equal(speech.starts, 1, "the microphone reopened behind the pending transcript");
  assert.equal(speech.stops, 1);
  assert.ok(!types().includes("voice.cancelled"), "the transcript was dropped without a decision");

  const waiting = screen();
  assert.equal(waiting.voiceCapture, "review", "the transcript expired on its own");
  assert.equal(waiting.voiceDraft, spokenText);
  assert.equal(presentTerminal(waiting).voice.confirmationRequired, true);

  // It is still exactly what the operator read, and only their confirmation
  // moves it.
  await controller.confirm(spokenText);
  assert.deepEqual(terminal.submitted, [spokenText]);
  assert.equal(screen().voiceCapture, "idle", "the review panel was not cleared after sending");
});

test("the consent slot is untouched by a capture that failed or was abandoned", async () => {
  // A failure and an abandoned review both end a capture; neither is a statement
  // about cloud transcription, so neither may write to the keystore.
  const { speech, store, controller, speak } = fixture();
  speech.stopError = new Error("recogniser crashed while finalising");
  await speak();
  speech.stopError = undefined;
  await speak();
  controller.cancel();

  assert.equal(store.values.has(consentKey), false, "a capture wrote a consent nobody gave");
});
