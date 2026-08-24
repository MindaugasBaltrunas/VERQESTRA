import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { MobileHttpTransportPort } from "../adapters/network/gateway-http-client.js";
import { SecureCredentialStore } from "../adapters/secure-storage/secure-credential-store.js";
import { SecureDeviceIdentity } from "../adapters/secure-storage/secure-device-identity.js";
import { PairingController, type PairingInvite } from "../controller/pairing-controller.js";
import type {
  DeviceCryptoPort,
  DeviceKeyPort,
  SecureStoreKey,
  SecureStorePort,
} from "../model/ports.js";

/**
 * Shared doubles for the pairing suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `pairing-controller.test.ts` buvo 533 eilutės).
 * Fikstūra atskirai, nes `harness()` yra vienintelis apibrėžimas, kaip atrodo pilnas pakeitimas:
 * jame vienu metu matomi `requests`, `slots` ir `deletedKeys` — būtent tie trys, kuriais
 * vietinių atmetimų rinkinys tvirtina „NIEKAS neišėjo iš įrenginio", o atpirkimo rinkinys —
 * „kas išėjo, tas ir atsuktas". Dvi kopijos leistų vienai nustoti stebėti vieną iš trijų.
 */

export const challengeId = "123e4567-e89b-42d3-a456-426614174060";
export const deviceId = "123e4567-e89b-42d3-a456-426614174061";
export const principalId = "123e4567-e89b-42d3-a456-426614174062";
export const hostFingerprint = "sha256:4444444444444444";
export const oneTimeCode = "b25lLXRpbWUtY29kZS12YWx1ZS0wMDAwMDAwMDAwMDE";
export const nonce = "cGFpcmluZy1ub25jZS12YWx1ZS0wMDAwMDAwMDAwMDE";
export const accessToken = "eyJhbGciOiJIUzI1NiJ9.c2lnbmF0dXJlLXZhbHVl";
export const refreshToken = "refresh-token-value-000000001";
export const gatewayBaseUrl = "https://pc.private.test/v1";
export const expiresAt = "2026-07-26T12:05:00.000Z";
export const beforeExpiry = Date.parse("2026-07-26T12:00:00.000Z");

export const invite: PairingInvite = Object.freeze({
  gatewayBaseUrl,
  challengeId,
  oneTimeCode,
  hostFingerprint,
  expiresAt,
});

export const pairInput = {
  invite,
  deviceName: "  Operator phone  ",
  confirmedHostFingerprint: hostFingerprint,
} as const;

/** Parses a JSON body without letting `any` leak into the assertions. */
export function jsonObject(raw: string | undefined): Record<string, unknown> {
  assert.ok(raw !== undefined, "expected a JSON body");
  const parsed: unknown = JSON.parse(raw);
  assert.ok(typeof parsed === "object" && parsed !== null, "expected a JSON object");
  return parsed as Record<string, unknown>;
}

export function redeemBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    deviceId,
    principalId,
    hostFingerprint,
    tokens: {
      accessToken,
      accessExpiresAt: "2026-07-26T12:15:00.000Z",
      refreshToken,
      refreshExpiresAt: "2026-08-25T12:00:00.000Z",
    },
    ...overrides,
  });
}

export type Harness = {
  controller: PairingController;
  requests: Parameters<MobileHttpTransportPort["request"]>[0][];
  slots: Map<SecureStoreKey, string>;
  keyCreations: number;
  deletedKeys: string[];
  transcripts: string[];
  publicKeyDer: Buffer;
  proofs: string[];
};

export function harness(options: {
  respond?: (call: number) => Readonly<{ status: number; body: string }>;
  transportThrows?: boolean;
  seed?: Partial<Record<SecureStoreKey, string>>;
  nonces?: readonly string[];
  storeFails?: boolean;
  nowMs?: number;
} = {}): Harness {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
  const requests: Parameters<MobileHttpTransportPort["request"]>[0][] = [];
  const slots = new Map<SecureStoreKey, string>(
    Object.entries(options.seed ?? {}) as Array<[SecureStoreKey, string]>,
  );
  const transcripts: string[] = [];
  const proofs: string[] = [];
  const deletedKeys: string[] = [];
  let keyCreations = 0;
  let call = 0;
  let nonceIndex = 0;

  const store: SecureStorePort = {
    async readSecret(key) {
      return slots.get(key) ?? null;
    },
    async writeSecret(key, value) {
      if (options.storeFails === true && key === "device.credential") {
        throw new Error("keystore write failed");
      }
      slots.set(key, value);
    },
    async deleteSecret(key) {
      slots.delete(key);
    },
  };
  const keys: DeviceKeyPort = {
    async createDeviceKey() {
      keyCreations += 1;
      return Object.freeze({
        alias: `ag-device-key-000${keyCreations}`,
        publicKey: publicKeyDer.toString("base64url"),
      });
    },
    async signTranscript(input) {
      transcripts.push(input.transcript);
      const proof = sign(null, Buffer.from(input.transcript, "utf8"), pair.privateKey)
        .toString("base64url");
      proofs.push(proof);
      return proof;
    },
    async deleteDeviceKey(alias) {
      deletedKeys.push(alias);
    },
  };
  const crypto: DeviceCryptoPort = {
    async randomBase64Url() {
      const values = options.nonces ?? [nonce];
      const value = values[Math.min(nonceIndex, values.length - 1)] as string;
      nonceIndex += 1;
      return value;
    },
    async sha256Base64Url(value) {
      return value;
    },
  };
  const transport: MobileHttpTransportPort = {
    async request(input) {
      requests.push(input);
      if (options.transportThrows === true) throw new Error("network unreachable");
      call += 1;
      return options.respond?.(call) ?? { status: 200, body: redeemBody() };
    },
  };
  return {
    controller: new PairingController(
      transport,
      new SecureCredentialStore(store),
      new SecureDeviceIdentity(store, keys),
      keys,
      crypto,
      () => options.nowMs ?? beforeExpiry,
    ),
    requests,
    slots,
    get keyCreations() {
      return keyCreations;
    },
    deletedKeys,
    transcripts,
    publicKeyDer,
    proofs,
  };
}
