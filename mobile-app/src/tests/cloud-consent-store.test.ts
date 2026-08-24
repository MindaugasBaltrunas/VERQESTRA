import assert from "node:assert/strict";
import test from "node:test";
import { SecureCloudConsentStore } from "../adapters/speech/cloud-consent-store.js";
import type { SecureStoreKey, SecureStorePort } from "../model/ports.js";

// The stored grant that decides whether audio may leave the device. Every case
// here is the same question asked twice: does this blob mean the operator said
// yes? Anything but the exact marker must answer no.

const consentKey: SecureStoreKey = "speech.cloud-consent";

type StoreCall = Readonly<{ op: "read" | "write" | "delete"; key: SecureStoreKey; value?: string }>;

class MemorySecureStore implements SecureStorePort {
  readonly calls: StoreCall[] = [];
  readonly values = new Map<SecureStoreKey, string>();
  /** Models a keystore that is locked, corrupt or otherwise unreadable. */
  readFails = false;

  async readSecret(key: SecureStoreKey): Promise<string | null> {
    this.calls.push({ op: "read", key });
    if (this.readFails) throw new Error("keystore is locked");
    return this.values.get(key) ?? null;
  }

  async writeSecret(key: SecureStoreKey, value: string): Promise<void> {
    this.calls.push({ op: "write", key, value });
    this.values.set(key, value);
  }

  async deleteSecret(key: SecureStoreKey): Promise<void> {
    this.calls.push({ op: "delete", key });
    this.values.delete(key);
  }
}

test("only the exact stored marker reads back as consent", async () => {
  const store = new MemorySecureStore();
  const consent = new SecureCloudConsentStore(store);

  store.values.set(consentKey, "granted");
  assert.equal(await consent.readCloudConsent(), true);

  // Every shape a legacy encoding, a truncated write or a hand-edited keystore
  // could leave behind. None of them is the operator saying yes.
  for (const blob of ["true", "1", "yes", "", " granted", "granted ", "Granted", "GRANTED", "gran", "denied", "{\"granted\":true}"]) {
    store.values.set(consentKey, blob);
    assert.equal(await consent.readCloudConsent(), false, `"${blob}" was read as consent`);
  }

  store.values.delete(consentKey);
  assert.equal(await consent.readCloudConsent(), false);
});

test("a keystore that cannot be read has not recorded a grant", async () => {
  const store = new MemorySecureStore();
  store.values.set(consentKey, "granted");
  store.readFails = true;
  const consent = new SecureCloudConsentStore(store);

  assert.equal(await consent.readCloudConsent(), false);
  assert.equal(store.calls.filter((call) => call.op === "read").length, 1);
});

test("consent is written to its own slot and revoking deletes it rather than marking a refusal", async () => {
  const store = new MemorySecureStore();
  const consent = new SecureCloudConsentStore(store);

  await consent.writeCloudConsent(true);
  assert.deepEqual(store.calls, [{ op: "write", key: consentKey, value: "granted" }]);
  assert.equal(store.values.get(consentKey), "granted");
  assert.equal(await consent.readCloudConsent(), true);

  await consent.writeCloudConsent(false);
  assert.deepEqual(store.calls.at(-1), { op: "delete", key: consentKey });
  // Absence and refusal must be indistinguishable: no "denied" blob is left for
  // a future reader to interpret.
  assert.equal(store.values.has(consentKey), false);
  assert.equal(await consent.readCloudConsent(), false);

  // Revoking a consent that was never given is not an error either.
  await consent.writeCloudConsent(false);
  assert.equal(await consent.readCloudConsent(), false);
});

test("the consent store touches no slot but its own", async () => {
  const store = new MemorySecureStore();
  const consent = new SecureCloudConsentStore(store);

  await consent.writeCloudConsent(true);
  await consent.readCloudConsent();
  await consent.writeCloudConsent(false);

  for (const call of store.calls) {
    assert.equal(call.key, consentKey);
  }
  assert.ok(store.calls.length >= 3);
});

test("the stored grant is re-read for every question, never cached in the adapter", async () => {
  const store = new MemorySecureStore();
  const consent = new SecureCloudConsentStore(store);

  await consent.writeCloudConsent(true);
  assert.equal(await consent.readCloudConsent(), true);

  // Withdrawn behind this instance's back — in settings, or on another screen.
  store.values.delete(consentKey);
  assert.equal(await consent.readCloudConsent(), false);
});
