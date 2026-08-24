import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";
import {
  DeviceProofError,
  DeviceProofSigner,
  nonceByteLength,
} from "../adapters/device-identity/device-proof-signer.js";
import { SecureDeviceIdentity } from "../adapters/secure-storage/secure-device-identity.js";
import type {
  DeviceCryptoPort,
  DeviceKeyPort,
  SecureStoreKey,
  SecureStorePort,
} from "../model/ports.js";

const deviceId = "123e4567-e89b-42d3-a456-426614174050";
const alias = "ag-device-key-0001";
const refreshToken = "refresh-token-value-000000001";

/**
 * The gateway's own hash, reproduced here from `device-auth-service.ts` rather
 * than imported: a test that computed the digest with the production code could
 * not notice the two drifting apart.
 */
function gatewayDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function storeWith(seed: Partial<Record<SecureStoreKey, string>>): SecureStorePort {
  const slots = new Map(Object.entries(seed) as Array<[SecureStoreKey, string]>);
  return {
    async readSecret(key) {
      return slots.get(key) ?? null;
    },
    async writeSecret(key, value) {
      slots.set(key, value);
    },
    async deleteSecret(key) {
      slots.delete(key);
    },
  };
}

function fakeCrypto(nonces: readonly string[]): {
  port: DeviceCryptoPort;
  randomCalls: number[];
  hashed: string[];
} {
  const randomCalls: number[] = [];
  const hashed: string[] = [];
  let index = 0;
  return {
    port: {
      async randomBase64Url(byteLength) {
        randomCalls.push(byteLength);
        const value = nonces[Math.min(index, nonces.length - 1)] as string;
        index += 1;
        return value;
      },
      async sha256Base64Url(value) {
        hashed.push(value);
        return gatewayDigest(value);
      },
    },
    randomCalls,
    hashed,
  };
}

function keyPair(): {
  port: DeviceKeyPort;
  transcripts: string[];
  publicKeyDer: Buffer;
} {
  const pair = generateKeyPairSync("ed25519");
  const transcripts: string[] = [];
  return {
    port: {
      async createDeviceKey() {
        return Object.freeze({
          alias,
          publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        });
      },
      async signTranscript(input) {
        transcripts.push(input.transcript);
        return sign(null, Buffer.from(input.transcript, "utf8"), pair.privateKey)
          .toString("base64url");
      },
      async deleteDeviceKey() {},
    },
    transcripts,
    publicKeyDer: pair.publicKey.export({ format: "der", type: "spki" }),
  };
}

test("the refresh transcript is byte-identical to the one the gateway verifies", async () => {
  const nonce = "cmVmcmVzaC1ub25jZS12YWx1ZS0wMDAwMDAwMDAwMQ";
  const keys = keyPair();
  const crypto = fakeCrypto([nonce]);
  const signer = new DeviceProofSigner(
    new SecureDeviceIdentity(storeWith({ "device.key-alias": alias }), keys.port),
    keys.port,
    crypto.port,
  );

  const proof = await signer.createRefreshProof({ deviceId, generation: 3, refreshToken });

  // Literal, not a recomputation through the production join: a test that
  // rebuilt the transcript the same way could not catch a change in it.
  const expected = `ag-refresh-v1\n${deviceId}\n${gatewayDigest(refreshToken)}\n${nonce}\n3`;
  assert.equal(keys.transcripts.length, 1);
  assert.equal(keys.transcripts[0], expected);
  // The raw token is hashed, never transcribed.
  assert.doesNotMatch(expected, /refresh-token-value/);

  // Ed25519 verification with the gateway's own primitive closes the loop.
  assert.ok(verify(
    null,
    Buffer.from(expected, "utf8"),
    { key: keys.publicKeyDer, format: "der", type: "spki" },
    Buffer.from(proof.proof, "base64url"),
  ));
  assert.equal(proof.nonce, nonce);
  assert.ok(Object.isFrozen(proof));
  assert.deepEqual(crypto.randomCalls, [nonceByteLength]);
  assert.deepEqual(crypto.hashed, [refreshToken]);
});

test("every refresh gets its own nonce", async () => {
  const first = "bm9uY2UtdmFsdWUtZmlyc3QtMDAwMDAwMDAwMDAwMDA";
  const second = "bm9uY2UtdmFsdWUtc2Vjb25kLTAwMDAwMDAwMDAwMDA";
  const keys = keyPair();
  const signer = new DeviceProofSigner(
    new SecureDeviceIdentity(storeWith({ "device.key-alias": alias }), keys.port),
    keys.port,
    fakeCrypto([first, second]).port,
  );

  const one = await signer.createRefreshProof({ deviceId, generation: 1, refreshToken });
  const two = await signer.createRefreshProof({ deviceId, generation: 1, refreshToken });
  assert.notEqual(one.nonce, two.nonce);
  assert.notEqual(one.proof, two.proof);
});

test("a device with no key signs nothing", async () => {
  const keys = keyPair();
  const signer = new DeviceProofSigner(
    new SecureDeviceIdentity(storeWith({}), keys.port),
    keys.port,
    fakeCrypto(["bm9uY2UtdmFsdWUtZmlyc3QtMDAwMDAwMDAwMDAwMDA"]).port,
  );

  await assert.rejects(
    signer.createRefreshProof({ deviceId, generation: 1, refreshToken }),
    (error: unknown) => error instanceof DeviceProofError && error.code === "not_paired",
  );
  assert.deepEqual(keys.transcripts, []);
});

test("a degraded randomness source fails before a signature exists", async () => {
  for (const weak of ["short", "nonce with spaces in it and more", ""]) {
    const keys = keyPair();
    const signer = new DeviceProofSigner(
      new SecureDeviceIdentity(storeWith({ "device.key-alias": alias }), keys.port),
      keys.port,
      fakeCrypto([weak]).port,
    );
    await assert.rejects(
      signer.createRefreshProof({ deviceId, generation: 1, refreshToken }),
      (error: unknown) => error instanceof DeviceProofError && error.code === "weak_nonce",
      weak,
    );
    assert.deepEqual(keys.transcripts, [], weak);
  }
});

test("a signature the gateway would reject is rejected here first", async () => {
  const keys = keyPair();
  const truncating: DeviceKeyPort = {
    ...keys.port,
    async signTranscript(input) {
      const full = await keys.port.signTranscript(input);
      return full.slice(0, 40);
    },
  };
  const signer = new DeviceProofSigner(
    new SecureDeviceIdentity(storeWith({ "device.key-alias": alias }), truncating),
    truncating,
    fakeCrypto(["bm9uY2UtdmFsdWUtZmlyc3QtMDAwMDAwMDAwMDAwMDA"]).port,
  );

  await assert.rejects(
    signer.createRefreshProof({ deviceId, generation: 1, refreshToken }),
    (error: unknown) => error instanceof DeviceProofError && error.code === "invalid_signature",
  );
});

test("no failure message carries the refresh token", async () => {
  const keys = keyPair();
  const signer = new DeviceProofSigner(
    new SecureDeviceIdentity(storeWith({}), keys.port),
    keys.port,
    fakeCrypto(["short"]).port,
  );
  await signer.createRefreshProof({ deviceId, generation: 1, refreshToken }).then(
    () => assert.fail("expected a rejection"),
    (error: unknown) => {
      assert.ok(error instanceof DeviceProofError);
      assert.doesNotMatch(`${error.message} ${String(error)}`, /refresh-token-value/);
    },
  );
});
