// The deterministic offline smoke (BENCH-12): that it stays offline by construction, that its
// refusal checks are the ones a pull request depends on, and that the assembled CLI actually
// answers the contract against the real authored suite.
import assert from "node:assert/strict";
import test from "node:test";

import { BENCHMARK_EXIT_CODES } from "../interfaces/cli/benchmark-exit-codes.js";
import {
  OFFLINE_SMOKE_CHECKS,
  PAID_MODEL_ARGUMENTS,
  PaidModelArgumentError,
  assertOfflineArguments,
  renderOfflineSmokeReport,
  runOfflineSmoke,
  type OfflineSmokeCheck,
} from "../interfaces/cli/offline-smoke.js";
import { runOfflineSmokeCli } from "../interfaces/cli/offline-smoke-entrypoint.js";

function check(overrides: Partial<OfflineSmokeCheck> = {}): OfflineSmokeCheck {
  return {
    id: "sample",
    argv: ["validate"],
    expect: "ok",
    why: "fixture",
    ...overrides,
  };
}

test("no declared check may permit paid model execution", () => {
  assert.doesNotThrow(() => {
    assertOfflineArguments();
  });
  for (const declared of OFFLINE_SMOKE_CHECKS) {
    for (const argument of declared.argv) {
      assert.ok(
        !PAID_MODEL_ARGUMENTS.includes(argument.split("=")[0]),
        `${declared.id} declares the paid-model argument ${argument}`,
      );
    }
  }
});

test("a check that names a paid-model argument is refused before anything runs", () => {
  for (const argument of [...PAID_MODEL_ARGUMENTS, "--allow-network=true"]) {
    assert.throws(
      () => {
        assertOfflineArguments([check({ argv: ["run", argument] })]);
      },
      PaidModelArgumentError,
      `${argument} was not refused`,
    );
  }
});

test("the smoke refuses to run a single check once one of them is a paid invocation", async () => {
  await assert.rejects(
    runOfflineSmoke({ checks: [check(), check({ id: "paid", argv: ["run", "--live"] })] }),
    PaidModelArgumentError,
  );
});

test("the refusal of a networked mode without permission is itself a gate check", () => {
  const refusals = OFFLINE_SMOKE_CHECKS.filter((declared) => declared.expect === "validationFailed");
  const networked = refusals.filter((declared) => declared.argv.includes("ag-loop") || declared.argv.includes("agent-solo"));
  assert.ok(networked.length >= 2, "both the planned and the live refusal must be covered");
  // One of them must be a live run: a dry run alone would never have executed anything anyway,
  // so it cannot show that a real run refuses before it spends.
  assert.ok(
    networked.some((declared) => !declared.argv.includes("--dry-run")),
    "no check asserts that a live networked run is refused before execution",
  );
});

test("every check answers the contract against the authored suite", async () => {
  const report = await runOfflineSmoke();
  for (const result of report.results) {
    assert.equal(
      result.actualExitCode,
      result.expectedExitCode,
      `${result.check.id}: ${result.check.why}\n${result.output.join("\n")}`,
    );
  }
  assert.equal(report.passed, true);
  assert.equal(report.results.length, OFFLINE_SMOKE_CHECKS.length);
});

test("the suite validates and the deterministic plan resolves without any network permission", async () => {
  const report = await runOfflineSmoke({
    checks: OFFLINE_SMOKE_CHECKS.filter((declared) => declared.expect === "ok"),
  });
  assert.equal(report.passed, true);
  const plan = report.results.find((result) => result.check.id === "deterministic-plan-resolves");
  assert.ok(plan, "the deterministic plan check is missing");
  assert.equal(plan.actualExitCode, BENCHMARK_EXIT_CODES.ok);
  // The plan is printed as JSON, so the log carries what the run would have cost.
  assert.match(plan.output.join("\n"), /"allowNetworkModels": false/);
});

test("a failed check is rendered with its reason and its output", () => {
  const lines = renderOfflineSmokeReport({
    passed: false,
    results: [
      {
        check: check({ id: "broken", why: "because it matters" }),
        expectedExitCode: 0,
        actualExitCode: 5,
        passed: false,
        output: ["the harness fell over"],
      },
    ],
  });
  const text = lines.join("\n");
  assert.match(text, /FAIL broken \(expected ok=0, got 5\)/);
  assert.match(text, /because it matters/);
  assert.match(text, /\| the harness fell over/);
  assert.match(text, /1 of 1 check\(s\) failed/);
});

test("the smoke entry point exits 0 on success and 1 on failure", async () => {
  const lines: string[] = [];
  assert.equal(await runOfflineSmokeCli({ out: (line) => lines.push(line) }), 0);
  assert.match(lines.join("\n"), /no model was called/);

  assert.equal(
    await runOfflineSmokeCli({
      checks: [check({ id: "wrong-expectation", argv: ["run", "--mode", "ag-loop", "--dry-run"], expect: "ok" })],
      out: () => undefined,
    }),
    1,
  );
});
