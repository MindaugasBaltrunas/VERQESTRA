import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CommandAuditError,
  gitHostWriteContext,
} from "../application/command-approval-service.js";
import type { AuditEvent, AuditPort } from "../application/ports/audit-port.js";
import type { GitHostWriteContext } from "../application/ports/git-host-port.js";
import { CommandIntentError } from "../domain/command-intent.js";
import {
  actions,
  connectIntent,
  countingExecutor,
  harness,
  IDEMPOTENCY_KEY,
  owner,
  pullRequestIntent,
  rejects,
} from "./command-approval-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `command-approval.test.ts` buvo 843 eilutės).
 *
 * Čia — kas lieka PO sprendimo: idempotencijos ledger'is, audito redakcija ir GitHub rašymo
 * konteksto antspaudas. Pats sprendimas (patvirtinti / atmesti) gyvena `command-approval.test.ts`.
 */

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const sourceRoot = path.join(packageRoot, "src");

/* --------------------------------------------------------------------- *
 * Idempotency ledger
 * --------------------------------------------------------------------- */

test("a replayed accepted command returns the first result without running again", async () => {
  const { approvals, audit } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent({
    action: "github.issue.import",
    payload: { issueNumber: 42 },
  });

  const first = await approvals.execute({ intent, principal: owner() }, executor.run);
  const replay = await approvals.execute({ intent, principal: owner() }, executor.run);

  assert.equal(first.executed && replay.executed, true);
  assert.equal(replay.executed === true ? replay.result : undefined, "ran:command-1:1");
  assert.equal(replay.outcome.decision, "duplicate");
  assert.equal(replay.outcome.reasonCode, "duplicate_request");
  assert.equal(executor.calls, 1);
  assert.deepEqual(actions(audit), [
    "command.submit:allowed",
    "command.execute:allowed",
    "command.submit:denied",
  ]);
});

test("a replayed rejection stays a rejection instead of being re-decided", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent({
    action: "github.issue.import",
    payload: { issueNumber: 42 },
  });

  await approvals.execute({ intent, principal: owner({ scopes: ["ag:read"] }) }, executor.run);
  const replay = await approvals.execute({ intent, principal: owner() }, executor.run);

  assert.equal(replay.executed, false);
  assert.equal(replay.outcome.decision, "duplicate");
  assert.equal(executor.calls, 0);
});

test("an idempotency key reused for another command is refused, not served", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();

  await approvals.execute(
    {
      intent: pullRequestIntent({ action: "github.issue.import", payload: { issueNumber: 42 } }),
      principal: owner(),
    },
    executor.run,
  );

  await rejects(
    () => approvals.execute(
      {
        intent: pullRequestIntent({ action: "github.issue.import", payload: { issueNumber: 43 } }),
        principal: owner(),
      },
      executor.run,
    ),
    "duplicate_request",
  );
  assert.equal(executor.calls, 1);
});

test("a mutation that failed releases its key so the operator can retry", async () => {
  const { approvals, audit } = harness();
  let attempts = 0;
  const flaky = async (): Promise<string> => {
    attempts += 1;
    if (attempts === 1) throw new Error("host refused");
    return "second attempt";
  };
  const intent = pullRequestIntent({
    action: "github.issue.import",
    payload: { issueNumber: 42 },
  });

  await assert.rejects(() => approvals.execute({ intent, principal: owner() }, flaky));
  const retry = await approvals.execute({ intent, principal: owner() }, flaky);

  assert.equal(retry.executed === true ? retry.result : undefined, "second attempt");
  assert.equal(attempts, 2);
  assert.deepEqual(actions(audit), [
    "command.submit:allowed",
    "command.execute:failed",
    "command.submit:allowed",
    "command.execute:allowed",
  ]);
});

/* --------------------------------------------------------------------- *
 * Audit redaction and fail-closed recording
 * --------------------------------------------------------------------- */

test("no approval record can carry payload text, a challenge or an idempotency key", async () => {
  const { approvals, audit } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent();

  const challenge = await approvals.execute({ intent, principal: owner() }, executor.run);
  await approvals.execute(
    {
      intent,
      principal: owner(),
      approval: {
        approvalChallengeId: challenge.outcome.approvalChallengeId as string,
        commandDigest: challenge.outcome.commandDigest as string,
      },
    },
    executor.run,
  );

  const serialized = JSON.stringify(audit.entries());
  assert.doesNotMatch(serialized, /Fix the failing dispatch tests/);
  assert.doesNotMatch(serialized, /session-1/);
  assert.ok(!serialized.includes(IDEMPOTENCY_KEY));
  assert.ok(!serialized.includes(challenge.outcome.approvalChallengeId as string));
  assert.ok(!serialized.includes(challenge.outcome.commandDigest as string));

  const allowed: ReadonlySet<string> = new Set([
    "eventId",
    "occurredAt",
    "action",
    "outcome",
    "correlationId",
    "principalId",
    "deviceId",
    "projectId",
    "sessionId",
    "requestId",
    "reasonCode",
  ]);
  for (const event of audit.entries()) {
    for (const key of Object.keys(event)) {
      assert.ok(allowed.has(key), `audit record carries an unexpected field: ${key}`);
    }
    assert.equal(event.requestId, intent.commandId);
  }
});

test("a command whose decision cannot be audited never runs", async () => {
  const failing: AuditPort = {
    async record(_event: AuditEvent) {
      throw new Error("disk full");
    },
  };
  const { approvals } = harness({ audit: failing });
  const executor = countingExecutor();
  const intent = pullRequestIntent({
    action: "github.issue.import",
    payload: { issueNumber: 42 },
  });

  await assert.rejects(
    () => approvals.execute({ intent, principal: owner() }, executor.run),
    (error: unknown) => error instanceof CommandAuditError,
  );
  assert.equal(executor.calls, 0);

  // The reservation was released with the failure, so a retry is still possible.
  await assert.rejects(
    () => approvals.execute({ intent, principal: owner() }, executor.run),
    (error: unknown) => error instanceof CommandAuditError,
  );
  assert.equal(executor.calls, 0);
});

/* --------------------------------------------------------------------- *
 * The write-context seal
 * --------------------------------------------------------------------- */

test("a GitHub write context can only be built from an approved command", async () => {
  const { approvals } = harness();
  const intent = pullRequestIntent({
    action: "github.issue.import",
    payload: { issueNumber: 42 },
  });
  let write: GitHostWriteContext | undefined;

  await approvals.execute({ intent, principal: owner() }, async (approved) => {
    write = gitHostWriteContext(approved, "owner/repository");
    return undefined;
  });

  assert.deepEqual(write, {
    projectId: "project-1",
    expectedRepository: "owner/repository",
    idempotencyKey: IDEMPOTENCY_KEY,
    approvedCommandId: "command-1",
  });
});

test("a host-wide approved command cannot be turned into a repository write", async () => {
  const { approvals } = harness();
  const intent = connectIntent({ action: "github.issue.import", payload: { issueNumber: 42 } });
  delete (intent as { projectId?: string }).projectId;

  await approvals.execute({ intent, principal: owner() }, async (approved) => {
    assert.throws(
      () => gitHostWriteContext(approved, "owner/repository"),
      (error: unknown) => error instanceof CommandIntentError && error.code === "invalid_request",
    );
    return undefined;
  });
});

async function productionFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "tests" ? [] : productionFiles(absolute);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  }));
  return nested.flat();
}

/**
 * The two files allowed to name `approvedCommandId`: the port that DECLARES the
 * field, and the approval service that is the only place able to fill it.
 */
const APPROVED_WRITE_OWNERS: ReadonlySet<string> = new Set([
  "git-host-port.ts",
  "command-approval-service.ts",
]);

/**
 * The type-level seal is the real guarantee; this is the statement of it that a
 * reviewer can read. A production file that assigns `approvedCommandId` outside
 * the approval service is building a GitHub write without a decision, whatever
 * the surrounding code claims.
 */
test("no production file builds an approved write outside the approval service", async () => {
  for (const file of await productionFiles(sourceRoot)) {
    if (APPROVED_WRITE_OWNERS.has(path.basename(file))) continue;
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(
      text,
      /\bapprovedCommandId\s*:/,
      `${file} constructs an approved write context outside the approval gate`,
    );
  }
});
