import assert from "node:assert/strict";
import test from "node:test";
import {
  maxPairingInvitePayloadLength,
  PairingError,
  parsePairingInvite,
  type PairingInvite,
} from "../controller/pairing-controller.js";
import {
  accessToken,
  expiresAt,
  harness,
  hostFingerprint,
  invite,
  pairInput,
  refreshToken,
  deviceId,
} from "./pairing-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 533 eilutės). Čia — VIETINIAI
 * ATMETIMAI: viskas, kas nusprendžiama PRIEŠ vienkartiniam kodui paliekant įrenginį. Tinklo
 * mainai, atsakymo tikrinimas ir atsukimas — `pairing-redeem.test.ts`; bendra fikstūra —
 * `pairing-doubles.ts`.
 *
 * Šio pjūvio esmė: kiekvienas testas žemiau baigiasi tuo pačiu teiginiu — `requests` tuščias ir
 * `keyCreations` nulis. Raktas nesukuriamas, kol host'as nepripažintas.
 */

test("a valid invite parses, and every malformed one is refused the same way", () => {
  const parsed = parsePairingInvite(JSON.stringify(invite));
  assert.deepEqual(parsed, invite);
  assert.ok(Object.isFrozen(parsed));

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["not JSON", "{"],
    ["an array", "[]"],
    ["an extra field", JSON.stringify({ ...invite, scopes: ["terminal:write"] })],
    ["a missing field", JSON.stringify({ ...invite, expiresAt: undefined })],
    ["plain HTTP", JSON.stringify({ ...invite, gatewayBaseUrl: "http://pc.private.test/v1" })],
    ["a path", JSON.stringify({ ...invite, gatewayBaseUrl: "https://pc.private.test/v1/auth" })],
    ["a query", JSON.stringify({ ...invite, gatewayBaseUrl: "https://pc.private.test/v1?x=1" })],
    ["no version", JSON.stringify({ ...invite, gatewayBaseUrl: "https://pc.private.test" })],
    ["a non-UUID challenge", JSON.stringify({ ...invite, challengeId: "challenge-1" })],
    ["a short code", JSON.stringify({ ...invite, oneTimeCode: "short-code" })],
    ["a short fingerprint", JSON.stringify({ ...invite, hostFingerprint: "sha256:1" })],
    ["a spaced fingerprint", JSON.stringify({ ...invite, hostFingerprint: "sha256 4444444444" })],
    ["an unparseable expiry", JSON.stringify({ ...invite, expiresAt: "soon" })],
    ["an oversized payload", `${JSON.stringify(invite)}${" ".repeat(maxPairingInvitePayloadLength)}`],
  ];
  for (const [label, raw] of rejected) {
    assert.throws(
      () => parsePairingInvite(raw),
      (error: unknown) => error instanceof PairingError && error.code === "invalid_invite",
      label,
    );
  }
});

test("an unconfirmed or wrongly pinned host never sees the one-time code", async () => {
  const unconfirmed = harness();
  await assert.rejects(
    unconfirmed.controller.pair({ ...pairInput, confirmedHostFingerprint: "sha256:9999999999999999" }),
    (error: unknown) => error instanceof PairingError && error.code === "host_mismatch",
  );
  assert.deepEqual(unconfirmed.requests, []);
  assert.equal(unconfirmed.keyCreations, 0, "no key is created before the host is pinned");

  const otherHost = harness({ seed: { "device.host-fingerprint": "sha256:8888888888888888" } });
  await assert.rejects(
    otherHost.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError && error.code === "host_mismatch",
  );
  assert.deepEqual(otherHost.requests, []);
  assert.equal(otherHost.keyCreations, 0);
});

test("an expired invite and an already paired device are refused locally", async () => {
  const expired = harness({ nowMs: Date.parse(expiresAt) });
  await assert.rejects(
    expired.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError && error.code === "invite_expired",
  );
  assert.deepEqual(expired.requests, []);
  assert.equal(expired.keyCreations, 0);

  const paired = harness({
    seed: {
      "device.credential": JSON.stringify({
        deviceId,
        generation: 1,
        accessToken,
        accessExpiresAt: "2026-07-26T12:15:00.000Z",
        refreshToken,
        refreshExpiresAt: "2026-08-25T12:00:00.000Z",
      }),
    },
  });
  await assert.rejects(
    paired.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError && error.code === "already_paired",
  );
  assert.deepEqual(paired.requests, []);
  assert.equal(paired.keyCreations, 0);
});

test("a failed attempt never erases a host pin it did not create", async () => {
  const value = harness({
    seed: { "device.host-fingerprint": hostFingerprint },
    respond: () => ({ status: 409, body: "{}" }),
  });
  await assert.rejects(
    value.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError && error.code === "code_consumed",
  );
  // Erasing the pin would silently disarm the "pinned to another host" guard,
  // so the next invite for a different host would be accepted.
  assert.equal(value.slots.get("device.host-fingerprint"), hostFingerprint);
  assert.equal(value.slots.get("device.key-alias"), undefined);

  const otherHost = harness({ seed: { "device.host-fingerprint": hostFingerprint } });
  await assert.rejects(
    otherHost.controller.pair({
      invite: { ...invite, hostFingerprint: "sha256:6666666666666666" },
      deviceName: "Operator phone",
      confirmedHostFingerprint: "sha256:6666666666666666",
    }),
    (error: unknown) => error instanceof PairingError && error.code === "host_mismatch",
  );
});

test("an invite that never went through the parser is validated again before use", async () => {
  const hostile: ReadonlyArray<readonly [string, PairingInvite]> = [
    ["a plain-HTTP gateway", { ...invite, gatewayBaseUrl: "http://attacker.test/v1" }],
    ["a traversing challenge id", { ...invite, challengeId: "../auth/refresh" }],
    ["an unparseable expiry", { ...invite, expiresAt: "whenever" }],
    ["a spaced fingerprint", { ...invite, hostFingerprint: "sha256 4444444444444" }],
    ["a short code", { ...invite, oneTimeCode: "short" }],
  ];
  for (const [label, forged] of hostile) {
    const value = harness();
    await assert.rejects(
      value.controller.pair({
        invite: forged,
        deviceName: "Operator phone",
        confirmedHostFingerprint: forged.hostFingerprint,
      }),
      (error: unknown) => error instanceof PairingError && error.code === "invalid_invite",
      label,
    );
    // Nothing left the device and no key was minted for it.
    assert.deepEqual(value.requests, [], label);
    assert.equal(value.keyCreations, 0, label);
  }
});

test("a leftover signing key blocks pairing instead of being orphaned", async () => {
  const value = harness({ seed: { "device.key-alias": "ag-device-key-9999" } });
  await assert.rejects(
    value.controller.pair(pairInput),
    (error: unknown) => error instanceof PairingError && error.code === "already_paired",
  );
  assert.equal(value.keyCreations, 0);
  assert.deepEqual(value.requests, []);
  // The stranded key is still addressable, so an explicit unpair can destroy it.
  await value.controller.unpair();
  assert.deepEqual(value.deletedKeys, ["ag-device-key-9999"]);
});

test("unpairing wipes the key, the pinned host and the tokens", async () => {
  const value = harness();
  await value.controller.pair(pairInput);
  await value.controller.unpair();

  assert.deepEqual(value.deletedKeys, ["ag-device-key-0001"]);
  assert.equal(value.slots.size, 0);
  // Revocation handling calls this unconditionally; a second pass is a no-op.
  await value.controller.unpair();
  assert.equal(value.slots.size, 0);
});
