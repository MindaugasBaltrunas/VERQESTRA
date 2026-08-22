import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Session tokens: `<base64url payload>.<base64url hmac>`.
 *
 * The signing key is always an argument. Nothing here reads an environment
 * variable or a file, so the fixture holds no key material that could leak into
 * a diff.
 *
 * KNOWN DEFECT (reproduced by `test/session-token-expiry.test.mjs`): the expiry
 * comparison uses `<` where it should use `<=`, so a token is still accepted at
 * the exact millisecond it expires.
 */

const encode = (value) => Buffer.from(value, "utf8").toString("base64url");
const decode = (value) => Buffer.from(value, "base64url").toString("utf8");

function sign(payload, signingKey) {
  return createHmac("sha256", signingKey).update(payload).digest("base64url");
}

/**
 * @param {{ subject: string, roles: readonly string[], expiresAt: number }} claims
 * @param {string} signingKey
 * @returns {string}
 */
export function issueSessionToken(claims, signingKey) {
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${sign(payload, signingKey)}`;
}

/** Constant-time signature comparison; a `===` here would leak the prefix through timing. */
function signatureMatches(expected, actual) {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * @param {string} token
 * @param {string} signingKey
 * @param {number} now epoch milliseconds
 * @returns {{ subject: string, roles: string[], expiresAt: number }}
 */
export function verifySessionToken(token, signingKey, now) {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Malformed session token.");
  const [payload, signature] = parts;
  if (!signatureMatches(sign(payload, signingKey), signature)) {
    throw new Error("Session token signature does not match.");
  }
  const claims = JSON.parse(decode(payload));
  if (claims.expiresAt < now) throw new Error("Session token has expired.");
  return claims;
}
