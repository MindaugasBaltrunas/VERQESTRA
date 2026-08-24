import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceAuthService } from "../application/device-auth-service.js";
import { DeviceAuthError } from "../domain/device-auth.js";
import { AtomicJsonDeviceAuthStateStore } from "../infrastructure/atomic-json-device-auth-state-store.js";

function encodedPublicKey(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64url");
}

function signedProof(privateKey: KeyObject, transcript: string): string {
  return sign(null, Buffer.from(transcript), privateKey).toString("base64url");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

async function pairedFixture(directory: string, now = new Date("2026-07-26T10:00:00.000Z")) {
  const stateFile = join(directory, "device-auth.json");
  const store = new AtomicJsonDeviceAuthStateStore(stateFile);
  const service = new DeviceAuthService(store);
  const keys = generateKeyPairSync("ed25519");
  const devicePublicKey = encodedPublicKey(keys.publicKey);
  const challenge = await service.createPairingChallenge({
    hostFingerprint: "sha256:11111111111111111111111111111111",
    scopes: ["ag:read", "terminal:write"],
    now,
  });
  const nonce = "pairing-nonce-0001";
  const proof = signedProof(keys.privateKey, [
    "ag-pair-v1",
    challenge.challengeId,
    challenge.hostFingerprint,
    devicePublicKey,
    nonce,
  ].join("\n"));
  const paired = await service.redeemPairingChallenge({
    challengeId: challenge.challengeId,
    oneTimeCode: challenge.oneTimeCode,
    deviceName: "Owner phone",
    devicePublicKey,
    nonce,
    proof,
    now,
  });
  return { stateFile, store, service, keys, challenge, paired, now };
}

test("pairing stores only hashes, verifies Ed25519 and consumes once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-auth-"));
  try {
    const fixture = await pairedFixture(directory);
    const persisted = await readFile(fixture.stateFile, "utf8");
    assert.equal(persisted.includes(fixture.challenge.oneTimeCode), false);
    assert.equal(persisted.includes(fixture.paired.tokens.refreshToken), false);
    assert.equal(
      (await fixture.store.read()).challenges[fixture.challenge.challengeId]?.consumedAt,
      fixture.now.toISOString(),
    );
    await assert.rejects(
      fixture.service.redeemPairingChallenge({
        challengeId: fixture.challenge.challengeId,
        oneTimeCode: fixture.challenge.oneTimeCode,
        deviceName: "Replay",
        devicePublicKey: encodedPublicKey(fixture.keys.publicKey),
        nonce: "pairing-nonce-0001",
        proof: "invalid",
        now: fixture.now,
      }),
      (error: unknown) => error instanceof DeviceAuthError && error.code === "pairing_consumed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid device proof does not consume a pairing challenge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-auth-"));
  try {
    const stateFile = join(directory, "state.json");
    const service = new DeviceAuthService(new AtomicJsonDeviceAuthStateStore(stateFile));
    const challenge = await service.createPairingChallenge({
      hostFingerprint: "sha256:22222222222222222222222222222222",
      scopes: ["ag:read"],
    });
    const keys = generateKeyPairSync("ed25519");
    await assert.rejects(
      service.redeemPairingChallenge({
        challengeId: challenge.challengeId,
        oneTimeCode: challenge.oneTimeCode,
        deviceName: "Phone",
        devicePublicKey: encodedPublicKey(keys.publicKey),
        nonce: "pairing-nonce-0002",
        proof: Buffer.alloc(64).toString("base64url"),
      }),
      (error: unknown) => error instanceof DeviceAuthError && error.code === "invalid_device_proof",
    );
    assert.equal(
      (await new AtomicJsonDeviceAuthStateStore(stateFile).read())
        .challenges[challenge.challengeId]?.consumedAt,
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refresh rotation and reuse revocation invalidate prior access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-auth-"));
  try {
    const fixture = await pairedFixture(directory);
    const refreshNonce = "refresh-nonce-0001";
    const refreshProof = signedProof(fixture.keys.privateKey, [
      "ag-refresh-v1",
      fixture.paired.deviceId,
      hashSecret(fixture.paired.tokens.refreshToken),
      refreshNonce,
      "1",
    ].join("\n"));
    const rotated = await fixture.service.refresh({
      deviceId: fixture.paired.deviceId,
      refreshToken: fixture.paired.tokens.refreshToken,
      nonce: refreshNonce,
      proof: refreshProof,
      now: new Date("2026-07-26T10:01:00.000Z"),
    });
    assert.notEqual(rotated.refreshToken, fixture.paired.tokens.refreshToken);
    assert.equal(
      (await fixture.service.authenticateAccessToken(
        rotated.accessToken,
        new Date("2026-07-26T10:01:00.000Z"),
      )).deviceId,
      fixture.paired.deviceId,
    );

    await assert.rejects(
      fixture.service.refresh({
        deviceId: fixture.paired.deviceId,
        refreshToken: fixture.paired.tokens.refreshToken,
        nonce: refreshNonce,
        proof: Buffer.alloc(64).toString("base64url"),
        now: new Date("2026-07-26T10:01:30.000Z"),
      }),
      (error: unknown) => error instanceof DeviceAuthError && error.code === "invalid_device_proof",
    );
    assert.equal(
      (await fixture.store.read()).devices[fixture.paired.deviceId]?.generation,
      1,
    );
    await assert.rejects(
      fixture.service.refresh({
        deviceId: fixture.paired.deviceId,
        refreshToken: fixture.paired.tokens.refreshToken,
        nonce: refreshNonce,
        proof: refreshProof,
        now: new Date("2026-07-26T10:02:00.000Z"),
      }),
      (error: unknown) => error instanceof DeviceAuthError && error.code === "refresh_token_reuse",
    );
    const state = await fixture.store.read();
    assert.equal(state.devices[fixture.paired.deviceId]?.generation, 2);
    assert.equal(
      Object.values(state.refreshTokens).every((record) => record.status === "revoked"),
      true,
    );
    await assert.rejects(
      fixture.service.authenticateAccessToken(rotated.accessToken),
      (error: unknown) => error instanceof DeviceAuthError && error.code === "invalid_access_token",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("device revocation survives restart and invalidates credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-auth-"));
  try {
    const fixture = await pairedFixture(directory);
    await fixture.service.revokeDevice(fixture.paired.deviceId, new Date("2026-07-26T10:03:00.000Z"));
    const restarted = new DeviceAuthService(new AtomicJsonDeviceAuthStateStore(fixture.stateFile));
    await assert.rejects(
      restarted.authenticateAccessToken(fixture.paired.tokens.accessToken, fixture.now),
      (error: unknown) => error instanceof DeviceAuthError && error.code === "invalid_access_token",
    );
    const refreshNonce = "refresh-nonce-0002";
    const refreshProof = signedProof(fixture.keys.privateKey, [
      "ag-refresh-v1",
      fixture.paired.deviceId,
      hashSecret(fixture.paired.tokens.refreshToken),
      refreshNonce,
      "1",
    ].join("\n"));
    await assert.rejects(
      restarted.refresh({
        deviceId: fixture.paired.deviceId,
        refreshToken: fixture.paired.tokens.refreshToken,
        nonce: refreshNonce,
        proof: refreshProof,
        now: fixture.now,
      }),
      (error: unknown) => error instanceof DeviceAuthError && error.code === "device_revoked",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("access tokens reject expiry and tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-auth-"));
  try {
    const fixture = await pairedFixture(directory);
    await assert.rejects(
      fixture.service.authorizeAccessToken(
        fixture.paired.tokens.accessToken,
        "github:write",
        fixture.now,
      ),
      (error: unknown) => error instanceof DeviceAuthError && error.code === "insufficient_scope",
    );
    assert.equal(
      (await fixture.service.authorizeAccessToken(
        fixture.paired.tokens.accessToken,
        "ag:read",
        fixture.now,
      )).deviceId,
      fixture.paired.deviceId,
    );
    await assert.rejects(
      fixture.service.authenticateAccessToken(
        fixture.paired.tokens.accessToken,
        new Date("2026-07-26T10:15:00.000Z"),
      ),
      (error: unknown) => error instanceof DeviceAuthError && error.code === "access_token_expired",
    );
    const tampered = `${fixture.paired.tokens.accessToken.slice(0, -1)}x`;
    await assert.rejects(
      fixture.service.authenticateAccessToken(tampered, fixture.now),
      (error: unknown) => error instanceof DeviceAuthError && error.code === "invalid_access_token",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
