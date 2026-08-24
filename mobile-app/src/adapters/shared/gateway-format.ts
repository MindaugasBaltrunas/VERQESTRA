import type { DeviceCredential } from "../../model/ports.js";

/**
 * Wire and storage format rules shared by every adapter that touches gateway
 * credentials. They live here, and only here, because the HTTP client, the
 * secure credential store and the pairing flow must agree byte for byte: a
 * credential the store accepts but the client rejects (or the reverse) is an
 * unpairable device that reports no reason for it.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,4096}$/;
export const GATEWAY_BASE_URL_PATTERN = /^https:\/\/[^/?#]+(?::\d+)?\/v1$/;

/**
 * Base64url of at least 16 random bytes, unpadded. The gateway only demands 16
 * characters; the stricter client-side bound keeps a truncated or low-entropy
 * randomness adapter from producing a nonce the host would still accept.
 */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,256}$/;

/** Base64url of a 64-byte Ed25519 signature, unpadded — exactly 86 characters. */
export const PROOF_PATTERN = /^[A-Za-z0-9_-]{86}$/;

export const MAX_RESPONSE_BYTES = 1024 * 1024;

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * NUKRYPIMAS (forma, ne elgesys). Etalonas po `Number.isSafeInteger(value.generation)` rašė
 * `value.generation as number`, o po `[...].includes(String(value.state))` — `value.state as
 * TerminalSession["state"]`. `as` per tinklo ribą nėra kontraktas: jis pasako kompiliatoriui
 * tai, ko patikra nepasakė, ir jei kada nors patikra ir tvirtinimas prasilenks, prasilenks
 * tyliai. Du predikatai grąžina tuos pačius atsakymus, bet tipas dabar plaukia IŠ patikros.
 */
export function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

/** Membership check that narrows; deliberately written without a cast of its own. */
export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

/**
 * Key-set equality, not containment: an unexpected field in a response or in a
 * stored credential is treated as a different document, never quietly ignored.
 */
export function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > MAX_RESPONSE_BYTES) return bytes;
  }
  return bytes;
}

export function parseJson(body: string): JsonRecord | undefined {
  if (utf8ByteLength(body) > MAX_RESPONSE_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** The complete persisted credential surface; nothing else may be stored. */
export const deviceCredentialKeys: readonly string[] = Object.freeze([
  "deviceId",
  "generation",
  "accessToken",
  "accessExpiresAt",
  "refreshToken",
  "refreshExpiresAt",
]);

export function isValidDeviceCredential(value: DeviceCredential): boolean {
  return (
    UUID_PATTERN.test(value.deviceId) &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 1 &&
    ACCESS_TOKEN_PATTERN.test(value.accessToken) &&
    isDateTime(value.accessExpiresAt) &&
    OPAQUE_TOKEN_PATTERN.test(value.refreshToken) &&
    isDateTime(value.refreshExpiresAt)
  );
}
