import assert from "node:assert/strict";
import test from "node:test";

import {
  REDACTION_PLACEHOLDER,
  containsSecret,
  redactSecrets,
  redactSecretsDeep,
} from "../application/secret-redaction.js";
import {
  SYNTHETIC_PRIVATE_KEY,
  SYNTHETIC_SECRETS,
  anotherGithubToken,
} from "./secret-samples.js";

test("provider token shapes are removed", () => {
  for (const secret of Object.values(SYNTHETIC_SECRETS)) {
    const redacted = redactSecrets(`the adapter reported ${secret} while running`);
    assert.equal(redacted.includes(secret), false, secret);
    assert.ok(redacted.includes(REDACTION_PLACEHOLDER), secret);
  }
});

test("a secret-named value is removed while its key survives", () => {
  assert.equal(redactSecrets("ANTHROPIC_API_KEY=abcdef123456"), `ANTHROPIC_API_KEY=${REDACTION_PLACEHOLDER}`);
  assert.equal(redactSecrets('"refreshToken": "kept-secret"'), `"refreshToken": ${REDACTION_PLACEHOLDER}`);
  assert.equal(redactSecrets("db.password: hunter2"), `db.password: ${REDACTION_PLACEHOLDER}`);
});

test("only the credential of a URL is removed, so the remote stays readable", () => {
  assert.equal(
    redactSecrets("cloned https://ci-bot:s3cr3t@github.com/acme/repo.git"),
    `cloned https://ci-bot:${REDACTION_PLACEHOLDER}@github.com/acme/repo.git`,
  );
});

test("an authorization header keeps its scheme and loses its value", () => {
  assert.equal(
    redactSecrets("Authorization: Bearer abcdefghijklmnop"),
    `Authorization: ${REDACTION_PLACEHOLDER} ${REDACTION_PLACEHOLDER}`,
  );
});

test("a private key block is removed whole", () => {
  assert.equal(redactSecrets(SYNTHETIC_PRIVATE_KEY), REDACTION_PLACEHOLDER);
});

test("evidence that looks random is kept", () => {
  // The Git object id BENCH-8 requires, a checksum, a version line and a path.
  // An entropy-based rule would delete the first two, which is why there is none.
  const evidence = [
    "a".repeat(40),
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "git version 2.43.0.windows.1",
    "src/infrastructure/jsonl-sample-store.ts",
    "claude-opus-5",
    "security-log-session-tokens",
  ];
  for (const value of evidence) {
    assert.equal(redactSecrets(value), value, value);
    assert.equal(containsSecret(value), false, value);
  }
});

test("every occurrence in one value is removed, not just the first", () => {
  const first = anotherGithubToken("A");
  const second = anotherGithubToken("B");
  assert.equal(
    redactSecrets(`${first} then ${second}`),
    `${REDACTION_PLACEHOLDER} then ${REDACTION_PLACEHOLDER}`,
  );
});

test("redacting an already redacted value changes nothing further", () => {
  // A sample can be read back and re-stored, and a captured version line is
  // redacted before it is ever written; neither may accumulate placeholders.
  for (const value of [
    "ANTHROPIC_API_KEY=abcdef123456",
    "Authorization: Bearer abcdefghijklmnop",
    "cloned https://ci-bot:s3cr3t@github.com/acme/repo.git",
    `git version 2.43.0 (ASKPASS_TOKEN=${SYNTHETIC_SECRETS.githubToken})`,
  ]) {
    const once = redactSecrets(value);
    assert.equal(redactSecrets(once), once, value);
  }
});

test("the deep form redacts strings and leaves structure alone", () => {
  const redacted = redactSecretsDeep({
    model: `claude-opus-5 ${SYNTHETIC_SECRETS.anthropicApiKey}`,
    llmCalls: 7,
    accepted: true,
    missing: null,
    reasons: ["out-of-scope-change", "ANTHROPIC_API_KEY=abcdef123456"],
  });
  assert.deepEqual(redacted, {
    model: `claude-opus-5 ${REDACTION_PLACEHOLDER}`,
    llmCalls: 7,
    accepted: true,
    missing: null,
    reasons: ["out-of-scope-change", `ANTHROPIC_API_KEY=${REDACTION_PLACEHOLDER}`],
  });
});

test("the deep form does not follow a __proto__ key it was handed", () => {
  const parsed: unknown = JSON.parse('{"__proto__": {"leaked": "yes"}, "model": "claude-opus-5"}');
  const redacted = redactSecretsDeep(parsed);
  assert.equal(Object.getPrototypeOf(redacted), Object.prototype);
  assert.equal("leaked" in {}, false);
  assert.equal(Object.hasOwn(redacted as object, "__proto__"), true);
});

test("the deep form refuses a value that references itself", () => {
  const cyclic: Record<string, unknown> = { model: "claude-opus-5" };
  cyclic["self"] = cyclic;
  assert.throws(() => redactSecretsDeep(cyclic), TypeError);
});
