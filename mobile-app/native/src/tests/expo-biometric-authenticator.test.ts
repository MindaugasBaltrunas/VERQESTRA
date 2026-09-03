import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createExpoBiometricAuthenticator } from "../adapters/expo-biometric-authenticator";
import type {
  ExpoLocalAuthenticationModule,
  ExpoLocalAuthenticationOptions,
  ExpoLocalAuthenticationResult,
  NativeBiometricUnlockOutcome,
} from "../adapters/expo-biometric-authenticator";

/**
 * Like `expo-secure-store-adapter.test.ts`, and unlike every other suite in this
 * package, this one imports its subject instead of reading it as text: the
 * adapter names no Expo module, so `node --test` can drive it against a double
 * and pin real behaviour — the availability question, the outcome mapping and
 * the rule that no failure path ever answers "unlocked".
 *
 * NUKRYPIMAS (vieta, ne taisyklės): task 120 numatė šitą failą šalia adapterio,
 * `src/adapters/`. Native paketo test script'as bėga `dist/tests/**` — ten
 * gulintis testas būtų sukompiliuotas ir niekada nepaleistas, t. y. tylus
 * neveikiantis vartas. Todėl jis guli `src/tests/`, kaip 119 (task'e ta pati
 * "vietos išlyga" ir numatyta).
 *
 * The wiring assertions at the end still read source, because `native-runtime.ts`
 * does import `expo-local-authentication` and cannot be loaded here.
 */

const nativeRoot = path.resolve(__dirname, "..", "..");
const adapterFile = path.join(nativeRoot, "src", "adapters", "expo-biometric-authenticator.ts");
const runtimeFile = path.join(nativeRoot, "src", "composition", "native-runtime.ts");

type Call = Readonly<{ op: "hasHardware" | "isEnrolled" | "authenticate" }>;

class FakeLocalAuthentication implements ExpoLocalAuthenticationModule {
  readonly calls: Call[] = [];
  readonly prompts: ExpoLocalAuthenticationOptions[] = [];
  hasHardware = true;
  isEnrolled = true;
  result: ExpoLocalAuthenticationResult = { success: true };
  private readonly failures = new Map<Call["op"], Error>();

  failOn(op: Call["op"], error: Error): void {
    this.failures.set(op, error);
  }

  private record(op: Call["op"]): void {
    this.calls.push({ op });
    const failure = this.failures.get(op);
    if (failure !== undefined) throw failure;
  }

  async hasHardwareAsync(): Promise<boolean> {
    this.record("hasHardware");
    return this.hasHardware;
  }

  async isEnrolledAsync(): Promise<boolean> {
    this.record("isEnrolled");
    return this.isEnrolled;
  }

  async authenticateAsync(
    options: ExpoLocalAuthenticationOptions,
  ): Promise<ExpoLocalAuthenticationResult> {
    this.prompts.push(options);
    this.record("authenticate");
    return this.result;
  }
}

function ops(module: FakeLocalAuthentication): string[] {
  return module.calls.map((call) => call.op);
}

test("a device with enrolled biometrics can be asked for a confirmation", async () => {
  const module = new FakeLocalAuthentication();
  const authenticator = createExpoBiometricAuthenticator({ module });

  assert.equal(await authenticator.isAvailable(), true);
  assert.deepEqual(ops(module), ["hasHardware", "isEnrolled"]);
});

test("absent hardware is unavailable, and enrolment is not even asked about", async () => {
  const module = new FakeLocalAuthentication();
  module.hasHardware = false;
  const authenticator = createExpoBiometricAuthenticator({ module });

  assert.equal(await authenticator.isAvailable(), false);
  assert.deepEqual(ops(module), ["hasHardware"]);
});

test("a sensor with nothing enrolled cannot be asked for a confirmation", async () => {
  const module = new FakeLocalAuthentication();
  module.isEnrolled = false;
  const authenticator = createExpoBiometricAuthenticator({ module });

  assert.equal(await authenticator.isAvailable(), false);
});

test("a platform probe that throws reports unavailable, never available", async () => {
  for (const op of ["hasHardware", "isEnrolled"] as const) {
    const module = new FakeLocalAuthentication();
    module.failOn(op, new Error("native module missing"));
    const authenticator = createExpoBiometricAuthenticator({ module });

    assert.equal(await authenticator.isAvailable(), false, op);
  }
});

test("an accepted biometric check unlocks", async () => {
  const module = new FakeLocalAuthentication();
  const authenticator = createExpoBiometricAuthenticator({ module });

  assert.equal(await authenticator.authenticate({ reason: "Send to the host" }), "unlocked");
});

test("the shell's prompt copy reaches the OS prompt unedited", async () => {
  const module = new FakeLocalAuthentication();
  const authenticator = createExpoBiometricAuthenticator({ module });

  await authenticator.authenticate({ reason: "Confirm terminate" });
  assert.deepEqual(module.prompts.map((prompt) => prompt.promptMessage), ["Confirm terminate"]);
});

test("the device passcode is not offered as a substitute for the biometric check", async () => {
  const module = new FakeLocalAuthentication();
  const authenticator = createExpoBiometricAuthenticator({ module });

  await authenticator.authenticate({ reason: "Confirm input" });
  assert.deepEqual(module.prompts.map((prompt) => prompt.disableDeviceFallback), [true]);
});

test("the device fallback opens only when the wiring site asks for it in writing", async () => {
  const module = new FakeLocalAuthentication();

  await createExpoBiometricAuthenticator({ module, allowDeviceFallback: true })
    .authenticate({ reason: "Confirm input" });
  // Anything other than an explicit `true` keeps the guard closed, including the
  // `undefined` an optional flag arrives as when a caller forwards a missing one.
  await createExpoBiometricAuthenticator({ module, allowDeviceFallback: undefined })
    .authenticate({ reason: "Confirm input" });

  assert.deepEqual(module.prompts.map((prompt) => prompt.disableDeviceFallback), [false, true]);
});

test("the module's failure strings map onto the port's outcomes", async () => {
  const expected: ReadonlyArray<readonly [string, NativeBiometricUnlockOutcome]> = [
    ["not_available", "unavailable"],
    ["passcode_not_set", "unavailable"],
    ["missing_usage_description", "unavailable"],
    ["invalid_context", "unavailable"],
    ["not_enrolled", "not-enrolled"],
    ["lockout", "locked-out"],
    ["lockout_permanent", "locked-out"],
    ["user_cancel", "denied"],
    ["app_cancel", "denied"],
    ["system_cancel", "denied"],
    ["authentication_failed", "denied"],
    ["user_fallback", "denied"],
    ["unknown", "denied"],
  ];

  for (const [error, outcome] of expected) {
    const module = new FakeLocalAuthentication();
    module.result = { success: false, error };
    const authenticator = createExpoBiometricAuthenticator({ module });

    assert.equal(await authenticator.authenticate({ reason: "Confirm start" }), outcome, error);
  }
});

test("an error string this adapter has never seen denies rather than escaping unclassified", async () => {
  const module = new FakeLocalAuthentication();
  module.result = { success: false, error: "some_future_expo_failure" };
  const authenticator = createExpoBiometricAuthenticator({ module });

  assert.equal(await authenticator.authenticate({ reason: "Confirm resize" }), "denied");
});

test("a platform call that throws denies the write instead of authorising it", async () => {
  const module = new FakeLocalAuthentication();
  module.failOn("authenticate", new Error("native module missing"));
  const authenticator = createExpoBiometricAuthenticator({ module });

  assert.equal(await authenticator.authenticate({ reason: "Confirm close" }), "denied");
});

/**
 * The fail-closed regression the write gate depends on, stated over the whole
 * failure surface at once: whatever the platform does short of an explicit
 * `success: true`, the adapter never answers `unlocked`. A gate that receives
 * anything else refuses the write (`biometric-write-gate.ts`), so this single
 * assertion is what keeps an adapter defect from becoming an unconfirmed write.
 */
test("no failure path can ever produce an unlock", async () => {
  const failures: ExpoLocalAuthenticationResult[] = [
    { success: false, error: "user_cancel" },
    { success: false, error: "lockout" },
    { success: false, error: "not_enrolled" },
    { success: false, error: "" },
    // Shapes a future or mismatched module version could return; `success` is
    // checked positively, so none of them reads as an unlock.
    { success: false } as unknown as ExpoLocalAuthenticationResult,
    {} as unknown as ExpoLocalAuthenticationResult,
    { success: "true" } as unknown as ExpoLocalAuthenticationResult,
    { success: 1 } as unknown as ExpoLocalAuthenticationResult,
  ];

  for (const result of failures) {
    const module = new FakeLocalAuthentication();
    module.result = result;
    const authenticator = createExpoBiometricAuthenticator({ module });

    assert.notEqual(
      await authenticator.authenticate({ reason: "Confirm input" }),
      "unlocked",
      JSON.stringify(result),
    );
  }

  const throwing = new FakeLocalAuthentication();
  throwing.failOn("authenticate", new Error("native module missing"));
  assert.notEqual(
    await createExpoBiometricAuthenticator({ module: throwing })
      .authenticate({ reason: "Confirm input" }),
    "unlocked",
  );
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

test("the composition binds expo-local-authentication to the core's BiometricAuthenticatorPort", async () => {
  const source = await readFile(runtimeFile, "utf8");
  assert.match(source, /import \* as LocalAuthentication from "expo-local-authentication"/);
  const body = source.slice(source.indexOf("export function createReactNativeBiometricAuthenticator"));
  // The annotated return type is the only compile-time proof that the adapter's
  // locally restated shape still matches the core port.
  assert.match(body, /\)\s*:\s*BiometricAuthenticatorPort\s*\{/);
  assert.match(body, /createExpoBiometricAuthenticator\(/);
});

test("the native package declares the local-authentication dependency it now imports", async () => {
  const manifest = JSON.parse(await readFile(path.join(nativeRoot, "package.json"), "utf8")) as Readonly<{
    dependencies?: Readonly<Record<string, string>>;
  }>;
  assert.ok(
    (manifest.dependencies ?? {})["expo-local-authentication"],
    "native-runtime imports expo-local-authentication but package.json does not declare it",
  );
});
