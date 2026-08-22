import assert from "node:assert/strict";
import test from "node:test";

import { issueSessionToken, verifySessionToken } from "../src/session-token.mjs";

/**
 * Bug report as a test. RED on a clean checkout — see the fixture README.
 *
 * `expiresAt` is the first instant at which the token is no longer valid, so a
 * verification at exactly that millisecond must be refused. The current `<`
 * comparison accepts it.
 */

const signingKey = "fixture-signing-key-not-a-credential";

test("a token is refused at the exact millisecond it expires", () => {
  const token = issueSessionToken({ subject: "user-1", roles: ["viewer"], expiresAt: 2_000 }, signingKey);
  assert.throws(() => verifySessionToken(token, signingKey, 2_000), /expired/);
});

test("a token is still accepted one millisecond earlier", () => {
  const token = issueSessionToken({ subject: "user-1", roles: ["viewer"], expiresAt: 2_000 }, signingKey);
  assert.equal(verifySessionToken(token, signingKey, 1_999).subject, "user-1");
});
