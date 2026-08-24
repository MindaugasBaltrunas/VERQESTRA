import assert from "node:assert/strict";
import test from "node:test";
import { commandDigestOf, type CommandApprovalProof } from "../application/command-approval-service.js";
import {
  actions,
  connectIntent,
  countingExecutor,
  DEVICE_ID,
  harness,
  OTHER_DEVICE_ID,
  owner,
  pullRequestIntent,
  rejects,
} from "./command-approval-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 843 eilutės).
 *
 * Čia lieka pats SPRENDIMAS: kada komanda vykdoma, kada atmetama ir ką reiškia patvirtinimas,
 * kurio operatorius nematė. Idempotencijos ledger'is, audito redakcija ir rašymo konteksto
 * antspaudas — `command-approval-ledger.test.ts`; GitHub mutacijos —
 * `github-mutation-service.test.ts`. Bendra fikstūra — `command-approval-doubles.ts`.
 */

/* --------------------------------------------------------------------- *
 * Approve
 * --------------------------------------------------------------------- */

test("a confirm-risk command is not executed until it is approved", async () => {
  const { approvals, audit } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent();

  const first = await approvals.execute({ intent, principal: owner() }, executor.run);

  assert.equal(first.executed, false);
  assert.equal(first.outcome.decision, "confirmation_required");
  assert.equal(first.outcome.risk, "confirm");
  assert.equal(first.outcome.commandDigest, commandDigestOf(intent));
  assert.ok(first.outcome.approvalChallengeId);
  assert.ok(first.outcome.approvalExpiresAt);
  assert.equal(executor.calls, 0);
  assert.deepEqual(actions(audit), ["command.approval.challenge:allowed"]);
});

test("returning the challenge and the shown digest runs the command exactly once", async () => {
  const { approvals, audit } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent();

  const challenge = await approvals.execute({ intent, principal: owner() }, executor.run);
  const approval: CommandApprovalProof = {
    approvalChallengeId: challenge.outcome.approvalChallengeId as string,
    commandDigest: challenge.outcome.commandDigest as string,
  };
  const confirmed = await approvals.execute({ intent, principal: owner(), approval }, executor.run);

  assert.equal(confirmed.executed, true);
  assert.equal(confirmed.outcome.decision, "accepted");
  assert.equal(confirmed.executed === true ? confirmed.result : undefined, "ran:command-1:1");
  assert.equal(executor.calls, 1);
  assert.deepEqual(actions(audit), [
    "command.approval.challenge:allowed",
    "command.submit:allowed",
    "command.execute:allowed",
  ]);
});

test("a safe command needs no approval and is accepted on submission", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent({
    action: "github.issue.import",
    payload: { issueNumber: 42 },
  });

  const result = await approvals.execute({ intent, principal: owner() }, executor.run);

  assert.equal(result.executed, true);
  assert.equal(result.outcome.risk, "safe");
  assert.equal(executor.calls, 1);
});

/* --------------------------------------------------------------------- *
 * Deny
 * --------------------------------------------------------------------- */

test("a command without the required scope is refused and audited, never run", async () => {
  const { approvals, audit } = harness();
  const executor = countingExecutor();

  const result = await approvals.execute(
    { intent: pullRequestIntent(), principal: owner({ scopes: ["ag:read", "github:read"] }) },
    executor.run,
  );

  assert.equal(result.executed, false);
  assert.equal(result.outcome.decision, "rejected");
  assert.equal(result.outcome.reasonCode, "forbidden");
  assert.equal(executor.calls, 0);
  assert.deepEqual(actions(audit), ["command.submit:denied"]);
  assert.equal(audit.entries()[0]?.reasonCode, "forbidden");
});

test("an owner-only command from a non-owner device is refused", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();

  const result = await approvals.execute(
    { intent: connectIntent(), principal: owner({ isOwner: false }) },
    executor.run,
  );

  assert.equal(result.executed, false);
  assert.equal(result.outcome.reasonCode, "forbidden");
  assert.equal(executor.calls, 0);
});

test("a blocked action can never be approved into an execution", async () => {
  const { approvals, audit } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent({ action: "git.integration.merge", payload: {} });

  const result = await approvals.execute({ intent, principal: owner() }, executor.run);

  assert.equal(result.executed, false);
  assert.equal(result.outcome.decision, "rejected");
  assert.equal(result.outcome.risk, "blocked");
  assert.equal(executor.calls, 0);
  assert.deepEqual(actions(audit), ["command.submit:denied"]);
});

test("an intent submitted for another device never reaches the ledger", async () => {
  const { approvals, audit } = harness();
  const executor = countingExecutor();

  await rejects(
    () => approvals.execute(
      { intent: pullRequestIntent({ deviceId: OTHER_DEVICE_ID }), principal: owner() },
      executor.run,
    ),
    "forbidden",
  );
  assert.equal(executor.calls, 0);
  assert.deepEqual(actions(audit), ["command.submit:denied"]);
});

test("an idempotency key minted for another device is refused", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();

  await rejects(
    () => approvals.execute(
      { intent: pullRequestIntent({ idempotencyKey: `${OTHER_DEVICE_ID}:7` }), principal: owner() },
      executor.run,
    ),
    "forbidden",
  );
  assert.equal(executor.calls, 0);
});

/* --------------------------------------------------------------------- *
 * Expired and mismatched approvals
 * --------------------------------------------------------------------- */

test("an expired approval challenge cannot be confirmed", async () => {
  const { approvals, audit, advance } = harness({ approvalTtlMs: 60_000 });
  const executor = countingExecutor();
  const intent = pullRequestIntent();

  const challenge = await approvals.execute({ intent, principal: owner() }, executor.run);
  advance(60_000);

  await rejects(
    () => approvals.execute(
      {
        intent,
        principal: owner(),
        approval: {
          approvalChallengeId: challenge.outcome.approvalChallengeId as string,
          commandDigest: challenge.outcome.commandDigest as string,
        },
      },
      executor.run,
    ),
    "conflict",
  );
  assert.equal(executor.calls, 0);
  assert.deepEqual(actions(audit), [
    "command.approval.challenge:allowed",
    "command.submit:denied",
  ]);
  assert.equal(audit.entries()[1]?.reasonCode, "conflict");
});

test("a digest the operator never saw cannot be approved", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent();

  const challenge = await approvals.execute({ intent, principal: owner() }, executor.run);

  await rejects(
    () => approvals.execute(
      {
        intent,
        principal: owner(),
        approval: {
          approvalChallengeId: challenge.outcome.approvalChallengeId as string,
          commandDigest: `sha256:${"0".repeat(64)}`,
        },
      },
      executor.run,
    ),
    "invalid_request",
  );
  assert.equal(executor.calls, 0);
});

test("an approval shown for one command cannot execute a different one", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();
  const shown = pullRequestIntent();
  const swapped = pullRequestIntent({
    payload: { sessionId: "session-1", title: "Delete the production branch", draft: false },
  });

  const challenge = await approvals.execute({ intent: shown, principal: owner() }, executor.run);

  await rejects(
    () => approvals.execute(
      {
        intent: swapped,
        principal: owner(),
        approval: {
          approvalChallengeId: challenge.outcome.approvalChallengeId as string,
          commandDigest: challenge.outcome.commandDigest as string,
        },
      },
      executor.run,
    ),
    "invalid_request",
  );
  assert.equal(executor.calls, 0);
});

test("an approval challenge is single use", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent();

  const challenge = await approvals.execute({ intent, principal: owner() }, executor.run);
  const approval: CommandApprovalProof = {
    approvalChallengeId: challenge.outcome.approvalChallengeId as string,
    commandDigest: challenge.outcome.commandDigest as string,
  };
  await approvals.execute({ intent, principal: owner(), approval }, executor.run);

  // A different key, so the ledger cannot be what refuses the second attempt.
  await rejects(
    () => approvals.execute(
      {
        intent: pullRequestIntent({ idempotencyKey: `${DEVICE_ID}:8` }),
        principal: owner(),
        approval,
      },
      executor.run,
    ),
    "duplicate_request",
  );
  assert.equal(executor.calls, 1);
});

test("a refused confirm still burns its approval", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent();

  const challenge = await approvals.execute({ intent, principal: owner() }, executor.run);
  const approval: CommandApprovalProof = {
    approvalChallengeId: challenge.outcome.approvalChallengeId as string,
    commandDigest: challenge.outcome.commandDigest as string,
  };
  // Scope was withdrawn between the approval and the confirm.
  const refused = await approvals.execute(
    { intent, principal: owner({ scopes: ["ag:read"] }), approval },
    executor.run,
  );
  assert.equal(refused.outcome.decision, "rejected");

  await rejects(
    () => approvals.execute(
      { intent: pullRequestIntent({ idempotencyKey: `${DEVICE_ID}:9` }), principal: owner(), approval },
      executor.run,
    ),
    "duplicate_request",
  );
  assert.equal(executor.calls, 0);
});

test("an approval belongs to the device it was issued to", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent();

  const challenge = await approvals.execute({ intent, principal: owner() }, executor.run);

  await rejects(
    () => approvals.execute(
      {
        intent: pullRequestIntent({
          deviceId: OTHER_DEVICE_ID,
          idempotencyKey: `${OTHER_DEVICE_ID}:7`,
        }),
        principal: owner({ deviceId: OTHER_DEVICE_ID }),
        approval: {
          approvalChallengeId: challenge.outcome.approvalChallengeId as string,
          commandDigest: challenge.outcome.commandDigest as string,
        },
      },
      executor.run,
    ),
    "forbidden",
  );
  assert.equal(executor.calls, 0);
});

test("an unknown approval challenge is refused", async () => {
  const { approvals } = harness();
  const executor = countingExecutor();
  const intent = pullRequestIntent();

  await rejects(
    () => approvals.execute(
      {
        intent,
        principal: owner(),
        approval: { approvalChallengeId: "never-issued", commandDigest: commandDigestOf(intent) },
      },
      executor.run,
    ),
    "invalid_request",
  );
  assert.equal(executor.calls, 0);
});
