import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createNativeSpeechRecognizer,
  NativeSpeechRecognitionError,
} from "../adapters/native-speech-recognizer";
import type {
  ExpoSpeechErrorEvent,
  ExpoSpeechEventMap,
  ExpoSpeechPermissionResponse,
  ExpoSpeechRecognitionModule,
  ExpoSpeechResultEvent,
  ExpoSpeechStartOptions,
  ExpoSpeechSubscription,
  NativeSpeechPartialResult,
} from "../adapters/native-speech-recognizer";

/**
 * Like the other two adapter suites here, this one imports its subject instead
 * of reading it as text: the adapter names no Expo module, so `node --test` can
 * drive it against a double and pin the facts push-to-talk depends on — a
 * partial is never promoted to a final, a refused microphone is a typed refusal
 * rather than an empty transcript, and no branch starts a cloud capture the
 * caller forbade. The wiring assertions at the end still read source, because
 * `native-runtime.ts` does import `expo-speech-recognition`.
 *
 * NUKRYPIMAS (vieta, ne taisyklės): task 121 numatė šitą failą šalia adapterio,
 * `src/adapters/`. Native paketo test script'as bėga `dist/tests/**` — ten
 * gulintis testas būtų sukompiliuotas ir niekada nepaleistas, t. y. tylus
 * neveikiantis vartas. Todėl jis guli `src/tests/`, kaip 119 ir 120 (task'e ta
 * pati „vietos išlyga" ir numatyta).
 */

const nativeRoot = path.resolve(__dirname, "..", "..");
const adapterFile = path.join(nativeRoot, "src", "adapters", "native-speech-recognizer.ts");
const runtimeFile = path.join(nativeRoot, "src", "composition", "native-runtime.ts");

type ModuleCall =
  | "isRecognitionAvailable" | "supportsOnDeviceRecognition" | "getPermissions"
  | "requestPermissions" | "start" | "stop" | "abort";

/**
 * The `expo-speech-recognition` surface the adapter uses, as a double that
 * records what it was asked to do and lets a test emit the events the platform
 * would. "Was the microphone opened at all" is the whole question in half of
 * these tests, hence `starts`.
 */
class FakeSpeechModule implements ExpoSpeechRecognitionModule {
  available = true;
  onDevice = true;
  permission: ExpoSpeechPermissionResponse = { granted: true, canAskAgain: true };
  readonly calls: ModuleCall[] = [];
  readonly starts: ExpoSpeechStartOptions[] = [];
  private readonly failures = new Map<ModuleCall, Error>();
  private readonly listeners: {
    [Name in keyof ExpoSpeechEventMap]: Array<(event: ExpoSpeechEventMap[Name]) => void>;
  } = { result: [], error: [], end: [] };

  failOn(call: ModuleCall, error: Error): void {
    this.failures.set(call, error);
  }

  private record(call: ModuleCall): void {
    this.calls.push(call);
    const failure = this.failures.get(call);
    if (failure !== undefined) throw failure;
  }

  isRecognitionAvailable(): boolean { this.record("isRecognitionAvailable"); return this.available; }

  supportsOnDeviceRecognition(): boolean { this.record("supportsOnDeviceRecognition"); return this.onDevice; }

  async getPermissionsAsync(): Promise<ExpoSpeechPermissionResponse> {
    this.record("getPermissions");
    return this.permission;
  }

  async requestPermissionsAsync(): Promise<ExpoSpeechPermissionResponse> {
    this.record("requestPermissions");
    return this.permission;
  }

  start(options: ExpoSpeechStartOptions): void { this.starts.push(options); this.record("start"); }

  stop(): void { this.record("stop"); }

  abort(): void { this.record("abort"); }

  addListener<Name extends keyof ExpoSpeechEventMap>(
    eventName: Name,
    listener: (event: ExpoSpeechEventMap[Name]) => void,
  ): ExpoSpeechSubscription {
    const bucket = this.listeners[eventName];
    bucket.push(listener);
    return {
      remove: (): void => {
        const at = bucket.indexOf(listener);
        if (at >= 0) bucket.splice(at, 1);
      },
    };
  }

  /** How many listeners are still attached; a finished capture must leave none. */
  get attached(): number {
    return this.listeners.result.length + this.listeners.error.length + this.listeners.end.length;
  }

  emitResult(event: ExpoSpeechResultEvent): void {
    for (const listener of [...this.listeners.result]) listener(event);
  }

  emitError(event: ExpoSpeechErrorEvent): void {
    for (const listener of [...this.listeners.error]) listener(event);
  }

  emitEnd(): void { for (const listener of [...this.listeners.end]) listener(undefined); }
}

function hasCode(code: string) {
  return (error: unknown): boolean => error instanceof NativeSpeechRecognitionError && error.code === code;
}

function onDeviceHold(module: FakeSpeechModule, partials: NativeSpeechPartialResult[] = []) {
  const onPartial = (result: NativeSpeechPartialResult): number => partials.push(result);
  return createNativeSpeechRecognizer({ module }).startCapture({ allowCloud: false, locale: "en-US", onPartial });
}

test("a device with an on-device recogniser reports itself available and on-device", async () => {
  const module = new FakeSpeechModule();

  assert.deepEqual(await createNativeSpeechRecognizer({ module }).probe(), {
    available: true,
    mode: "on-device",
    reason: null,
    onDeviceSupported: true,
  });
});

test("a device without on-device support reports the backend it would actually use", async () => {
  const module = new FakeSpeechModule();
  module.onDevice = false;

  assert.deepEqual(await createNativeSpeechRecognizer({ module }).probe(), {
    available: true,
    mode: "cloud",
    reason: null,
    onDeviceSupported: false,
  });
});

test("a device with no recogniser is unsupported, and nothing else is asked about it", async () => {
  const module = new FakeSpeechModule();
  module.available = false;

  assert.deepEqual(await createNativeSpeechRecognizer({ module }).probe(), {
    available: false,
    mode: "cloud",
    reason: "unsupported",
    onDeviceSupported: false,
  });
  assert.deepEqual(module.calls, ["isRecognitionAvailable"]);
});

test("probe asks about the permission and never requests it, so no dialog appears", async () => {
  const module = new FakeSpeechModule();

  await createNativeSpeechRecognizer({ module }).probe();
  assert.ok(module.calls.includes("getPermissions"));
  assert.ok(!module.calls.includes("requestPermissions"), "probing put a permission dialog on screen");
  assert.deepEqual(module.starts, [], "probing opened the microphone");
});

test("a permission that was never asked for does not read as a refusal", async () => {
  const module = new FakeSpeechModule();
  module.permission = { granted: false, canAskAgain: true };

  // Reporting "denied" here would make the first grant unreachable: the core
  // refuses to start a capture on a recogniser it was told is unavailable.
  const capability = await createNativeSpeechRecognizer({ module }).probe();
  assert.equal(capability.available, true);
  assert.equal(capability.reason, null);
});

test("a permission the OS will not let us ask for again is reported as denied", async () => {
  const module = new FakeSpeechModule();
  module.permission = { granted: false, canAskAgain: false };

  assert.deepEqual(await createNativeSpeechRecognizer({ module }).probe(), {
    available: false,
    mode: "on-device",
    reason: "permission-denied",
    onDeviceSupported: true,
  });
});

test("a platform probe that throws reports unsupported, never available", async () => {
  for (const call of ["isRecognitionAvailable", "supportsOnDeviceRecognition", "getPermissions"] as const) {
    const module = new FakeSpeechModule();
    module.failOn(call, new Error("native module missing"));

    const capability = await createNativeSpeechRecognizer({ module }).probe();
    assert.equal(capability.available, false, call);
    assert.equal(capability.reason, "unsupported", call);
  }
});

test("a hold forwards partials as they arrive and yields the recogniser's own final result", async () => {
  const module = new FakeSpeechModule();
  const partials: NativeSpeechPartialResult[] = [];
  const handle = await onDeviceHold(module, partials);

  module.emitResult({ results: [{ transcript: "run the", confidence: 0.41 }], isFinal: false });
  const stopped = handle.stop();
  module.emitResult({ results: [{ transcript: "run the tests", confidence: 0.92 }], isFinal: true });
  module.emitEnd();

  assert.deepEqual(await stopped, { text: "run the tests", mode: "on-device", confidence: 0.92 });
  assert.deepEqual(partials, [{ text: "run the", confidence: 0.41 }]);
});

test("a capture that ends without a final result yields silence, not the last partial", async () => {
  const module = new FakeSpeechModule();
  const handle = await onDeviceHold(module);

  module.emitResult({ results: [{ transcript: "half a command", confidence: 0.5 }], isFinal: false });
  const stopped = handle.stop();
  module.emitEnd();

  assert.deepEqual(await stopped, { text: "", mode: "on-device", confidence: null });
});

test("silence reported as a platform error is an empty transcript, not a failure", async () => {
  for (const error of ["no-speech", "no-match"]) {
    const module = new FakeSpeechModule();
    const handle = await onDeviceHold(module);

    const stopped = handle.stop();
    module.emitError({ error });

    assert.deepEqual(await stopped, { text: "", mode: "on-device", confidence: null }, error);
  }
});

test("a confidence the platform did not state is null, never a number to trust", async () => {
  const module = new FakeSpeechModule();
  const handle = await onDeviceHold(module);

  const stopped = handle.stop();
  module.emitResult({ results: [{ transcript: "deploy" }], isFinal: true });
  module.emitEnd();

  assert.deepEqual(await stopped, { text: "deploy", mode: "on-device", confidence: null });
});

test("a forbidden cloud capture is required to run on the device", async () => {
  const module = new FakeSpeechModule();
  await onDeviceHold(module);

  assert.deepEqual(module.starts, [{
    lang: "en-US",
    interimResults: true,
    continuous: true,
    requiresOnDeviceRecognition: true,
  }]);
});

test("a permitted cloud capture lifts the on-device requirement and says so in the result", async () => {
  const module = new FakeSpeechModule();
  const handle = await createNativeSpeechRecognizer({ module }).startCapture({
    allowCloud: true,
    locale: "lt-LT",
    onPartial: () => undefined,
  });

  assert.equal(module.starts[0]?.requiresOnDeviceRecognition, false);
  assert.equal(module.starts[0]?.lang, "lt-LT");

  const stopped = handle.stop();
  module.emitResult({ results: [{ transcript: "paleisk testus", confidence: 0.8 }], isFinal: true });
  module.emitEnd();
  // The mode is the one the capture was opened with, so the badge the operator
  // reads can never claim more privacy than the audio was given.
  assert.deepEqual(await stopped, { text: "paleisk testus", mode: "cloud", confidence: 0.8 });
});

test("a device that cannot recognise on-device is refused, never sent to the cloud instead", async () => {
  const module = new FakeSpeechModule();
  module.onDevice = false;

  await assert.rejects(onDeviceHold(module), hasCode("unavailable"));
  assert.deepEqual(module.starts, [], "a forbidden cloud capture was started anyway");
});

test("a device with no recogniser refuses the hold before touching the microphone", async () => {
  const module = new FakeSpeechModule();
  module.available = false;

  await assert.rejects(onDeviceHold(module), hasCode("unavailable"));
  assert.deepEqual(module.starts, []);
});

test("a refused microphone is a typed refusal, not an empty transcript", async () => {
  const module = new FakeSpeechModule();
  module.permission = { granted: false, canAskAgain: false };

  await assert.rejects(onDeviceHold(module), hasCode("permission-denied"));
  assert.deepEqual(module.starts, [], "the microphone was opened without a grant");
});

test("a malformed permission response denies the capture instead of opening a microphone", async () => {
  for (const permission of [
    {} as unknown as ExpoSpeechPermissionResponse,
    { granted: "true" } as unknown as ExpoSpeechPermissionResponse,
    { granted: 1 } as unknown as ExpoSpeechPermissionResponse,
  ]) {
    const module = new FakeSpeechModule();
    module.permission = permission;

    await assert.rejects(onDeviceHold(module), hasCode("permission-denied"));
    assert.deepEqual(module.starts, []);
  }
});

test("a permission request that throws fails the capture rather than proceeding without one", async () => {
  const module = new FakeSpeechModule();
  module.failOn("requestPermissions", new Error("native module missing"));

  await assert.rejects(onDeviceHold(module), hasCode("recognizer-failed"));
  assert.deepEqual(module.starts, []);
});

test("a start that throws rejects and leaves no listener attached", async () => {
  const module = new FakeSpeechModule();
  module.failOn("start", new Error("recogniser busy"));

  await assert.rejects(onDeviceHold(module), hasCode("recognizer-failed"));
  assert.equal(module.attached, 0, "a failed start left a live subscription");
});

test("the platform's failure strings map onto the port's codes", async () => {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ["not-allowed", "permission-denied"],
    ["service-not-allowed", "permission-denied"],
    ["aborted", "aborted"],
    ["audio-capture", "recognizer-failed"],
    ["network", "recognizer-failed"],
    ["language-not-supported", "recognizer-failed"],
    // A string this table has never seen fails the capture instead of arriving
    // unclassified, the same way the biometric adapter denies an unknown error.
    ["some_future_expo_failure", "recognizer-failed"],
  ];

  for (const [error, code] of expected) {
    const module = new FakeSpeechModule();
    const handle = await onDeviceHold(module);

    const stopped = assert.rejects(handle.stop(), hasCode(code));
    module.emitError({ error });
    await stopped;
  }
});

test("an error settles the capture, and a late end cannot overwrite it", async () => {
  const module = new FakeSpeechModule();
  const handle = await onDeviceHold(module);

  const stopped = assert.rejects(handle.stop(), hasCode("recognizer-failed"));
  module.emitError({ error: "audio-capture" });
  module.emitEnd();
  await stopped;
});

test("releasing twice finalises once and answers both releases the same way", async () => {
  const module = new FakeSpeechModule();
  const handle = await onDeviceHold(module);

  const first = handle.stop();
  const second = handle.stop();
  module.emitResult({ results: [{ transcript: "status", confidence: 0.7 }], isFinal: true });
  module.emitEnd();

  assert.deepEqual(await first, await second);
  assert.equal(module.calls.filter((call) => call === "stop").length, 1);
});

test("a finished capture leaves no listener behind", async () => {
  const module = new FakeSpeechModule();
  const handle = await onDeviceHold(module);
  assert.ok(module.attached > 0, "the capture attached no listeners at all");

  const stopped = handle.stop();
  module.emitEnd();
  await stopped;

  assert.equal(module.attached, 0);
});

test("cancelling aborts the platform capture and detaches every listener", async () => {
  const module = new FakeSpeechModule();
  const handle = await onDeviceHold(module);

  await handle.cancel();

  assert.ok(module.calls.includes("abort"));
  assert.equal(module.attached, 0);
});

test("cancelling is idempotent and never rejects, even when the platform throws", async () => {
  const module = new FakeSpeechModule();
  module.failOn("abort", new Error("nothing to abort"));
  const handle = await onDeviceHold(module);

  await handle.cancel();
  await handle.cancel();

  assert.equal(module.calls.filter((call) => call === "abort").length, 2);
});

test("cancelling a release that is still finalising settles it instead of stranding the screen", async () => {
  const module = new FakeSpeechModule();
  const handle = await onDeviceHold(module);

  // Leaving the terminal cancels a capture whose `stop()` is still in flight; a
  // promise nobody ever settles would leave the screen finalising forever.
  const stopped = assert.rejects(handle.stop(), hasCode("aborted"));
  await handle.cancel();
  await stopped;
});

test("a cancel after a completed release cannot undo the transcript it produced", async () => {
  const module = new FakeSpeechModule();
  const handle = await onDeviceHold(module);

  const stopped = handle.stop();
  module.emitResult({ results: [{ transcript: "commit", confidence: 0.9 }], isFinal: true });
  module.emitEnd();
  const final = await stopped;

  await handle.cancel();
  assert.deepEqual(final, { text: "commit", mode: "on-device", confidence: 0.9 });
  assert.deepEqual(await handle.stop(), final);
});

test("the adapter imports nothing, so it stays loadable outside Metro", async () => {
  const source = await readFile(adapterFile, "utf8");
  assert.doesNotMatch(
    source,
    /^\s*import\s/m,
    "the adapter gained an import; it must stay loadable outside Metro",
  );
  assert.doesNotMatch(source, /require\(/);
});

test("the composition binds expo-speech-recognition to the core's SpeechRecognitionPort", async () => {
  const source = await readFile(runtimeFile, "utf8");
  assert.match(source, /import \{ ExpoSpeechRecognitionModule as SpeechRecognition \} from "expo-speech-recognition"/);
  const body = source.slice(source.indexOf("export function createReactNativeSpeechRecognizer"));
  // The annotated return type is the only compile-time proof that the adapter's
  // locally restated shapes still match the core port.
  assert.match(body, /\)\s*:\s*SpeechRecognitionPort \| undefined\s*\{/);
  assert.match(body, /createNativeSpeechRecognizer\(/);
});

test("an unlinked speech module removes push-to-talk instead of breaking the shell", async () => {
  const source = await readFile(runtimeFile, "utf8");
  const guard = source.slice(source.indexOf("function isLinkedSpeechModule"));
  assert.match(guard, /typeof module\.isRecognitionAvailable === "function"/);
  assert.match(guard, /return undefined/);

  // The port is omitted rather than handed over as `undefined`: the App's
  // documented "no recogniser" shape is an absent key, not a present empty one.
  const ports = source.slice(source.indexOf("export function createReactNativeSpeechPorts"));
  assert.match(ports, /speech === undefined \? \{\} : \{ speech \}/);
  assert.match(ports, /speechConsent:/);
});

test("the consent slot is wired through the core's keystore-backed store", async () => {
  const source = await readFile(runtimeFile, "utf8");
  const body = source.slice(source.indexOf("export function createReactNativeSpeechConsent"));
  assert.match(body, /\)\s*:\s*SpeechConsentPort\s*\{/);
  assert.match(body, /new SecureCloudConsentStore\(store\)/);
  // The store it stands on is the same OS keystore adapter task 119 wired, not a
  // second storage path a consent could survive an uninstall in.
  assert.match(body, /store: SecureStorePort = createReactNativeSecureStore\(\)/);
});

test("the native package declares the speech dependency it now imports", async () => {
  const manifest = JSON.parse(await readFile(path.join(nativeRoot, "package.json"), "utf8")) as Readonly<{
    dependencies?: Readonly<Record<string, string>>;
  }>;
  assert.ok(
    (manifest.dependencies ?? {})["expo-speech-recognition"],
    "native-runtime imports expo-speech-recognition but package.json does not declare it",
  );
});
