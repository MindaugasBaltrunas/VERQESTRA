import assert from "node:assert/strict";
import test from "node:test";
import { SecureCloudConsentStore } from "../adapters/speech/cloud-consent-store.js";
import { PushToTalkRecorder, SpeechCaptureError } from "../adapters/speech/push-to-talk-recorder.js";
import type {
  SecureStoreKey,
  SecureStorePort,
  SpeechCapability,
  SpeechCaptureHandle,
  SpeechConsentPort,
  SpeechFinalResult,
  SpeechPartialResult,
  SpeechRecognitionPort,
} from "../model/ports.js";

// The privacy policy of push-to-talk, tested where it is enforced. The rules
// under test are all fail-closed: no consent means no cloud capture, one hold at
// a time, and a transcript may never be labelled more private than it was made.

const consentKey: SecureStoreKey = "speech.cloud-consent";

class MemorySecureStore implements SecureStorePort {
  readonly values = new Map<SecureStoreKey, string>();
  readFails = false;

  async readSecret(key: SecureStoreKey): Promise<string | null> {
    if (this.readFails) throw new Error("keystore is locked");
    return this.values.get(key) ?? null;
  }

  async writeSecret(key: SecureStoreKey, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async deleteSecret(key: SecureStoreKey): Promise<void> {
    this.values.delete(key);
  }
}

const onDeviceCapability: SpeechCapability = Object.freeze({
  available: true,
  mode: "on-device",
  reason: null,
  onDeviceSupported: true,
});

const cloudCapability: SpeechCapability = Object.freeze({
  available: true,
  mode: "cloud",
  reason: null,
  onDeviceSupported: false,
});

type StartInput = Readonly<{ allowCloud: boolean; locale: string }>;

/** Drains the microtask queue; the adapter reads consent and probes before it
 * ever reaches the port, so a single `await` lands far short of `startCapture`. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

class FakeSpeechPort implements SpeechRecognitionPort {
  capability: SpeechCapability = onDeviceCapability;
  probeError: unknown;
  startError: unknown;
  cancelError: unknown;
  final: SpeechFinalResult = { text: "run the tests", mode: "on-device", confidence: 0.9 };
  stopError: unknown;
  /** Extra platform payload a real recogniser result might carry. */
  finalExtras: Readonly<Record<string, unknown>> = {};
  /** Holds `startCapture` open until {@link releaseStart}, modelling a slow start. */
  deferStart = false;

  readonly startInputs: StartInput[] = [];
  probes = 0;
  stops = 0;
  cancels = 0;
  onPartial: ((result: SpeechPartialResult) => void) | undefined;

  private pendingStart: ((handle: SpeechCaptureHandle) => void) | undefined;

  async probe(): Promise<SpeechCapability> {
    this.probes += 1;
    if (this.probeError !== undefined) throw this.probeError;
    return this.capability;
  }

  async startCapture(input: Readonly<{
    allowCloud: boolean;
    locale: string;
    onPartial(result: SpeechPartialResult): void;
  }>): Promise<SpeechCaptureHandle> {
    this.startInputs.push({ allowCloud: input.allowCloud, locale: input.locale });
    this.onPartial = input.onPartial;
    if (this.startError !== undefined) throw this.startError;
    if (!this.deferStart) return this.handle();
    return new Promise<SpeechCaptureHandle>((resolve) => {
      this.pendingStart = resolve;
    });
  }

  /** Resolves a deferred `startCapture` with a live handle. */
  releaseStart(): void {
    const resolve = this.pendingStart;
    this.pendingStart = undefined;
    assert.ok(resolve, "no capture start was pending");
    resolve(this.handle());
  }

  private handle(): SpeechCaptureHandle {
    return Object.freeze({
      stop: async (): Promise<SpeechFinalResult> => {
        this.stops += 1;
        if (this.stopError !== undefined) throw this.stopError;
        // A platform result carries more than the port names — audio, request
        // ids — and the adapter has to leave all of it behind.
        return Object.assign({ ...this.final }, this.finalExtras);
      },
      cancel: async (): Promise<void> => {
        this.cancels += 1;
        if (this.cancelError !== undefined) throw this.cancelError;
      },
    });
  }
}

class ThrowingConsentStore implements SpeechConsentPort {
  reads = 0;

  async readCloudConsent(): Promise<boolean> {
    this.reads += 1;
    throw new Error("consent storage is unreadable");
  }

  async writeCloudConsent(): Promise<void> {
    throw new Error("consent storage is unwritable");
  }
}

type Fixture = Readonly<{
  speech: FakeSpeechPort;
  store: MemorySecureStore;
  recorder: PushToTalkRecorder;
  partials: SpeechPartialResult[];
  hold(): Promise<void>;
}>;

function fixture(options: Readonly<{ withConsentStore?: boolean }> = {}): Fixture {
  const speech = new FakeSpeechPort();
  const store = new MemorySecureStore();
  const recorder = options.withConsentStore === false
    ? new PushToTalkRecorder(speech)
    : new PushToTalkRecorder(speech, new SecureCloudConsentStore(store));
  const partials: SpeechPartialResult[] = [];
  return {
    speech,
    store,
    recorder,
    partials,
    hold: () => recorder.beginHold({
      locale: "en-US",
      onPartial: (result) => partials.push(result),
    }),
  };
}

function grant(store: MemorySecureStore): void {
  store.values.set(consentKey, "granted");
}

async function captureCode(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    assert.ok(error instanceof SpeechCaptureError, `not a SpeechCaptureError: ${String(error)}`);
    return error.code;
  }
  assert.fail("the capture was expected to be refused");
}

test("a cloud recogniser without recorded consent never reaches the microphone", async () => {
  const { speech, recorder, hold } = fixture();
  speech.capability = cloudCapability;

  assert.equal(await captureCode(hold()), "consent-required");
  assert.equal(speech.startInputs.length, 0);
  assert.equal(recorder.activeMode, undefined);

  const capability = await recorder.probe();
  assert.equal(capability.available, false);
  assert.equal(capability.reason, "consent-required");
});

test("cloud is permitted only for a cloud device whose operator granted it", async () => {
  const cloud = fixture();
  cloud.speech.capability = cloudCapability;
  grant(cloud.store);
  await cloud.hold();
  assert.deepEqual(cloud.speech.startInputs, [{ allowCloud: true, locale: "en-US" }]);
  assert.equal(cloud.recorder.activeMode, "cloud");

  // Consent alone must not license an off-device capture the operator was told
  // — by the badge this very mode drives — would happen on the phone.
  const onDevice = fixture();
  grant(onDevice.store);
  await onDevice.hold();
  assert.deepEqual(onDevice.speech.startInputs, [{ allowCloud: false, locale: "en-US" }]);
  assert.equal(onDevice.recorder.activeMode, "on-device");
});

test("a second press cannot open a second microphone session, not even mid-start", async () => {
  const { speech, hold } = fixture();

  speech.deferStart = true;
  const first = hold();
  await flush();
  assert.equal(speech.startInputs.length, 1);
  assert.equal(await captureCode(hold()), "hold-in-progress");

  // The window a plain `handle === undefined` check would miss: the port has
  // answered, but the adapter has not stored the capture yet.
  let raced: string | undefined;
  const inTheWindow = new Promise<void>((resolve) => {
    queueMicrotask(() => {
      void captureCode(hold()).then((code) => {
        raced = code;
        resolve();
      });
    });
  });
  speech.releaseStart();
  await first;
  await inTheWindow;

  assert.equal(raced, "hold-in-progress");
  assert.equal(speech.startInputs.length, 1);
});

test("a recogniser that refuses to start leaves the adapter ready for the next press", async () => {
  const { speech, recorder, hold } = fixture();
  speech.startError = new Error("microphone is busy");

  assert.equal(await captureCode(hold()), "recognizer-failed");
  assert.equal(recorder.activeMode, undefined);

  // A refusal that names a permission problem is reported as one, so the screen
  // can send the operator to settings instead of asking them to try again.
  speech.startError = { code: "permission-denied" };
  assert.equal(await captureCode(hold()), "permission-denied");

  speech.startError = undefined;
  await hold();
  assert.equal(recorder.activeMode, "on-device");
  assert.equal(speech.startInputs.length, 3);
});

test("the final result is the recogniser's own, and its privacy claim can only get weaker", async () => {
  const { speech, store, recorder, hold } = fixture();
  speech.capability = cloudCapability;
  grant(store);
  // The platform claims the words never left the device; the capture this
  // adapter opened says otherwise, and the weaker claim wins.
  speech.final = { text: "run the tests", mode: "on-device", confidence: 0.42 };
  speech.finalExtras = { audioPath: "/tmp/capture.wav", requestId: "cloud-7" };

  await hold();
  const final = await recorder.endHold();

  assert.deepEqual({ ...final }, { text: "run the tests", mode: "cloud", confidence: 0.42 });
  assert.equal("audioPath" in final, false, "platform audio must not leave the adapter");
  assert.equal("requestId" in final, false);
  assert.equal(speech.stops, 1);
  assert.equal(recorder.activeMode, undefined);

  // An on-device capture whose result agrees is the only on-device claim made.
  const local = fixture();
  local.speech.final = { text: "run the tests", mode: "on-device", confidence: 0.9 };
  await local.hold();
  assert.equal((await local.recorder.endHold()).mode, "on-device");

  const drifting = fixture();
  drifting.speech.final = { text: "run the tests", mode: "cloud", confidence: 0.9 };
  await drifting.hold();
  assert.equal((await drifting.recorder.endHold()).mode, "cloud");
});

test("a capture that fails to finalise is still over, and cannot be ended twice", async () => {
  const { speech, recorder, hold } = fixture();
  speech.stopError = new Error("recogniser crashed while finalising");

  await hold();
  await assert.rejects(recorder.endHold(), /recogniser crashed/);
  assert.equal(recorder.activeMode, undefined);
  assert.equal(await captureCode(recorder.endHold()), "no-active-capture");

  speech.stopError = undefined;
  await hold();
  assert.equal((await recorder.endHold()).text, "run the tests");
  assert.equal(speech.startInputs.length, 2);
});

test("cancelling is total: twice, empty-handed, refused by the platform, or too late", async () => {
  const { speech, recorder, hold } = fixture();

  // Nothing held: not an error.
  await recorder.cancelHold();
  assert.equal(speech.cancels, 0);

  speech.cancelError = new Error("recogniser refused to cancel");
  await hold();
  await recorder.cancelHold();
  await recorder.cancelHold();
  assert.equal(speech.cancels, 1, "a cancelled capture must not be cancelled again");
  assert.equal(recorder.activeMode, undefined);
  assert.equal(await captureCode(recorder.endHold()), "no-active-capture");

  // Released before the recogniser answered: the late handle is discarded here
  // and handed to nobody, so a short hold cannot leave a live microphone behind.
  speech.cancelError = undefined;
  speech.deferStart = true;
  const late = hold();
  await flush();
  await recorder.cancelHold();
  speech.releaseStart();
  await late;

  assert.equal(speech.cancels, 2);
  assert.equal(recorder.activeMode, undefined);
  assert.equal(await captureCode(recorder.endHold()), "no-active-capture");
});

test("a probe that throws says nothing, and nothing is not permission", async () => {
  const { speech, recorder, hold } = fixture();
  speech.probeError = new Error("platform speech module is missing");

  const capability = await recorder.probe();
  assert.deepEqual({ ...capability }, {
    available: false,
    mode: "cloud",
    reason: "unsupported",
    onDeviceSupported: false,
  });
  assert.equal(await captureCode(hold()), "unavailable");
  assert.equal(speech.startInputs.length, 0);
});

test("granting and revoking consent goes through the consent port and changes what is possible", async () => {
  const { speech, store, recorder, hold } = fixture();
  speech.capability = cloudCapability;

  assert.equal(await recorder.cloudConsentGranted(), false);
  assert.equal((await recorder.probe()).reason, "consent-required");

  await recorder.grantCloudConsent();
  assert.equal(store.values.get(consentKey), "granted");
  assert.equal(await recorder.cloudConsentGranted(), true);
  const granted = await recorder.probe();
  assert.equal(granted.available, true);
  assert.equal(granted.mode, "cloud");
  await hold();
  assert.deepEqual(speech.startInputs, [{ allowCloud: true, locale: "en-US" }]);
  await recorder.cancelHold();

  await recorder.revokeCloudConsent();
  assert.equal(store.values.has(consentKey), false);
  assert.equal(await recorder.cloudConsentGranted(), false);
  assert.equal(await captureCode(hold()), "consent-required");
  assert.equal(speech.startInputs.length, 1, "a revoked consent must stop the next hold");
});

test("without usable consent storage the cloud stays closed", async () => {
  const withoutStore = fixture({ withConsentStore: false });
  withoutStore.speech.capability = cloudCapability;

  // Nowhere to record a grant, so the grant is not made up for one app run.
  await withoutStore.recorder.grantCloudConsent();
  assert.equal(await withoutStore.recorder.cloudConsentGranted(), false);
  assert.equal(await captureCode(withoutStore.hold()), "consent-required");
  assert.equal(withoutStore.speech.startInputs.length, 0);

  // An on-device recogniser still works: the absent store removes an ability,
  // it never relaxes a check.
  withoutStore.speech.capability = onDeviceCapability;
  await withoutStore.hold();
  assert.deepEqual(withoutStore.speech.startInputs, [{ allowCloud: false, locale: "en-US" }]);

  const unreadable = new ThrowingConsentStore();
  const speech = new FakeSpeechPort();
  speech.capability = cloudCapability;
  const recorder = new PushToTalkRecorder(speech, unreadable);

  assert.equal(await recorder.cloudConsentGranted(), false);
  assert.equal((await recorder.probe()).reason, "consent-required");
  assert.ok(unreadable.reads > 0);
});

test("partial results are forwarded as they arrive and never accumulated", async () => {
  const { speech, partials, recorder, hold } = fixture();
  await hold();

  assert.ok(speech.onPartial, "the port was not given a partial callback");
  speech.onPartial({ text: "run", confidence: 0.3 });
  speech.onPartial({ text: "run the tests", confidence: 0.8 });

  assert.deepEqual(partials, [
    { text: "run", confidence: 0.3 },
    { text: "run the tests", confidence: 0.8 },
  ]);
  // The adapter holds no transcript of its own: what `endHold` returns is the
  // recogniser's final, not the last partial it happened to see.
  assert.equal((await recorder.endHold()).text, "run the tests");
});
