import assert from "node:assert/strict";
import test from "node:test";

import type {
  CheckExecutionPort,
  CheckExecutionRequest,
  CheckExecutionResult,
} from "../application/verify/check-execution-port.js";
import {
  CHECK_TIMEOUT_MS_CEILING,
  IndependentAcceptanceVerifier,
  checkTimeoutMs,
} from "../application/verify/independent-acceptance-verifier.js";
import type { AcceptanceVerificationRequest } from "../application/ports/acceptance-verifier-port.js";
import { VERIFIER_GATE_IDS } from "../domain/verification/acceptance.js";
import { ACCEPTANCE_REJECTION_CODES } from "../domain/verification/rejection-reasons.js";
import { scenario, START_COMMIT, WORKTREE_PATH } from "./execution-fixtures.js";
import { SYNTHETIC_SECRETS } from "./secret-samples.js";

/**
 * The verifier as a whole (BENCH-6).
 *
 * The check port is a double, because what is under test is what the verifier
 * concludes from a check's outcome — not whether a process can be started. The
 * cases that matter are the ones where the agent said it was done: a passing
 * suite it did not touch, a suite that never ran, a suite it broke.
 */

/** Answers every check with a scripted result, or throws when the test asked it to. */
class FakeChecks implements CheckExecutionPort {
  readonly requests: CheckExecutionRequest[] = [];

  constructor(
    private readonly answer: (request: CheckExecutionRequest) => CheckExecutionResult,
    private readonly failure?: Error,
  ) {}

  async run(request: CheckExecutionRequest): Promise<CheckExecutionResult> {
    this.requests.push(request);
    if (this.failure !== undefined) throw this.failure;
    return this.answer(request);
  }
}

function checkResult(overrides: Partial<CheckExecutionResult> = {}): CheckExecutionResult {
  return { exitCode: 0, signal: null, timedOut: false, output: "", ...overrides };
}

const TWO_CHECKS = scenario({
  checks: [
    { id: "task-store-regression", command: ["node", "--test", "test/store.mjs"], expect: "pass" },
    { id: "task-tags", command: ["node", "--test", "test/tags.mjs"], expect: "pass" },
  ],
  allowedPaths: ["src/**", "test/**"],
});

function request(
  overrides: Partial<AcceptanceVerificationRequest> = {},
): AcceptanceVerificationRequest {
  return {
    scenario: TWO_CHECKS,
    worktree: { id: "task-tags-0001", path: WORKTREE_PATH, startCommit: START_COMMIT },
    changedFiles: ["src/task-store.mjs", "test/tags.mjs"],
    agentClaimedDone: true,
    ...overrides,
  };
}

/** A clock that advances a millisecond per reading, so durations are positive and deterministic. */
function tickingClock(): () => number {
  let now = 0;
  return () => (now += 1);
}

function verifier(checks: CheckExecutionPort): IndependentAcceptanceVerifier {
  return new IndependentAcceptanceVerifier({ checks, monotonicMs: tickingClock() });
}

test("the verifier runs the scenario's own checks in the isolated checkout", async () => {
  const checks = new FakeChecks(() => checkResult());
  const result = await verifier(checks).verify(request());

  assert.equal(result.decision.verdict, "verified-accepted");
  assert.deepEqual(
    checks.requests.map((run) => [run.command, ...run.args]),
    [
      ["node", "--test", "test/store.mjs"],
      ["node", "--test", "test/tags.mjs"],
    ],
  );
  for (const run of checks.requests) {
    assert.equal(run.cwd, WORKTREE_PATH, "a check ran outside the isolated checkout");
    assert.equal(run.timeoutMs, checkTimeoutMs(TWO_CHECKS));
  }
});

test("a check is bounded by the ceiling even when the scenario declares a longer run", () => {
  const long = scenario({ limits: { timeoutMs: 3_600_000, tokenLimit: 100_000 } });
  assert.equal(checkTimeoutMs(long), CHECK_TIMEOUT_MS_CEILING);
  const short = scenario({ limits: { timeoutMs: 60_000, tokenLimit: 100_000 } });
  assert.equal(checkTimeoutMs(short), 60_000);
});

test("a claimed done over a failing check is rejected", async () => {
  const checks = new FakeChecks((run) =>
    run.args.includes("test/tags.mjs")
      ? checkResult({ exitCode: 1, output: "1 failing" })
      : checkResult(),
  );
  const result = await verifier(checks).verify(request());

  assert.equal(result.decision.verdict, "rejected");
  assert.deepEqual(result.decision.reasons, [ACCEPTANCE_REJECTION_CODES.checkFailed]);
  assert.equal(result.evidence.falseCompleteClaim, true);
  assert.equal(
    result.checks.find((check) => check.id === "task-tags")?.status,
    "failed",
  );
});

test("a claimed done over an untouched checkout is rejected", async () => {
  const result = await verifier(new FakeChecks(() => checkResult())).verify(
    request({ changedFiles: [] }),
  );
  assert.equal(result.decision.verdict, "rejected");
  assert.ok(result.decision.reasons.includes(ACCEPTANCE_REJECTION_CODES.emptyChange));
  assert.equal(result.decision.agentClaimedDone, true);
});

test("a check killed at its timeout is inconclusive, not a failure", async () => {
  const checks = new FakeChecks(() =>
    checkResult({ exitCode: null, signal: "SIGTERM", timedOut: true }),
  );
  const result = await verifier(checks).verify(request());

  assert.equal(result.decision.verdict, "inconclusive");
  assert.deepEqual(result.decision.reasons, [ACCEPTANCE_REJECTION_CODES.checkErrored]);
});

test("a check the verifier could not start at all is inconclusive", async () => {
  const checks = new FakeChecks(() => checkResult(), new Error("spawn node ENOENT"));
  const result = await verifier(checks).verify(request());

  assert.equal(result.decision.verdict, "inconclusive");
  assert.deepEqual(result.decision.reasons, [ACCEPTANCE_REJECTION_CODES.checkErrored]);
  assert.match(result.evidence.reasons[0]?.detail ?? "", /spawn node ENOENT/);
});

test("a run with no checkout is verified against nothing and executes no check", async () => {
  const checks = new FakeChecks(() => checkResult());
  const result = await verifier(checks).verify(
    request({ worktree: { id: "", path: "", startCommit: "" } }),
  );

  assert.equal(result.decision.verdict, "inconclusive");
  assert.ok(result.decision.reasons.includes(ACCEPTANCE_REJECTION_CODES.evidenceMissing));
  assert.deepEqual(checks.requests, [], "a check was run without a checkout to run it in");
  assert.equal(statusOf(result.checks, "task-tags"), "skipped");
  assert.equal(statusOf(result.checks, VERIFIER_GATE_IDS.allowedPaths), "errored");
});

test("a secret in a failing check's output does not reach the recorded evidence", async () => {
  const checks = new FakeChecks(() =>
    checkResult({ exitCode: 1, output: `failed with api_key="${SYNTHETIC_SECRETS.openaiApiKey}"` }),
  );
  const result = await verifier(checks).verify(request());

  const detail = result.evidence.reasons.map((reason) => reason.detail).join(" ");
  assert.ok(
    !detail.includes(SYNTHETIC_SECRETS.openaiApiKey),
    "a credential a check printed reached the recorded evidence",
  );
  assert.match(detail, /api_key="?\[redacted\]/);
});

test("the verifier reads the agent's claim as evidence and never as a gate", async () => {
  const failing = new FakeChecks(() => checkResult({ exitCode: 1 }));
  const claimed = await verifier(failing).verify(request({ agentClaimedDone: true }));
  const silent = await verifier(new FakeChecks(() => checkResult({ exitCode: 1 }))).verify(
    request({ agentClaimedDone: false }),
  );

  assert.equal(claimed.decision.verdict, silent.decision.verdict);
  assert.deepEqual(claimed.decision.reasons, silent.decision.reasons);
  assert.equal(claimed.decision.agentClaimedDone, true);
  assert.equal(silent.decision.agentClaimedDone, false);
  assert.equal(silent.evidence.falseCompleteClaim, false);
});

test("a passing run that also wrote outside its scope is rejected", async () => {
  const result = await verifier(new FakeChecks(() => checkResult())).verify(
    request({ changedFiles: ["src/task-store.mjs", "docs/notes.md"] }),
  );

  assert.equal(result.decision.verdict, "rejected");
  assert.deepEqual(result.outOfScopeFiles, ["docs/notes.md"]);
  assert.deepEqual(result.decision.reasons, [ACCEPTANCE_REJECTION_CODES.outOfScopeChange]);
});

function statusOf(checks: readonly { id: string; status: string }[], id: string): string {
  const found = checks.find((check) => check.id === id);
  assert.ok(found !== undefined, `no result was reported for "${id}"`);
  return found.status;
}
