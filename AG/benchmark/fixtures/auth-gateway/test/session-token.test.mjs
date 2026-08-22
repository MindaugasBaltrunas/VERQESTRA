import assert from "node:assert/strict";
import test from "node:test";

import { issueSessionToken, verifySessionToken } from "../src/session-token.mjs";

const signingKey = "fixture-signing-key-not-a-credential";
const claims = { subject: "user-1", roles: ["editor"], expiresAt: 2_000 };

test("a freshly issued token verifies before it expires", () => {
  const token = issueSessionToken(claims, signingKey);
  assert.deepEqual(verifySessionToken(token, signingKey, 1_000), claims);
});

test("a token signed with another key is refused", () => {
  const token = issueSessionToken(claims, signingKey);
  assert.throws(() => verifySessionToken(token, "a-different-key", 1_000), /signature/);
});

test("a tampered payload is refused", () => {
  const token = issueSessionToken(claims, signingKey);
  const tampered = `${Buffer.from(JSON.stringify({ ...claims, roles: ["admin"] }), "utf8").toString("base64url")}.${token.split(".")[1]}`;
  assert.throws(() => verifySessionToken(tampered, signingKey, 1_000), /signature/);
});

test("a token without both parts is refused before any comparison", () => {
  assert.throws(() => verifySessionToken("nonsense", signingKey, 1_000), /Malformed/);
});

test("a long-expired token is refused", () => {
  const token = issueSessionToken(claims, signingKey);
  assert.throws(() => verifySessionToken(token, signingKey, 9_999), /expired/);
});
