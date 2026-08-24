import assert from "node:assert/strict";
import { verify } from "node:crypto";
import test from "node:test";
import { pairingNonceByteLength, PairingError } from "../controller/pairing-controller.js";
import {
  accessToken,
  challengeId,
  deviceId,
  gatewayBaseUrl,
  harness,
  hostFingerprint,
  jsonObject,
  nonce,
  oneTimeCode,
  pairInput,
  principalId,
  redeemBody,
  refreshToken,
  type Harness,
} from "./pairing-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; žr. `pairing-doubles.ts`). Čia — ATPIRKIMAS: ką
 * įrenginys pasirašo, ką iš atsakymo priima ir ką atsuka, kai kas nors nepavyksta po to, kai
 * kodas jau paliko telefoną. Vietiniai atmetimai — `pairing-controller.test.ts`.
 */

test("pairing signs the gateway's canonical transcript and persists only what it issued", async () => {
  const value = harness();
  const result = await value.controller.pair(pairInput);

  assert.deepEqual(result, { deviceId, principalId, hostFingerprint });

  // Literal transcript, not a recomputation: this is the exact byte string the
  // gateway rebuilds and verifies.
  const expected = [
    "ag-pair-v1",
    challengeId,
    hostFingerprint,
    value.publicKeyDer.toString("base64url"),
    nonce,
  ].join("\n");
  assert.deepEqual(value.transcripts, [expected]);
  assert.ok(verify(
    null,
    Buffer.from(expected, "utf8"),
    { key: value.publicKeyDer, format: "der", type: "spki" },
    Buffer.from(value.proofs[0] as string, "base64url"),
  ));

  assert.equal(value.requests.length, 1);
  const request = value.requests[0];
  assert.equal(request?.method, "POST");
  assert.equal(request?.url, `${gatewayBaseUrl}/pairing-challenges/${challengeId}/redeem`);
  // The route is unauthenticated and single-use: neither header belongs on it.
  assert.equal(request?.headers["Authorization"], undefined);
  assert.equal(request?.headers["Idempotency-Key"], undefined);
  const body = jsonObject(request?.body);
  assert.deepEqual(
    Object.keys(body).sort(),
    ["deviceName", "devicePublicKey", "nonce", "oneTimeCode", "proof"],
  );
  assert.equal(body["deviceName"], "Operator phone");
  // 32 random bytes are 43 unpadded base64url characters; asserting the shape
  // rather than a length keeps this from reading as an entropy floor it is not.
  assert.equal(body["nonce"], nonce);
  assert.equal(Buffer.from(nonce, "base64url").length, pairingNonceByteLength);

  assert.equal(value.slots.get("device.key-alias"), "ag-device-key-0001");
  assert.equal(value.slots.get("device.host-fingerprint"), hostFingerprint);
  const stored = jsonObject(value.slots.get("device.credential"));
  assert.deepEqual(stored, {
    deviceId,
    generation: 1,
    accessToken,
    accessExpiresAt: "2026-07-26T12:15:00.000Z",
    refreshToken,
    refreshExpiresAt: "2026-08-25T12:00:00.000Z",
  });
  assert.deepEqual(value.deletedKeys, []);
});

test("a gateway answer the contract does not describe stores nothing", async () => {
  const responses: ReadonlyArray<readonly [string, string]> = [
    ["an extra field", redeemBody({ scopes: ["terminal:write"] })],
    ["a missing token set", JSON.stringify({ deviceId, principalId, hostFingerprint })],
    ["a non-UUID device", redeemBody({ deviceId: "device-1" })],
    ["an opaque access token", JSON.stringify({
      deviceId,
      principalId,
      hostFingerprint,
      tokens: {
        accessToken: "opaque",
        accessExpiresAt: "2026-07-26T12:15:00.000Z",
        refreshToken,
        refreshExpiresAt: "2026-08-25T12:00:00.000Z",
      },
    })],
    ["an extra token field", JSON.stringify({
      deviceId,
      principalId,
      hostFingerprint,
      tokens: {
        accessToken,
        accessExpiresAt: "2026-07-26T12:15:00.000Z",
        refreshToken,
        refreshExpiresAt: "2026-08-25T12:00:00.000Z",
        scope: "terminal:write",
      },
    })],
    ["a non-object body", "[]"],
  ];
  for (const [label, body] of responses) {
    const value = harness({ respond: () => ({ status: 200, body }) });
    await assert.rejects(
      value.controller.pair(pairInput),
      (error: unknown) => error instanceof PairingError && error.code === "invalid_response",
      label,
    );
    assert.equal(value.slots.get("device.credential"), undefined, label);
    assert.deepEqual(value.deletedKeys, ["ag-device-key-0001"], label);
  }
});

test("a gateway that answers for another host is discarded, key and all", async () => {
  const value = harness({
    respond: () => ({ status: 200, body: redeemBody({ hostFingerprint: "sha256:7777777777777777" }) }),
  });
  await assert.rejects(
    value.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError && error.code === "host_mismatch",
  );
  assert.equal(value.slots.get("device.credential"), undefined);
  assert.equal(value.slots.get("device.key-alias"), undefined);
  assert.deepEqual(value.deletedKeys, ["ag-device-key-0001"]);
});

test("each rejection status maps to its own outcome and destroys the key", async () => {
  const cases: ReadonlyArray<readonly [number, string, boolean]> = [
    [400, "invalid_invite", false],
    [401, "rejected", false],
    [403, "rejected", false],
    [409, "code_consumed", false],
    [429, "rate_limited", true],
    [503, "transport_failed", true],
  ];
  for (const [status, code, recoverable] of cases) {
    const value = harness({ respond: () => ({ status, body: '{"error":{"code":"nope"}}' }) });
    await assert.rejects(
      value.controller.pair(pairInput),
      (error: unknown) => error instanceof PairingError &&
        error.code === code &&
        error.recoverable === recoverable,
      `${status}`,
    );
    assert.deepEqual(value.deletedKeys, ["ag-device-key-0001"], `${status}`);
    assert.equal(value.slots.get("device.credential"), undefined, `${status}`);
  }
});

test("a code that reached the host is never sent a second time", async () => {
  const value = harness({ respond: () => ({ status: 409, body: "{}" }) });
  await assert.rejects(
    value.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError && error.code === "code_consumed",
  );
  await assert.rejects(
    value.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError && error.code === "code_consumed",
  );
  // Exactly one attempt left the device.
  assert.equal(value.requests.length, 1);

  // A rate limit is the one answer that proves the host did not look at the
  // code, so that attempt stays retryable.
  const limited = harness({
    respond: (call) => call === 1
      ? { status: 429, body: "{}" }
      : { status: 200, body: redeemBody() },
  });
  await assert.rejects(
    limited.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError && error.code === "rate_limited",
  );
  await limited.controller.pair(pairInput);
  assert.equal(limited.requests.length, 2);
  // The retry used a freshly generated key, never the destroyed one.
  assert.deepEqual(limited.deletedKeys, ["ag-device-key-0001"]);
  assert.equal(limited.slots.get("device.key-alias"), "ag-device-key-0002");
});

test("a request that may never have arrived stays retryable and burns nothing", async () => {
  const value = harness({ transportThrows: true });
  await assert.rejects(
    value.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError &&
      error.code === "transport_failed" &&
      error.recoverable === true,
  );
  assert.deepEqual(value.deletedKeys, ["ag-device-key-0001"]);
  assert.equal(value.slots.size, 0);
});

test("a keystore that cannot store the credential leaves no half-paired device", async () => {
  const value = harness({ storeFails: true });
  await assert.rejects(
    value.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError && error.code === "storage_failed",
  );
  assert.deepEqual(value.deletedKeys, ["ag-device-key-0001"]);
  assert.equal(value.slots.size, 0, "alias and pinned host are rolled back too");
});

test("no pairing failure ever names a secret", async () => {
  const failures: ReadonlyArray<() => Harness> = [
    () => harness({ respond: () => ({ status: 409, body: "{}" }) }),
    () => harness({ respond: () => ({ status: 200, body: "{}" }) }),
    () => harness({ transportThrows: true }),
    () => harness({ storeFails: true }),
  ];
  for (const build of failures) {
    const value = build();
    await value.controller.pair(pairInput).then(
      () => assert.fail("expected a rejection"),
      (error: unknown) => {
        const text = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
        for (const secret of [oneTimeCode, accessToken, refreshToken, value.proofs[0] ?? "-"]) {
          assert.doesNotMatch(text, new RegExp(secret.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
      },
    );
  }
});
