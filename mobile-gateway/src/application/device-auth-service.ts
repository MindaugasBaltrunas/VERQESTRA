import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import type { DeviceAuthStatePort } from "./ports/device-auth-state-port.js";
import {
  assertAccessScope,
  assertDeviceScopes,
  DeviceAuthError,
  type AccessTokenClaims,
  type DeviceAuthState,
  type DeviceScope,
  type PairedDeviceRecord,
  type RefreshTokenRecord,
} from "../domain/device-auth.js";

export { DeviceAuthError };
export type { AccessTokenClaims, DeviceScope };

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAIRING_TTL_MS = 5 * 60 * 1000;

export type TokenPair = Readonly<{
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}>;

export type PairingChallenge = Readonly<{
  challengeId: string;
  oneTimeCode: string;
  hostFingerprint: string;
  scopes: DeviceScope[];
  expiresAt: string;
}>;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function secretMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(value), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parsePublicKey(encoded: string) {
  const der = Buffer.from(encoded, "base64url");
  if (der.length === 0 || base64url(der) !== encoded) {
    throw new DeviceAuthError("invalid_device_proof", "Device public key is not canonical base64url");
  }
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("not Ed25519");
    }
    return key;
  } catch {
    throw new DeviceAuthError("invalid_device_proof", "Device public key is not Ed25519");
  }
}

function verifyProof(publicKey: string, transcript: string, proof: string): void {
  let signature: Buffer;
  try {
    signature = Buffer.from(proof, "base64url");
  } catch {
    throw new DeviceAuthError("invalid_device_proof", "Device proof is malformed");
  }
  if (
    signature.length !== 64 ||
    signature.toString("base64url") !== proof ||
    !verify(null, Buffer.from(transcript), parsePublicKey(publicKey), signature)
  ) {
    throw new DeviceAuthError("invalid_device_proof", "Device proof is invalid");
  }
}

function pairingTranscript(input: {
  challengeId: string;
  hostFingerprint: string;
  devicePublicKey: string;
  nonce: string;
}): string {
  return [
    "ag-pair-v1",
    input.challengeId,
    input.hostFingerprint,
    input.devicePublicKey,
    input.nonce,
  ].join("\n");
}

function refreshTranscript(input: {
  deviceId: string;
  refreshToken: string;
  nonce: string;
  generation: number;
}): string {
  return [
    "ag-refresh-v1",
    input.deviceId,
    hashSecret(input.refreshToken),
    input.nonce,
    String(input.generation),
  ].join("\n");
}

function signAccessToken(state: DeviceAuthState, device: PairedDeviceRecord, now: Date): {
  token: string;
  expiresAt: string;
} {
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const claims: AccessTokenClaims = {
    iss: state.issuer,
    aud: state.audience,
    sub: device.principalId,
    deviceId: device.deviceId,
    scopes: [...device.scopes],
    generation: device.generation,
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
    jti: randomUUID(),
  };
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", Buffer.from(state.accessSigningKey, "base64url"))
    .update(payload)
    .digest("base64url");
  return { token: `${payload}.${signature}`, expiresAt: expiresAt.toISOString() };
}

function createRefreshRecord(device: PairedDeviceRecord, familyId: string, now: Date): {
  token: string;
  record: RefreshTokenRecord;
} {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    record: {
      tokenHash: hashSecret(token),
      deviceId: device.deviceId,
      familyId,
      deviceGeneration: device.generation,
      status: "active",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
    },
  };
}

function tokenPair(
  state: DeviceAuthState,
  device: PairedDeviceRecord,
  familyId: string,
  now: Date,
): { pair: TokenPair; refresh: RefreshTokenRecord } {
  const access = signAccessToken(state, device, now);
  const refresh = createRefreshRecord(device, familyId, now);
  return {
    pair: {
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.record.expiresAt,
    },
    refresh: refresh.record,
  };
}

function revokeFamily(
  state: DeviceAuthState,
  device: PairedDeviceRecord,
  familyId: string,
  now: Date,
): void {
  device.generation += 1;
  for (const record of Object.values(state.refreshTokens)) {
    if (record.deviceId === device.deviceId && record.familyId === familyId) {
      record.status = "revoked";
      record.revokedAt = now.toISOString();
    }
  }
}

export class DeviceAuthService {
  constructor(private readonly statePort: DeviceAuthStatePort) {}

  async createPairingChallenge(input: {
    hostFingerprint: string;
    scopes: string[];
    ttlMs?: number;
    now?: Date;
  }): Promise<PairingChallenge> {
    const scopes = [...input.scopes];
    assertDeviceScopes(scopes);
    const ttlMs = input.ttlMs ?? MAX_PAIRING_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_PAIRING_TTL_MS) {
      throw new Error("Pairing challenge ttlMs must be between 1 and 300000");
    }
    if (input.hostFingerprint.length < 16 || input.hostFingerprint.length > 200) {
      throw new Error("Host fingerprint length is invalid");
    }
    const now = input.now ?? new Date();
    const challengeId = randomUUID();
    const oneTimeCode = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    await this.statePort.update((state) => {
      state.challenges[challengeId] = {
        challengeId,
        codeHash: hashSecret(oneTimeCode),
        hostFingerprint: input.hostFingerprint,
        scopes: [...scopes],
        createdAt: now.toISOString(),
        expiresAt,
      };
      return { state, result: undefined };
    });
    return { challengeId, oneTimeCode, hostFingerprint: input.hostFingerprint, scopes: [...scopes], expiresAt };
  }

  async redeemPairingChallenge(input: {
    challengeId: string;
    oneTimeCode: string;
    deviceName: string;
    devicePublicKey: string;
    nonce: string;
    proof: string;
    now?: Date;
  }): Promise<Readonly<{
    deviceId: string;
    principalId: string;
    hostFingerprint: string;
    tokens: TokenPair;
  }>> {
    const now = input.now ?? new Date();
    if (input.deviceName.trim().length === 0 || input.deviceName.length > 80 || input.nonce.length < 16) {
      throw new DeviceAuthError("invalid_pairing", "Pairing request fields are invalid");
    }
    return this.statePort.update((state) => {
      const challenge = state.challenges[input.challengeId];
      if (!challenge || !secretMatches(input.oneTimeCode, challenge.codeHash)) {
        throw new DeviceAuthError("invalid_pairing", "Pairing challenge is invalid");
      }
      if (challenge.consumedAt) {
        throw new DeviceAuthError("pairing_consumed", "Pairing challenge was already consumed");
      }
      if (now.getTime() >= Date.parse(challenge.expiresAt)) {
        throw new DeviceAuthError("pairing_expired", "Pairing challenge expired");
      }
      verifyProof(input.devicePublicKey, pairingTranscript({
        challengeId: challenge.challengeId,
        hostFingerprint: challenge.hostFingerprint,
        devicePublicKey: input.devicePublicKey,
        nonce: input.nonce,
      }), input.proof);

      challenge.consumedAt = now.toISOString();
      const device: PairedDeviceRecord = {
        deviceId: randomUUID(),
        principalId: randomUUID(),
        deviceName: input.deviceName.trim(),
        publicKey: input.devicePublicKey,
        scopes: [...challenge.scopes],
        generation: 1,
        status: "active",
        pairedAt: now.toISOString(),
      };
      state.devices[device.deviceId] = device;
      const issued = tokenPair(state, device, randomUUID(), now);
      state.refreshTokens[issued.refresh.tokenHash] = issued.refresh;
      return {
        state,
        result: {
          deviceId: device.deviceId,
          principalId: device.principalId,
          hostFingerprint: challenge.hostFingerprint,
          tokens: issued.pair,
        },
      };
    });
  }

  async refresh(input: {
    deviceId: string;
    refreshToken: string;
    nonce: string;
    proof: string;
    now?: Date;
  }): Promise<TokenPair> {
    const now = input.now ?? new Date();
    return this.statePort.update<TokenPair | DeviceAuthError>((state) => {
      const tokenHash = hashSecret(input.refreshToken);
      const record = state.refreshTokens[tokenHash];
      const device = state.devices[input.deviceId];
      if (!record || record.deviceId !== input.deviceId || !device) {
        throw new DeviceAuthError("invalid_refresh_token", "Refresh credential is invalid");
      }
      if (device.status !== "active") {
        throw new DeviceAuthError("device_revoked", "Device is revoked");
      }
      if (input.nonce.length < 16) {
        throw new DeviceAuthError("invalid_device_proof", "Refresh nonce is invalid");
      }
      verifyProof(device.publicKey, refreshTranscript({
        deviceId: device.deviceId,
        refreshToken: input.refreshToken,
        nonce: input.nonce,
        generation: device.generation,
      }), input.proof);
      if (record.status !== "active") {
        if (record.status === "rotated") {
          revokeFamily(state, device, record.familyId, now);
          return {
            state,
            result: new DeviceAuthError("refresh_token_reuse", "Refresh credential reuse revoked its token family"),
          };
        }
        throw new DeviceAuthError("invalid_refresh_token", "Refresh credential is revoked");
      }
      if (
        record.deviceGeneration !== device.generation ||
        now.getTime() >= Date.parse(record.expiresAt)
      ) {
        record.status = "revoked";
        record.revokedAt = now.toISOString();
        return {
          state,
          result: new DeviceAuthError("refresh_token_expired", "Refresh credential expired"),
        };
      }
      record.status = "rotated";
      record.rotatedAt = now.toISOString();
      const issued = tokenPair(state, device, record.familyId, now);
      state.refreshTokens[issued.refresh.tokenHash] = issued.refresh;
      return { state, result: issued.pair };
    }).then((result) => {
      if (result instanceof DeviceAuthError) {
        throw result;
      }
      return result;
    });
  }

  async authenticateAccessToken(token: string, now = new Date()): Promise<AccessTokenClaims> {
    const state = await this.statePort.read();
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) {
      throw new DeviceAuthError("invalid_access_token", "Access token is malformed");
    }
    const expected = createHmac("sha256", Buffer.from(state.accessSigningKey, "base64url"))
      .update(payload)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (
      actual.length !== expected.length ||
      actual.toString("base64url") !== signature ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new DeviceAuthError("invalid_access_token", "Access token signature is invalid");
    }
    let claims: AccessTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessTokenClaims;
    } catch {
      throw new DeviceAuthError("invalid_access_token", "Access token payload is invalid");
    }
    const device = state.devices[claims.deviceId];
    if (
      claims.iss !== state.issuer ||
      claims.aud !== state.audience ||
      !device ||
      device.status !== "active" ||
      claims.sub !== device.principalId ||
      claims.generation !== device.generation ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      typeof claims.jti !== "string" ||
      claims.jti.length === 0
    ) {
      throw new DeviceAuthError("invalid_access_token", "Access token claims are invalid");
    }
    assertDeviceScopes(claims.scopes);
    if (Math.floor(now.getTime() / 1000) >= claims.exp) {
      throw new DeviceAuthError("access_token_expired", "Access token expired");
    }
    return claims;
  }

  async authorizeAccessToken(
    token: string,
    requiredScope: DeviceScope,
    now = new Date(),
  ): Promise<AccessTokenClaims> {
    const claims = await this.authenticateAccessToken(token, now);
    assertAccessScope(claims, requiredScope);
    return claims;
  }

  async revokeDevice(deviceId: string, now = new Date()): Promise<void> {
    await this.statePort.update((state) => {
      const device = state.devices[deviceId];
      if (!device) {
        return { state, result: undefined };
      }
      device.status = "revoked";
      device.generation += 1;
      device.revokedAt = now.toISOString();
      for (const record of Object.values(state.refreshTokens)) {
        if (record.deviceId === deviceId) {
          record.status = "revoked";
          record.revokedAt = now.toISOString();
        }
      }
      return { state, result: undefined };
    });
  }
}
