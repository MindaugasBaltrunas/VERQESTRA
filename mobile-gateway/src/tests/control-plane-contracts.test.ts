import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertCommandIdempotencyKey,
  assertIntegrationConfirmation,
  COMMAND_AUTHORITY,
  CommandIntentError,
  decideCommandIntent,
  INTEGRATION_STRATEGIES,
  type AnyCommandIntent,
  type CommandAction,
  type CommandDecisionContext,
  type CommandIntentErrorCode,
  type IntegrationConfirmation,
  type IntegrationPreview,
  type IntegrationRevalidation,
} from "../domain/command-intent.js";
import { GATEWAY_ERROR_CODES } from "../interfaces/http/remote-gateway-router.js";

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const sourceRoot = path.join(packageRoot, "src");

const DEVICE_ID = "123e4567-e89b-42d3-a456-426614174000";
const IDEMPOTENCY_KEY = `${DEVICE_ID}:7`;

function context(overrides: Partial<CommandDecisionContext> = {}): CommandDecisionContext {
  return {
    deviceId: DEVICE_ID,
    isOwner: true,
    scopes: ["ag:read", "terminal:write", "github:read", "github:write"],
    issueApprovalChallenge: () => "challenge-1",
    ...overrides,
  };
}

function importIssue(overrides: Record<string, unknown> = {}): AnyCommandIntent {
  return {
    commandId: "command-1",
    idempotencyKey: IDEMPOTENCY_KEY,
    deviceId: DEVICE_ID,
    principalId: "owner",
    projectId: "project-1",
    action: "github.issue.import",
    payload: { issueNumber: 42 },
    requestedAt: "2026-08-05T10:00:00.000Z",
    ...overrides,
  } as AnyCommandIntent;
}

function createPullRequest(overrides: Record<string, unknown> = {}): AnyCommandIntent {
  return {
    commandId: "command-2",
    idempotencyKey: IDEMPOTENCY_KEY,
    deviceId: DEVICE_ID,
    principalId: "owner",
    projectId: "project-1",
    action: "github.pull_request.create",
    payload: { sessionId: "session-1", title: "Fix failing tests", draft: true },
    requestedAt: "2026-08-05T10:00:00.000Z",
    ...overrides,
  } as AnyCommandIntent;
}

/**
 * Compile-time exhaustive: adding an action to `CommandAction` without deciding
 * its authority breaks this object, not just an assertion count.
 */
const EXPECTED_ACTIONS: Readonly<Record<CommandAction, true>> = {
  "github.connection.begin": true,
  "github.connection.revoke": true,
  "github.issue.import": true,
  "github.pull_request.create": true,
  "project.create": true,
  "git.integration.merge": true,
  "git.integration.rebase": true,
  "git.integration.cherry_pick": true,
  "git.push.protected_branch": true,
};

test("every command action carries an explicit host classification", () => {
  assert.deepEqual(Object.keys(COMMAND_AUTHORITY).sort(), Object.keys(EXPECTED_ACTIONS).sort());
  for (const [action, authority] of Object.entries(COMMAND_AUTHORITY)) {
    assert.ok(["safe", "confirm", "blocked"].includes(authority.risk), action);
    assert.equal(typeof authority.ownerOnly, "boolean", action);
  }
});

test("a scoped read command is accepted without an approval challenge", () => {
  const decision = decideCommandIntent(importIssue(), context({ isOwner: false }));
  assert.deepEqual(decision, { commandId: "command-1", decision: "accepted", risk: "safe" });
});

test("a missing scope refuses the command instead of executing it", () => {
  const decision = decideCommandIntent(importIssue(), context({ scopes: ["ag:read"] }));
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.reasonCode, "forbidden");
});

test("an owner-only command is refused for a non-owner device", () => {
  const intent = importIssue({ action: "github.connection.begin", payload: {} });
  const decision = decideCommandIntent(intent, context({ isOwner: false }));
  assert.equal(decision.decision, "rejected");
  assert.equal(decision.reasonCode, "forbidden");
});

test("a confirm command needs a verified approval challenge before it is accepted", () => {
  const required = decideCommandIntent(createPullRequest(), context());
  assert.equal(required.decision, "confirmation_required");
  assert.equal(required.risk, "confirm");
  assert.equal(required.approvalChallengeId, "challenge-1");

  const accepted = decideCommandIntent(
    createPullRequest(),
    context({ verifiedApprovalChallengeId: "challenge-1" }),
  );
  assert.equal(accepted.decision, "accepted");
});

test("remote branch integration is refused by classification, not by absence", () => {
  for (const action of [
    "git.integration.merge",
    "git.integration.rebase",
    "git.integration.cherry_pick",
    "git.push.protected_branch",
  ] as const) {
    const decision = decideCommandIntent(
      importIssue({ action, payload: {} }),
      context({ verifiedApprovalChallengeId: "challenge-1" }),
    );
    assert.equal(decision.decision, "rejected", action);
    assert.equal(decision.risk, "blocked", action);
    assert.equal(decision.reasonCode, "forbidden", action);
  }
});

test("risk comes from the host catalog even when the client sends its own", () => {
  const tampered = createPullRequest({ risk: "safe" });
  const decision = decideCommandIntent(tampered, context());
  assert.equal(decision.risk, "confirm");
  assert.equal(decision.decision, "confirmation_required");
});

test("a replayed idempotency key reports the first outcome and never re-executes", () => {
  const first = decideCommandIntent(importIssue(), context());
  const replay = decideCommandIntent(
    importIssue({ commandId: "command-retry" }),
    context({ ledgerDecision: first }),
  );
  assert.deepEqual(replay, {
    commandId: "command-1",
    decision: "duplicate",
    risk: "safe",
    reasonCode: "duplicate_request",
  });
});

test("an idempotency key is bound to the calling device and to the documented shape", () => {
  assert.doesNotThrow(() => assertCommandIdempotencyKey(IDEMPOTENCY_KEY, DEVICE_ID));
  for (const [key, code] of [
    [`${DEVICE_ID}:7`, "forbidden"],
    [`${DEVICE_ID}:not-a-counter`, "invalid_request"],
    ["short:1", "invalid_request"],
    [`${DEVICE_ID}-7`, "invalid_request"],
  ] as const) {
    assert.throws(
      () => assertCommandIdempotencyKey(key, "223e4567-e89b-42d3-a456-426614174999"),
      (error: unknown) => error instanceof CommandIntentError && error.code === code,
      key,
    );
  }
});

test("a command intent submitted for another device is rejected outright", () => {
  assert.throws(
    () => decideCommandIntent(importIssue({ deviceId: "other-device" }), context()),
    (error: unknown) => error instanceof CommandIntentError && error.code === "forbidden",
  );
});

const DIFF_DIGEST = `sha256:${"a".repeat(64)}`;
const GATE_DIGEST = `sha256:${"b".repeat(64)}`;

const preview: IntegrationPreview = Object.freeze({
  integrationId: "integration-1",
  sessionId: "session-1",
  sourceBranch: "mobile/session-1",
  sourceCommit: "1111111111111111111111111111111111111111",
  targetBranch: "main",
  targetHead: "2222222222222222222222222222222222222222",
  changedFiles: ["src/domain/command-intent.ts"],
  diffDigest: DIFF_DIGEST,
  gateDigest: GATE_DIGEST,
  gatesPassed: true,
  targetClean: true,
  expiresAt: "2026-08-05T10:05:00.000Z",
});

function confirmation(overrides: Record<string, unknown> = {}): IntegrationConfirmation {
  return {
    integrationId: preview.integrationId,
    sourceCommit: preview.sourceCommit,
    expectedTargetHead: preview.targetHead,
    diffDigest: DIFF_DIGEST,
    gateDigest: GATE_DIGEST,
    strategy: "merge-no-ff",
    confirmation: "local-reauth-proof",
    ...overrides,
  } as IntegrationConfirmation;
}

function revalidation(overrides: Partial<IntegrationRevalidation> = {}): IntegrationRevalidation {
  return {
    now: new Date("2026-08-05T10:00:00.000Z"),
    previewConsumed: false,
    observedSourceCommit: preview.sourceCommit,
    observedTargetHead: preview.targetHead,
    observedTargetClean: true,
    observedDiffDigest: DIFF_DIGEST,
    observedGateDigest: GATE_DIGEST,
    observedGatesPassed: true,
    actor: { isLocalOsOwner: true, reauthenticatedAt: "2026-08-05T09:59:50.000Z" },
    ...overrides,
  };
}

test("only merge-no-ff is an allowed V1 integration strategy", () => {
  assert.deepEqual([...INTEGRATION_STRATEGIES], ["merge-no-ff"]);
});

test("an unchanged, gated, owner-confirmed integration passes revalidation", () => {
  assert.doesNotThrow(() => assertIntegrationConfirmation(preview, confirmation(), revalidation()));
});

test("a confirmation that differs from the preview is an invalid request", () => {
  const cases: ReadonlyArray<readonly [string, IntegrationConfirmation]> = [
    ["foreign preview", confirmation({ integrationId: "integration-2" })],
    ["unsupported strategy", confirmation({ strategy: "rebase" })],
    ["diff digest", confirmation({ diffDigest: `sha256:${"c".repeat(64)}` })],
    ["gate digest", confirmation({ gateDigest: `sha256:${"d".repeat(64)}` })],
    ["malformed digest", confirmation({ diffDigest: "sha256:not-a-digest" })],
    ["source commit", confirmation({ sourceCommit: "3333333333333333333333333333333333333333" })],
    ["target head", confirmation({ expectedTargetHead: "4444444444444444444444444444444444444444" })],
  ];
  for (const [label, sent] of cases) {
    assert.throws(
      () => assertIntegrationConfirmation(preview, sent, revalidation()),
      (error: unknown) => error instanceof CommandIntentError && error.code === "invalid_request",
      label,
    );
  }
});

test("repository state that moved after the preview blocks the integration", () => {
  const cases: ReadonlyArray<readonly [string, Partial<IntegrationRevalidation>]> = [
    ["expired preview", { now: new Date("2026-08-05T10:05:00.000Z") }],
    ["source branch moved", { observedSourceCommit: "5555555555555555555555555555555555555555" }],
    ["target branch moved", { observedTargetHead: "6666666666666666666666666666666666666666" }],
    ["dirty target", { observedTargetClean: false }],
    ["diff changed", { observedDiffDigest: `sha256:${"e".repeat(64)}` }],
    ["gates changed", { observedGateDigest: `sha256:${"f".repeat(64)}` }],
    ["gates failed", { observedGatesPassed: false }],
  ];
  for (const [label, drift] of cases) {
    assert.throws(
      () => assertIntegrationConfirmation(preview, confirmation(), revalidation(drift)),
      (error: unknown) => error instanceof CommandIntentError && error.code === "conflict",
      label,
    );
  }
});

test("a reused preview is a duplicate request rather than a second merge", () => {
  assert.throws(
    () => assertIntegrationConfirmation(preview, confirmation(), revalidation({ previewConsumed: true })),
    (error: unknown) => error instanceof CommandIntentError && error.code === "duplicate_request",
  );
});

test("integration requires the local OS owner and a local re-auth proof", () => {
  // `exactOptionalPropertyTypes`: sąrašas anotuojamas aiškiai, kad antrasis aktorius reikštų
  // „lauko NĖRA", o ne „laukas yra ir jis `undefined`" — būtent to ir klausia šis testas.
  const actors: ReadonlyArray<IntegrationRevalidation["actor"]> = [
    { isLocalOsOwner: false, reauthenticatedAt: "2026-08-05T09:59:50.000Z" },
    { isLocalOsOwner: true },
  ];
  for (const actor of actors) {
    assert.throws(
      () => assertIntegrationConfirmation(preview, confirmation(), revalidation({ actor })),
      (error: unknown) => error instanceof CommandIntentError && error.code === "forbidden",
    );
  }
});

test("command intent error codes are a subset of the gateway error envelope", () => {
  const codes: readonly CommandIntentErrorCode[] = [
    "forbidden",
    "invalid_request",
    "duplicate_request",
    "conflict",
  ];
  for (const code of codes) {
    assert.ok(
      (GATEWAY_ERROR_CODES as readonly string[]).includes(code),
      `${code} must exist in the versioned error envelope`,
    );
  }
});

/**
 * `design.md` §10 keeps GitHub off the terminal: mobile never generates a `gh`
 * or `git` command line. That holds only while the port offers no method that
 * accepts one, which is what this asserts on the declaration itself.
 */
test("the GitHub port exposes named operations and no command surface", async () => {
  const file = path.join(sourceRoot, "application/ports/git-host-port.ts");
  const text = await readFile(file, "utf8");
  const declaration = text.slice(text.indexOf("export interface GitHostPort"));
  assert.match(declaration, /createPullRequest\s*\(/);
  assert.doesNotMatch(declaration, /\b(?:run|exec|shell|spawn|command|args|raw)\s*\(/, file);
});

test("the GitHub port surfaces no authorization material", async () => {
  const file = path.join(sourceRoot, "application/ports/git-host-port.ts");
  const text = await readFile(file, "utf8");
  assert.doesNotMatch(
    text,
    /^\s*(?:readonly\s+)?[A-Za-z]*(?:token|secret|password|credential)[A-Za-z]*\??:/im,
    file,
  );
});

/**
 * Repository mutations must carry the binding, the idempotency key and the id
 * of the approved command. Connection-level operations (`beginAuthorization`,
 * `revokeConnection`) are deliberately excluded: they touch no repository and
 * are gated by the owner-only classification in `COMMAND_AUTHORITY`.
 */
test("every repository write on the GitHub port requires a write context", async () => {
  const file = path.join(sourceRoot, "application/ports/git-host-port.ts");
  const text = await readFile(file, "utf8");
  const declaration = text.slice(text.indexOf("export interface GitHostPort"));
  const methods = [...declaration.matchAll(/^ {2}(\w+)\(([\s\S]*?)\): Promise/gm)];
  assert.ok(methods.length >= 8, "the port declaration must be parsed, not silently skipped");
  const writes = methods.filter(([, name]) => /^(?:create|update|delete|import|merge|close)/.test(name ?? ""));
  assert.ok(writes.length > 0, "at least one repository write must exist");
  for (const [, name, parameters] of writes) {
    assert.match(parameters ?? "", /GitHostWriteContext/, `${name} must require a GitHostWriteContext`);
  }
});
