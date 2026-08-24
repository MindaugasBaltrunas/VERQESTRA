import assert from "node:assert/strict";
import test from "node:test";
import {
  maxCredentialBytes,
  SecureCredentialStore,
  SecureStorageError,
} from "../adapters/secure-storage/secure-credential-store.js";
import {
  DeviceIdentityError,
  SecureDeviceIdentity,
} from "../adapters/secure-storage/secure-device-identity.js";
import type {
  DeviceCredential,
  DeviceKeyPort,
  SecureStoreKey,
  SecureStorePort,
} from "../model/ports.js";

const deviceId = "123e4567-e89b-42d3-a456-426614174040";

const credential: DeviceCredential = Object.freeze({
  deviceId,
  generation: 1,
  accessToken: "eyJhbGciOiJIUzI1NiJ9.c2lnbmF0dXJlLXZhbHVl",
  accessExpiresAt: "2026-07-26T12:15:00.000Z",
  refreshToken: "refresh-token-value-000000001",
  refreshExpiresAt: "2026-08-25T12:00:00.000Z",
});

function fakeStore(seed: Partial<Record<SecureStoreKey, string>> = {}): {
  port: SecureStorePort;
  slots: Map<SecureStoreKey, string>;
  writes: SecureStoreKey[];
  deletes: SecureStoreKey[];
} {
  const slots = new Map<SecureStoreKey, string>(
    Object.entries(seed) as Array<[SecureStoreKey, string]>,
  );
  const writes: SecureStoreKey[] = [];
  const deletes: SecureStoreKey[] = [];
  return {
    port: {
      async readSecret(key) {
        return slots.get(key) ?? null;
      },
      async writeSecret(key, value) {
        writes.push(key);
        slots.set(key, value);
      },
      async deleteSecret(key) {
        deletes.push(key);
        slots.delete(key);
      },
    },
    slots,
    writes,
    deletes,
  };
}

test("a stored credential round-trips with exactly the six persisted fields", async () => {
  const store = fakeStore();
  const credentials = new SecureCredentialStore(store.port);

  await credentials.storeDeviceCredential(credential);
  assert.deepEqual(store.writes, ["device.credential"]);
  assert.deepEqual(
    Object.keys(JSON.parse(store.slots.get("device.credential") as string) as object).sort(),
    [
      "accessExpiresAt",
      "accessToken",
      "deviceId",
      "generation",
      "refreshExpiresAt",
      "refreshToken",
    ],
  );

  const loaded = await credentials.loadDeviceCredential();
  assert.deepEqual(loaded, credential);
  assert.ok(Object.isFrozen(loaded));
});

test("a field the credential does not own never reaches the keystore", async () => {
  const store = fakeStore();
  const credentials = new SecureCredentialStore(store.port);

  await credentials.storeDeviceCredential({
    ...credential,
    // A caller that smuggles key material in must not be able to persist it.
    privateKey: "MC4CAQAwBQYDK2VwBCIEIHIDDEN",
    oneTimeCode: "one-time-code-value",
  } as DeviceCredential);

  const written = store.slots.get("device.credential") as string;
  assert.doesNotMatch(written, /privateKey|HIDDEN|oneTimeCode/);
});

test("an unpaired device reads as unpaired rather than as an error", async () => {
  const store = fakeStore();
  assert.equal(await new SecureCredentialStore(store.port).loadDeviceCredential(), null);
  assert.deepEqual(store.deletes, []);
});

test("every malformed stored credential reads as unpaired and is left in place", async () => {
  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["not JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"paired"'],
    ["a missing field", JSON.stringify({ ...credential, refreshToken: undefined })],
    ["an extra field", JSON.stringify({ ...credential, keyAlias: "ag-device-key" })],
    ["a non-UUID device", JSON.stringify({ ...credential, deviceId: "device-1" })],
    ["a zero generation", JSON.stringify({ ...credential, generation: 0 })],
    ["a fractional generation", JSON.stringify({ ...credential, generation: 1.5 })],
    ["a string generation", JSON.stringify({ ...credential, generation: "1" })],
    ["a malformed access token", JSON.stringify({ ...credential, accessToken: "opaque" })],
    ["an unparseable expiry", JSON.stringify({ ...credential, accessExpiresAt: "soon" })],
    ["a short refresh token", JSON.stringify({ ...credential, refreshToken: "short" })],
  ];

  for (const [label, raw] of malformed) {
    const store = fakeStore({ "device.credential": raw });
    const loaded = await new SecureCredentialStore(store.port).loadDeviceCredential();
    assert.equal(loaded, null, label);
    // A read must never destroy state: one bad decode would otherwise become
    // permanent data loss, and re-pairing overwrites the slot anyway.
    assert.deepEqual(store.deletes, [], label);
    assert.equal(store.slots.get("device.credential"), raw, label);
  }
});

test("an invalid credential is refused without touching the stored one", async () => {
  const store = fakeStore({ "device.credential": JSON.stringify(credential) });
  const credentials = new SecureCredentialStore(store.port);

  for (const invalid of [
    { ...credential, deviceId: "device-1" },
    { ...credential, generation: 0 },
    { ...credential, accessToken: "opaque-token" },
    { ...credential, accessExpiresAt: "later" },
    { ...credential, refreshToken: "short" },
    { ...credential, refreshExpiresAt: "" },
  ]) {
    await assert.rejects(
      credentials.storeDeviceCredential(invalid),
      (error: unknown) => error instanceof SecureStorageError &&
        error.code === "invalid_credential",
    );
  }
  assert.deepEqual(store.writes, []);
  // The working credential survived every rejected rotation.
  assert.deepEqual(await credentials.loadDeviceCredential(), credential);
});

test("an oversized credential fails loudly instead of being silently truncated", async () => {
  const store = fakeStore();
  await assert.rejects(
    new SecureCredentialStore(store.port).storeDeviceCredential({
      ...credential,
      refreshToken: "r".repeat(maxCredentialBytes),
    }),
    (error: unknown) => error instanceof SecureStorageError && error.code === "storage_limit",
  );
  assert.deepEqual(store.writes, []);
});

test("clearing tokens keeps the hardware identity a transient 401 did not invalidate", async () => {
  const store = fakeStore({
    "device.credential": JSON.stringify(credential),
    "device.key-alias": "ag-device-key-0001",
    "device.host-fingerprint": "sha256:1111111111111111",
  });
  await new SecureCredentialStore(store.port).clearDeviceCredential();

  assert.deepEqual(store.deletes, ["device.credential"]);
  assert.equal(store.slots.get("device.key-alias"), "ag-device-key-0001");
  assert.equal(store.slots.get("device.host-fingerprint"), "sha256:1111111111111111");
});

function fakeKeys(): { port: DeviceKeyPort; deleted: string[] } {
  const deleted: string[] = [];
  return {
    port: {
      async createDeviceKey() {
        return Object.freeze({ alias: "ag-device-key-0001", publicKey: "public-key-value-0001" });
      },
      async signTranscript() {
        return "s".repeat(86);
      },
      async deleteDeviceKey(alias) {
        deleted.push(alias);
      },
    },
    deleted,
  };
}

test("device identity refuses a malformed alias or fingerprint on the way in and out", async () => {
  const store = fakeStore();
  const keys = fakeKeys();
  const identity = new SecureDeviceIdentity(store.port, keys.port);

  await assert.rejects(
    identity.saveAlias("short"),
    (error: unknown) => error instanceof DeviceIdentityError && error.code === "invalid_alias",
  );
  await assert.rejects(
    identity.saveHostFingerprint("too short"),
    (error: unknown) => error instanceof DeviceIdentityError &&
      error.code === "invalid_fingerprint",
  );
  assert.deepEqual(store.writes, []);

  // A keystore whose contents were tampered with reads as unpaired, never as a
  // usable identity pointing at a slot no key lives in.
  const tampered = fakeStore({
    "device.key-alias": "x",
    "device.host-fingerprint": "sha256:with space here",
  });
  const tamperedIdentity = new SecureDeviceIdentity(tampered.port, keys.port);
  assert.equal(await tamperedIdentity.loadAlias(), null);
  assert.equal(await tamperedIdentity.loadHostFingerprint(), null);
});

test("forgetting a device destroys the key before the metadata that names it", async () => {
  const store = fakeStore();
  const keys = fakeKeys();
  const identity = new SecureDeviceIdentity(store.port, keys.port);

  await identity.saveAlias("ag-device-key-0001");
  await identity.saveHostFingerprint("sha256:1111111111111111");
  await identity.forget();

  assert.deepEqual(keys.deleted, ["ag-device-key-0001"]);
  assert.deepEqual(store.deletes, ["device.key-alias", "device.host-fingerprint"]);
  assert.equal(await identity.loadAlias(), null);
  assert.equal(await identity.loadHostFingerprint(), null);

  // Revocation handling calls this unconditionally, so a second pass must be a
  // no-op rather than an error.
  await identity.forget();
  assert.deepEqual(keys.deleted, ["ag-device-key-0001"]);
});
