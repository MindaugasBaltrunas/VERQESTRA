import type { MobileHttpTransportPort } from "../adapters/network/gateway-http-client.js";
import type { SecureDeviceIdentity } from "../adapters/secure-storage/secure-device-identity.js";
import { hostFingerprintPattern } from "../adapters/secure-storage/secure-device-identity.js";
import {
  ACCESS_TOKEN_PATTERN,
  exactKeys,
  GATEWAY_BASE_URL_PATTERN,
  isDateTime,
  isRecord,
  NONCE_PATTERN,
  OPAQUE_TOKEN_PATTERN,
  parseJson,
  PROOF_PATTERN,
  UUID_PATTERN,
  type JsonRecord,
} from "../adapters/shared/gateway-format.js";
import type {
  CredentialPort,
  DeviceCryptoPort,
  DeviceKeyHandle,
  DeviceKeyPort,
} from "../model/ports.js";

/** Random bytes per pairing nonce; 32 bytes is 43 unpadded base64url characters. */
export const pairingNonceByteLength = 32;

/** Bound on a scanned QR payload, so a hostile code cannot force a large parse. */
export const maxPairingInvitePayloadLength = 4096;

/** The host mints 32 random bytes; anything shorter is not the code it issued. */
const ONE_TIME_CODE_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const DEVICE_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{16,4096}$/;
const INVITE_KEYS = [
  "gatewayBaseUrl",
  "challengeId",
  "oneTimeCode",
  "hostFingerprint",
  "expiresAt",
] as const;

/**
 * Everything the local host hands the phone out of band (QR or manual entry).
 * It carries no refresh credential — only a single-use code and the host
 * identity the device must pin before it sends that code anywhere.
 */
export type PairingInvite = Readonly<{
  /** `https://host[:port]/v1` — the same shape the terminal client enforces. */
  gatewayBaseUrl: string;
  challengeId: string;
  oneTimeCode: string;
  hostFingerprint: string;
  expiresAt: string;
}>;

export type PairingResult = Readonly<{
  deviceId: string;
  principalId: string;
  hostFingerprint: string;
}>;

type IssuedTokens = Readonly<{
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}>;

export class PairingError extends Error {
  constructor(
    readonly code:
      | "invalid_invite"
      | "invite_expired"
      | "already_paired"
      | "host_mismatch"
      | "device_key_failed"
      | "code_consumed"
      | "rejected"
      | "rate_limited"
      | "invalid_response"
      | "transport_failed"
      | "storage_failed",
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

/**
 * One message for every rejection: naming the offending field would help an
 * attacker shape a payload and helps a user with none.
 */
function invalidInvite(): PairingError {
  return new PairingError("invalid_invite", "Pairing invite is invalid", false);
}

/**
 * Field rules for an invite. `PairingInvite` is a structural type, so holding
 * one proves nothing about where it came from; every entry point re-checks the
 * fields rather than trusting that the parser produced them.
 *
 * NUKRYPIMAS (forma, ne priimamų invite'ų aibė): etalone ši funkcija grąžindavo `boolean`, o
 * `parsePairingInvite` po jos rašė penkis `value.gatewayBaseUrl as string`. Čia ji yra tipo
 * predikatas, tad tie penki tvirtinimai dingo: tipas plaukia iš tos pačios patikros, kuri
 * sprendžia priimti ar atmesti, ir jiedu nebegali prasilenkti.
 */
function isWellFormedInvite(value: JsonRecord): value is JsonRecord & PairingInvite {
  const gatewayBaseUrl = value["gatewayBaseUrl"];
  const challengeId = value["challengeId"];
  const oneTimeCode = value["oneTimeCode"];
  const hostFingerprint = value["hostFingerprint"];
  return (
    typeof gatewayBaseUrl === "string" && GATEWAY_BASE_URL_PATTERN.test(gatewayBaseUrl) &&
    typeof challengeId === "string" && UUID_PATTERN.test(challengeId) &&
    typeof oneTimeCode === "string" && ONE_TIME_CODE_PATTERN.test(oneTimeCode) &&
    typeof hostFingerprint === "string" && hostFingerprintPattern.test(hostFingerprint) &&
    isDateTime(value["expiresAt"])
  );
}

/**
 * Parses a scanned or typed pairing payload. Pure and total: it either returns
 * a fully validated invite or throws, so no partially trusted value can reach
 * the network or the keystore.
 */
export function parsePairingInvite(raw: string): PairingInvite {
  if (raw.length > maxPairingInvitePayloadLength) throw invalidInvite();
  const value = parseJson(raw);
  if (!value || !exactKeys(value, INVITE_KEYS) || !isWellFormedInvite(value)) {
    throw invalidInvite();
  }
  return Object.freeze({
    gatewayBaseUrl: value.gatewayBaseUrl,
    challengeId: value.challengeId,
    oneTimeCode: value.oneTimeCode,
    hostFingerprint: value.hostFingerprint,
    expiresAt: value.expiresAt,
  });
}

function parseTokens(value: unknown): IssuedTokens | undefined {
  if (!isRecord(value)) return undefined;
  const accessToken = value["accessToken"];
  const accessExpiresAt = value["accessExpiresAt"];
  const refreshToken = value["refreshToken"];
  const refreshExpiresAt = value["refreshExpiresAt"];
  if (
    !exactKeys(value, ["accessToken", "accessExpiresAt", "refreshToken", "refreshExpiresAt"]) ||
    typeof accessToken !== "string" || !ACCESS_TOKEN_PATTERN.test(accessToken) ||
    !isDateTime(accessExpiresAt) ||
    typeof refreshToken !== "string" || !OPAQUE_TOKEN_PATTERN.test(refreshToken) ||
    !isDateTime(refreshExpiresAt)
  ) {
    return undefined;
  }
  return Object.freeze({ accessToken, accessExpiresAt, refreshToken, refreshExpiresAt });
}

function pairingErrorFor(status: number): PairingError {
  if (status === 409) {
    return new PairingError("code_consumed", "Pairing code is no longer valid", false);
  }
  if (status === 401 || status === 403) {
    return new PairingError("rejected", "Pairing was rejected", false);
  }
  if (status === 429) {
    return new PairingError("rate_limited", "Too many pairing attempts", true);
  }
  if (status >= 500) {
    return new PairingError("transport_failed", "Pairing request failed", true);
  }
  return invalidInvite();
}

/**
 * Device pairing, app side. Order is the security property here: the host is
 * pinned before the one-time code is sent, the response is fully validated
 * before anything is persisted, and any failure after key generation destroys
 * that key — so a half-paired device never exists.
 *
 * `ag-pair-v1` is a cryptographic domain separator carried over UNCHANGED: the
 * verifying side is `mobile-gateway/src/application/device-auth-service.ts`.
 */
export class PairingController {
  /**
   * Challenges whose code has already reached the host. The gateway consumes a
   * challenge atomically, so re-sending it can only leak the code again. The
   * set is in memory only: a one-time code must not survive a restart either.
   */
  private readonly sentChallengeIds = new Set<string>();

  constructor(
    private readonly transport: MobileHttpTransportPort,
    private readonly credentials: CredentialPort,
    private readonly identity: SecureDeviceIdentity,
    private readonly keys: DeviceKeyPort,
    private readonly crypto: DeviceCryptoPort,
    private readonly nowMs: () => number,
  ) {}

  async pair(input: Readonly<{
    invite: PairingInvite;
    deviceName: string;
    /** Fingerprint the operator read off the host screen, out of band. */
    confirmedHostFingerprint: string;
  }>): Promise<PairingResult> {
    const { invite } = input;
    // The invite is re-validated here even though `parsePairingInvite` exists:
    // holding a `PairingInvite` proves only its shape, and an unchecked
    // `gatewayBaseUrl` would send the one-time code to whatever host it names.
    if (!isWellFormedInvite(invite)) throw invalidInvite();
    const deviceName = input.deviceName.trim();
    if (deviceName.length === 0 || deviceName.length > 80) {
      throw new PairingError("invalid_invite", "Device name is invalid", false);
    }
    if (this.sentChallengeIds.has(invite.challengeId)) {
      throw new PairingError("code_consumed", "This pairing code was already used", false);
    }
    // Pin before anything leaves the device: an operator who cannot confirm the
    // host's own fingerprint must not send the one-time code to it.
    if (input.confirmedHostFingerprint !== invite.hostFingerprint) {
      throw new PairingError("host_mismatch", "Host identity was not confirmed", false);
    }
    const pinned = await this.identity.loadHostFingerprint();
    if (pinned !== null && pinned !== invite.hostFingerprint) {
      throw new PairingError("host_mismatch", "This device is pinned to another host", false);
    }
    if (this.nowMs() >= Date.parse(invite.expiresAt)) {
      throw new PairingError("invite_expired", "Pairing invite expired", false);
    }
    // Re-pairing over a live credential would orphan both a gateway device
    // record and a keystore key; unpairing is an explicit, visible act.
    if (await this.credentials.loadDeviceCredential()) {
      throw new PairingError("already_paired", "This device is already paired", false);
    }
    // A leftover alias without a credential is the same problem one step
    // earlier: the key it names is non-exportable, so overwriting the alias
    // would strand it in the keystore with nothing able to delete it.
    if (await this.identity.loadAlias()) {
      throw new PairingError("already_paired", "This device still holds a signing key", false);
    }

    const key = await this.createKey();
    try {
      const redeemed = await this.redeem(invite, deviceName, key);
      await this.persist(key.alias, redeemed);
      return Object.freeze({
        deviceId: redeemed.deviceId,
        principalId: redeemed.principalId,
        hostFingerprint: redeemed.hostFingerprint,
      });
    } catch (error) {
      // An unauthenticated key is worse than no key: it would be reused by the
      // next attempt and could not be distinguished from a paired identity.
      await this.rollback(key.alias, pinned !== null);
      throw error;
    }
  }

  /** Full local wipe: keystore key, pinned host and stored tokens. Idempotent. */
  async unpair(): Promise<void> {
    await this.identity.forget();
    await this.credentials.clearDeviceCredential();
  }

  private async createKey(): Promise<DeviceKeyHandle> {
    let handle: DeviceKeyHandle;
    try {
      handle = await this.keys.createDeviceKey();
    } catch {
      throw new PairingError("device_key_failed", "Device key could not be created", false);
    }
    if (!DEVICE_PUBLIC_KEY_PATTERN.test(handle.publicKey)) {
      throw new PairingError("device_key_failed", "Device key is invalid", false);
    }
    return handle;
  }

  private async redeem(
    invite: PairingInvite,
    deviceName: string,
    key: DeviceKeyHandle,
  ): Promise<PairingResult & { tokens: IssuedTokens }> {
    const nonce = await this.crypto.randomBase64Url(pairingNonceByteLength);
    if (!NONCE_PATTERN.test(nonce)) {
      throw new PairingError("device_key_failed", "Device nonce source is invalid", false);
    }
    const transcript = [
      "ag-pair-v1",
      invite.challengeId,
      invite.hostFingerprint,
      key.publicKey,
      nonce,
    ].join("\n");
    let proof: string;
    try {
      proof = await this.keys.signTranscript({ alias: key.alias, transcript });
    } catch {
      throw new PairingError("device_key_failed", "Device proof could not be created", false);
    }
    if (!PROOF_PATTERN.test(proof)) {
      throw new PairingError("device_key_failed", "Device proof is invalid", false);
    }

    let response: Readonly<{ status: number; body: string }>;
    try {
      response = await this.transport.request({
        method: "POST",
        // The route is unauthenticated by contract and carries no
        // `Idempotency-Key`: the challenge is single-use, so a replayed redeem
        // must fail rather than silently pair twice.
        url: `${invite.gatewayBaseUrl}/pairing-challenges/${invite.challengeId}/redeem`,
        headers: Object.freeze({
          "Accept": "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          oneTimeCode: invite.oneTimeCode,
          deviceName,
          devicePublicKey: key.publicKey,
          nonce,
          proof,
        }),
      });
    } catch {
      // The code may never have reached the host, so this attempt stays
      // retryable and the challenge is not burned.
      throw new PairingError("transport_failed", "Pairing request failed", true);
    }
    // The code has now left the device. Only a rate-limit answer means the host
    // certainly did not look at it, so only that one may be retried.
    if (response.status !== 429) this.sentChallengeIds.add(invite.challengeId);
    if (response.status !== 200) throw pairingErrorFor(response.status);

    const parsed = parseJson(response.body);
    if (!parsed) {
      throw new PairingError("invalid_response", "Pairing response is invalid", false);
    }
    const deviceId = parsed["deviceId"];
    const principalId = parsed["principalId"];
    const hostFingerprint = parsed["hostFingerprint"];
    if (
      !exactKeys(parsed, ["deviceId", "principalId", "hostFingerprint", "tokens"]) ||
      typeof deviceId !== "string" || !UUID_PATTERN.test(deviceId) ||
      typeof principalId !== "string" || !UUID_PATTERN.test(principalId) ||
      typeof hostFingerprint !== "string"
    ) {
      throw new PairingError("invalid_response", "Pairing response is invalid", false);
    }
    const tokens = parseTokens(parsed["tokens"]);
    if (!tokens) {
      throw new PairingError("invalid_response", "Pairing response is invalid", false);
    }
    // The host that answered must be the host that was pinned; a mismatch means
    // the code went somewhere else, so nothing is kept.
    if (hostFingerprint !== invite.hostFingerprint) {
      throw new PairingError("host_mismatch", "Gateway identity did not match", false);
    }
    return { deviceId, principalId, hostFingerprint, tokens };
  }

  private async persist(
    alias: string,
    result: PairingResult & { tokens: IssuedTokens },
  ): Promise<void> {
    try {
      await this.identity.saveAlias(alias);
      await this.identity.saveHostFingerprint(result.hostFingerprint);
      await this.credentials.storeDeviceCredential({
        deviceId: result.deviceId,
        // The redeem response carries no generation; the gateway starts every
        // newly paired device at 1. A later revocation moves the host past this
        // value, refresh then fails and the device re-pairs — which is exactly
        // what a revocation is meant to force.
        generation: 1,
        accessToken: result.tokens.accessToken,
        accessExpiresAt: result.tokens.accessExpiresAt,
        refreshToken: result.tokens.refreshToken,
        refreshExpiresAt: result.tokens.refreshExpiresAt,
      });
    } catch {
      throw new PairingError("storage_failed", "Pairing could not be stored", false);
    }
  }

  /**
   * Undoes exactly what this attempt wrote, and nothing else. In particular a
   * host pin that already existed survives: erasing it would silently disarm
   * the "pinned to another host" guard for the next invite.
   *
   * Best effort — a rollback that throws must not mask the original failure.
   */
  private async rollback(alias: string, hadPin: boolean): Promise<void> {
    try {
      if (await this.identity.loadAlias() === alias) await this.identity.clearAlias();
      if (!hadPin) await this.identity.clearHostFingerprint();
      await this.keys.deleteDeviceKey(alias);
      await this.credentials.clearDeviceCredential();
    } catch {
      // Intentionally swallowed: the caller already has the real error, and a
      // keystore that refuses a delete leaves an unusable key, not a usable one.
    }
  }
}
