import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createExpoSecureStoreAdapter,
  ExpoSecureStoreError,
} from "../adapters/expo-secure-store-adapter";
import type {
  ExpoSecureStoreModule,
  ExpoSecureStoreOptions,
} from "../adapters/expo-secure-store-adapter";

/**
 * Unlike every other suite in this package, this one imports its subject instead
 * of reading it as text. That is the whole point of the adapter's shape: it
 * names no Expo module, so `node --test` can drive it against a double and pin
 * real behaviour — roundtrip, the missing-key contract, and the rule that a
 * keystore failure is never swallowed — rather than pattern-matching source.
 *
 * The wiring assertions at the end still read source, because `native-runtime.ts`
 * does import `expo-secure-store` and cannot be loaded here.
 */

const nativeRoot = path.resolve(__dirname, "..", "..");
const adapterFile = path.join(nativeRoot, "src", "adapters", "expo-secure-store-adapter.ts");
const runtimeFile = path.join(nativeRoot, "src", "composition", "native-runtime.ts");

/** The real `SecureStoreKey` union from `mobile-app/src/model/ports.ts`. */
const secureStoreKeys = [
  "device.credential",
  "device.key-alias",
  "device.host-fingerprint",
  "speech.cloud-consent",
] as const;

/** Accessibility class stand-in; the real constant is an opaque number. */
const whenUnlockedThisDeviceOnly = 3;

type Call = Readonly<{
  op: "get" | "set" | "delete";
  key: string;
  value?: string;
  options?: ExpoSecureStoreOptions;
}>;

class FakeExpoSecureStore implements ExpoSecureStoreModule {
  readonly calls: Call[] = [];
  readonly items = new Map<string, string>();
  private readonly failures = new Map<Call["op"], Error>();

  failOn(op: Call["op"], error: Error): void {
    this.failures.set(op, error);
  }

  private record(call: Call): void {
    this.calls.push(call);
    const failure = this.failures.get(call.op);
    if (failure !== undefined) throw failure;
  }

  async getItemAsync(key: string, options?: ExpoSecureStoreOptions): Promise<string | null> {
    this.record({ op: "get", key, ...(options === undefined ? {} : { options }) });
    return this.items.get(key) ?? null;
  }

  async setItemAsync(key: string, value: string, options?: ExpoSecureStoreOptions): Promise<void> {
    this.record({ op: "set", key, value, ...(options === undefined ? {} : { options }) });
    this.items.set(key, value);
  }

  async deleteItemAsync(key: string, options?: ExpoSecureStoreOptions): Promise<void> {
    this.record({ op: "delete", key, ...(options === undefined ? {} : { options }) });
    this.items.delete(key);
  }
}

function adapterWith(module: ExpoSecureStoreModule, keychainService?: string) {
  return createExpoSecureStoreAdapter({
    module,
    keychainAccessible: whenUnlockedThisDeviceOnly,
    ...(keychainService === undefined ? {} : { keychainService }),
  });
}

test("a written secret reads back byte for byte", async () => {
  const module = new FakeExpoSecureStore();
  const store = adapterWith(module);

  await store.writeSecret("device.credential", '{"deviceId":"d-1","generation":2}');
  assert.equal(await store.readSecret("device.credential"), '{"deviceId":"d-1","generation":2}');
});

test("every slot of the core's key union roundtrips under the key it was given", async () => {
  const module = new FakeExpoSecureStore();
  const store = adapterWith(module);

  for (const key of secureStoreKeys) {
    await store.writeSecret(key, `value-for-${key}`);
  }
  for (const key of secureStoreKeys) {
    assert.equal(await store.readSecret(key), `value-for-${key}`);
  }
  // The dotted slot names must reach the keystore unchanged: a prefix or an
  // escaping pass here would strand every credential written by an earlier build.
  assert.deepEqual(
    module.calls.filter((call) => call.op === "set").map((call) => call.key),
    [...secureStoreKeys],
  );
});

test("a missing key is null, not an exception", async () => {
  const module = new FakeExpoSecureStore();
  const store = adapterWith(module);

  assert.equal(await store.readSecret("device.credential"), null);
});

test("a native undefined is normalised to the port's null", async () => {
  const module: ExpoSecureStoreModule = {
    async getItemAsync() {
      return undefined as unknown as string | null;
    },
    async setItemAsync() {
      return undefined;
    },
    async deleteItemAsync() {
      return undefined;
    },
  };

  assert.equal(await adapterWith(module).readSecret("device.credential"), null);
});

test("deleting removes the secret, and reading afterwards reports it absent", async () => {
  const module = new FakeExpoSecureStore();
  const store = adapterWith(module);

  await store.writeSecret("device.credential", "token");
  await store.deleteSecret("device.credential");

  assert.equal(await store.readSecret("device.credential"), null);
  assert.equal(module.items.has("device.credential"), false);
});

test("deleting an absent secret is not an error", async () => {
  const module = new FakeExpoSecureStore();
  const store = adapterWith(module);

  await store.deleteSecret("device.credential");
  await store.deleteSecret("device.credential");
});

test("a failed read raises instead of reporting the slot as empty", async () => {
  const module = new FakeExpoSecureStore();
  const cause = new Error("keychain decryption failed");
  module.failOn("get", cause);

  await assert.rejects(
    adapterWith(module).readSecret("device.credential"),
    (error: unknown) => {
      assert.ok(error instanceof ExpoSecureStoreError);
      assert.equal(error.operation, "read");
      assert.equal(error.key, "device.credential");
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test("a failed write raises and carries no secret value in its message", async () => {
  const module = new FakeExpoSecureStore();
  module.failOn("set", new Error("keystore unavailable"));

  await assert.rejects(
    adapterWith(module).writeSecret("device.credential", "super-secret-refresh-token"),
    (error: unknown) => {
      assert.ok(error instanceof ExpoSecureStoreError);
      assert.equal(error.operation, "write");
      // The value must not survive into anything loggable or reportable.
      assert.doesNotMatch(error.message, /super-secret-refresh-token/);
      assert.doesNotMatch(String(error.stack ?? ""), /super-secret-refresh-token/);
      return true;
    },
  );
});

test("a failed delete raises rather than pretending the secret is gone", async () => {
  const module = new FakeExpoSecureStore();
  module.failOn("delete", new Error("keystore unavailable"));

  await assert.rejects(
    adapterWith(module).deleteSecret("device.credential"),
    (error: unknown) => {
      assert.ok(error instanceof ExpoSecureStoreError);
      assert.equal(error.operation, "delete");
      return true;
    },
  );
});

test("writes carry the accessibility class the composition chose", async () => {
  const module = new FakeExpoSecureStore();
  await adapterWith(module).writeSecret("device.credential", "token");

  const write = module.calls.find((call) => call.op === "set");
  assert.ok(write, "no set call recorded");
  assert.equal(write.options?.keychainAccessible, whenUnlockedThisDeviceOnly);
});

test("reads and deletes claim no accessibility class, because they grant none", async () => {
  const module = new FakeExpoSecureStore();
  const store = adapterWith(module);

  await store.readSecret("device.credential");
  await store.deleteSecret("device.credential");

  for (const call of module.calls) {
    assert.equal(call.options?.keychainAccessible, undefined, `${call.op} passed an accessibility class`);
  }
});

test("a keychain service, when given, is used by write, read and delete alike", async () => {
  const module = new FakeExpoSecureStore();
  const store = adapterWith(module, "verqestra");

  await store.writeSecret("device.credential", "token");
  await store.readSecret("device.credential");
  await store.deleteSecret("device.credential");

  assert.equal(module.calls.length, 3);
  for (const call of module.calls) {
    // An item written under one service is invisible to a lookup under another,
    // so a service applied to writes alone would silently lose every credential.
    assert.equal(call.options?.keychainService, "verqestra", `${call.op} lost the keychain service`);
  }
});

test("no keychain service is passed when none was configured", async () => {
  const module = new FakeExpoSecureStore();
  await adapterWith(module).writeSecret("device.credential", "token");

  const write = module.calls.find((call) => call.op === "set");
  assert.ok(write, "no set call recorded");
  assert.equal(write.options?.keychainService, undefined);
});

test("the adapter imports no module at all, which is why this suite can load it", async () => {
  const source = await readFile(adapterFile, "utf8");
  assert.doesNotMatch(
    source,
    /^\s*import\s/m,
    "the adapter gained an import; it must stay loadable outside Metro",
  );
  assert.doesNotMatch(source, /require\(/);
});

test("the composition binds expo-secure-store to the core's SecureStorePort", async () => {
  const source = await readFile(runtimeFile, "utf8");
  assert.match(source, /import \* as SecureStore from "expo-secure-store"/);
  const body = source.slice(source.indexOf("export function createReactNativeSecureStore"));
  // The annotated return type is the only compile-time proof that the adapter's
  // locally restated shape still matches the core port.
  assert.match(body, /\)\s*:\s*SecureStorePort\s*\{/);
  assert.match(body, /createExpoSecureStoreAdapter\(/);
});

test("stored credentials are bound to this device and stay out of backups", async () => {
  const source = await readFile(runtimeFile, "utf8");
  const body = source.slice(source.indexOf("export function createReactNativeSecureStore"));
  assert.match(body, /keychainAccessible:\s*SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
});

test("the native package declares the secure-store dependency it now imports", async () => {
  const manifest = JSON.parse(await readFile(path.join(nativeRoot, "package.json"), "utf8")) as Readonly<{
    dependencies?: Readonly<Record<string, string>>;
  }>;
  assert.ok(
    (manifest.dependencies ?? {})["expo-secure-store"],
    "native-runtime imports expo-secure-store but package.json does not declare it",
  );
});
