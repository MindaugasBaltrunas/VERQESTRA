import assert from "node:assert/strict";
import { SecureCloudConsentStore } from "../adapters/speech/cloud-consent-store.js";
import { PushToTalkRecorder } from "../adapters/speech/push-to-talk-recorder.js";
import {
  VoiceCaptureController,
  VoiceCaptureError,
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
import type { AppEvent } from "../model/reducer.js";

/**
 * Shared doubles for the push-to-talk controller suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `voice-capture-controller.test.ts` buvo 601
 * eilutė). Fikstūra atskirai, nes `FakeSpeechPort` yra vienintelis apibrėžimas, kaip atrodo
 * „mikrofonas buvo atidarytas": `starts`, `stops` ir `cancels` yra būtent tie skaitikliai,
 * kuriais patvirtinimo siūlės rinkinys ir gyvenimo ciklo rinkinys tvirtina skirtingus dalykus
 * apie tą patį įvykį. Dvi kopijos leistų vienai nustoti skaičiuoti.
 */

export const consentKey: SecureStoreKey = "speech.cloud-consent";
export const spokenText = "run the tests";

export const onDeviceCapability: SpeechCapability = Object.freeze({
  available: true,
  mode: "on-device",
  reason: null,
  onDeviceSupported: true,
});

export const cloudCapability: SpeechCapability = Object.freeze({
  available: true,
  mode: "cloud",
  reason: null,
  onDeviceSupported: false,
});

export function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export class MemorySecureStore implements SecureStorePort {
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

export class FakeSpeechPort implements SpeechRecognitionPort {
  capability: SpeechCapability = onDeviceCapability;
  startError: unknown;
  final: SpeechFinalResult = { text: spokenText, mode: "on-device", confidence: 0.95 };
  stopError: unknown;
  /** Holds `startCapture` open until {@link releaseStart}. */
  deferStart = false;
  /** Holds `handle.stop()` open until {@link releaseStop}. */
  deferStop = false;

  starts = 0;
  stops = 0;
  cancels = 0;
  onPartial: ((result: SpeechPartialResult) => void) | undefined;

  private pendingStart: ((handle: SpeechCaptureHandle) => void) | undefined;
  private pendingStop: ((final: SpeechFinalResult) => void) | undefined;

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
    if (this.startError !== undefined) throw this.startError;
    if (!this.deferStart) return this.handle();
    return new Promise<SpeechCaptureHandle>((resolve) => {
      this.pendingStart = resolve;
    });
  }

  releaseStart(): void {
    const resolve = this.pendingStart;
    this.pendingStart = undefined;
    assert.ok(resolve, "no capture start was pending");
    resolve(this.handle());
  }

  releaseStop(): void {
    const resolve = this.pendingStop;
    this.pendingStop = undefined;
    assert.ok(resolve, "no capture finalisation was pending");
    resolve(this.final);
  }

  private handle(): SpeechCaptureHandle {
    return Object.freeze({
      stop: async (): Promise<SpeechFinalResult> => {
        this.stops += 1;
        if (this.stopError !== undefined) throw this.stopError;
        if (!this.deferStop) return this.final;
        return new Promise<SpeechFinalResult>((resolve) => {
          this.pendingStop = resolve;
        });
      },
      cancel: async (): Promise<void> => {
        this.cancels += 1;
      },
    });
  }
}

/** Records every submission attempt: "how often" is the whole point here. */
export class FakeTerminal implements VoiceSubmissionTarget {
  readonly submitted: string[] = [];
  failNext = false;
  /** Holds the submission open, so a second confirm can race the first. */
  deferred = false;

  private pending: (() => void) | undefined;

  async submitConfirmedVoice(text: string): Promise<void> {
    this.submitted.push(text);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("gateway refused the command");
    }
    if (!this.deferred) return;
    await new Promise<void>((resolve) => {
      this.pending = resolve;
    });
  }

  release(): void {
    const resolve = this.pending;
    this.pending = undefined;
    assert.ok(resolve, "no submission was pending");
    resolve();
  }
}

/** A device whose platform probe rejects instead of answering. */
export class UnprobeableRecorder extends PushToTalkRecorder {
  override async probe(): Promise<SpeechCapability> {
    throw new Error("platform speech module blew up");
  }
}

export type Fixture = Readonly<{
  speech: FakeSpeechPort;
  store: MemorySecureStore;
  recorder: PushToTalkRecorder;
  terminal: FakeTerminal;
  controller: VoiceCaptureController;
  events: AppEvent[];
  types(): string[];
  /** Runs a whole press-and-release, leaving a transcript under review. */
  speak(final?: SpeechFinalResult): Promise<void>;
}>;

export function fixture(
  options: Readonly<{ recorder?: (speech: FakeSpeechPort, store: MemorySecureStore) => PushToTalkRecorder }> = {},
): Fixture {
  const speech = new FakeSpeechPort();
  const store = new MemorySecureStore();
  const recorder = options.recorder === undefined
    ? new PushToTalkRecorder(speech, new SecureCloudConsentStore(store))
    : options.recorder(speech, store);
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
    recorder,
    terminal,
    controller,
    events,
    types: () => events.map((event) => event.type),
    speak: async (final?: SpeechFinalResult) => {
      if (final !== undefined) speech.final = final;
      await controller.holdStarted();
      await controller.holdEnded();
    },
  };
}

/** One complete press-and-release, leaving a reviewed transcript pending. */
export async function fixtureSpeak(controller: VoiceCaptureController): Promise<void> {
  await controller.holdStarted();
  await controller.holdEnded();
}

export async function captureCode(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    assert.ok(error instanceof VoiceCaptureError, `not a VoiceCaptureError: ${String(error)}`);
    return error.code;
  }
  assert.fail("the confirmation was expected to be refused");
}

export function availabilityEvents(events: readonly AppEvent[]): ReadonlyArray<
  Extract<AppEvent, { type: "voice.availability" }>
> {
  return events.filter((event): event is Extract<AppEvent, { type: "voice.availability" }> =>
    event.type === "voice.availability");
}

export function consentEvents(events: readonly AppEvent[]): ReadonlyArray<
  Extract<AppEvent, { type: "voice.cloud-consent" }>
> {
  return events.filter((event): event is Extract<AppEvent, { type: "voice.cloud-consent" }> =>
    event.type === "voice.cloud-consent");
}
