import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  AcceptanceVerification,
  AcceptanceVerificationRequest,
  AcceptanceVerifierPort,
} from "../application/ports/acceptance-verifier-port.js";
import {
  executeBenchmarkRun,
  type BenchmarkRunExecution,
  type IsolatedSampleRunnerPort,
} from "../application/run/execute-benchmark-run.js";
import type {
  IsolatedRunInspector,
  IsolatedSampleRequest,
} from "../application/run/isolated-sample-runner.js";
import type { IsolatedSampleRun } from "../application/run/isolated-run-record.js";
import {
  AgentProcessTreeAbandonedError,
  NodeAgentProcessRunner,
} from "../infrastructure/adapters/node-agent-process-runner.js";
import { JsonlSampleStore } from "../infrastructure/jsonl-sample-store.js";
import { findLatestRunLedger, runLedgerPath } from "../infrastructure/run-ledger-store.js";
import { RecordingRunIdentityStore, scenario } from "./execution-fixtures.js";
import { RUN_IDENTITY_RUN_ID, runIdentityRecord } from "./run-identity-fixtures.js";

/**
 * The two guarantees task 0028 adds to a sample that ran out of time.
 *
 * 1. The kill reaches the whole OS process tree, grandchildren included, and
 *    `NodeAgentProcessRunner.run` does not resolve until that is confirmed —
 *    the field incident this task starts from left ~20 orphaned `node --test`
 *    grandchildren running after the harness had already moved on.
 * 2. A timeout is data, not a silent gap: it leaves a durable JSONL trace and
 *    the run continues to the next cell, rather than a lost sample whose only
 *    evidence was a console line nobody kept.
 */

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");

/** True while `pid` still names a live process, on either host. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawns a grandchild that ignores `SIGTERM` and writes its own pid to
 * `GRANDCHILD_PID_FILE` before the parent itself starts ignoring `SIGTERM` too —
 * an agent process shaped like the `node --test` case from the field incident,
 * where the measured process is not the only one left running past the timeout.
 */
const SPAWNS_A_GRANDCHILD_AND_IGNORES_SIGTERM = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const grandchild = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000);"],
  { stdio: 'ignore' },
);
fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
setInterval(() => {}, 1000);
`;

/** Short enough that the test is decided by the grace period rather than by the wait for it. */
const TIMEOUT_MS = 300;

async function scratchDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ag-benchmark-tree-kill-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });
  return dir;
}

test("a timed-out sample's whole process tree is confirmed dead, grandchild included", async (t) => {
  const dir = await scratchDir(t);
  const pidFile = path.join(dir, "grandchild.pid");

  const result = await new NodeAgentProcessRunner().run({
    command: process.execPath,
    args: ["-e", SPAWNS_A_GRANDCHILD_AND_IGNORES_SIGTERM],
    cwd: packageRoot,
    timeoutMs: TIMEOUT_MS,
    env: { GRANDCHILD_PID_FILE: pidFile },
    stdin: "",
  });

  assert.equal(result.timedOut, true, "the sample ran out of time and the result does not say so");

  const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(
    Number.isInteger(grandchildPid) && grandchildPid > 0,
    "the grandchild's pid was never recorded, so the tree it started cannot be checked",
  );
  assert.equal(
    isAlive(grandchildPid),
    false,
    "the grandchild outlived the timeout that killed its parent — the tree-kill did not reach it",
  );
});

/**
 * The bound the timeout itself needs.
 *
 * `close` used to be the only event that could settle a run, which made the whole timeout
 * conditional on the kill working: on Windows `taskkill` was launched fire-and-forget with its
 * error discarded, so a kill that did not take produced no exit to observe and the promise waited
 * forever — with the suite behind it, and in the worst case a paid child still running. This test
 * hung for over two minutes in exactly that way before there was a deadline.
 *
 * The number is the sum this module states: the sample's own timeout, the grace period before the
 * unconditional kill, the tree verification, and the deadline after it — plus room for a slow
 * host. What it pins is that the wait is a number at all.
 */
const SETTLE_CEILING_MS = 45_000;

test("a kill that does not take still settles: the timeout has a deadline of its own", async (t) => {
  const dir = await scratchDir(t);
  const pidFile = path.join(dir, "grandchild.pid");
  const started = performance.now();

  // Either outcome is allowed and both are bounded: on a host where the kill takes, this is an
  // ordinary timed-out result; on one where something survives, it is an error. What may never
  // happen is a wait without an end, and what may never happen is a survivor reported as an
  // ordinary bounded run — the process behind it keeps calling a paid model.
  let outcome: "result" | "abandoned";
  try {
    const result = await new NodeAgentProcessRunner().run({
      command: process.execPath,
      args: ["-e", SPAWNS_A_GRANDCHILD_AND_IGNORES_SIGTERM],
      cwd: packageRoot,
      timeoutMs: TIMEOUT_MS,
      env: { GRANDCHILD_PID_FILE: pidFile },
      stdin: "",
    });
    assert.equal(result.timedOut, true);
    outcome = "result";
  } catch (error) {
    assert.ok(
      error instanceof AgentProcessTreeAbandonedError,
      `a timeout may end in a result or in an abandoned tree, not in ${String(error)}`,
    );
    assert.match((error as Error).message, /not confirmed gone/);
    outcome = "abandoned";
  }

  const elapsed = performance.now() - started;
  assert.ok(
    elapsed < SETTLE_CEILING_MS,
    `the run took ${String(Math.round(elapsed))}ms to ${outcome}; a timeout without a deadline is not a timeout`,
  );
});

test("a happy path that never times out is unaffected: no tree-kill, no extra wait", async (t) => {
  const dir = await scratchDir(t);
  const started = performance.now();

  const result = await new NodeAgentProcessRunner().run({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: packageRoot,
    timeoutMs: 60_000,
    env: {},
    stdin: "",
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.ok(
    performance.now() - started < 5_000,
    "a process that exited on its own must not wait on any tree-kill machinery",
  );
  void dir;
});

/** A minimal, schema-valid workspace capture: two distinct 40-hex commits, one changed file. */
function workspace(): IsolatedSampleRun["workspace"] {
  return {
    baseCommit: "a".repeat(40),
    finalCommit: "b".repeat(40),
    changedFiles: ["docs/new-page.md"],
    diff: { text: "+# new page\n", truncated: false, byteLength: 12 },
  };
}

/**
 * A runner double whose first repetition times out (no telemetry, the same
 * failure shape `ProcessExecutionAdapter` reports for a real timeout) and whose
 * second repetition completes normally — one plan, two cells, so the pipeline's
 * "continue past a timeout" behaviour is observed rather than assumed.
 */
class TimeoutThenCompleteRunner implements IsolatedSampleRunnerPort {
  readonly requests: IsolatedSampleRequest[] = [];

  async run(
    request: IsolatedSampleRequest,
    inspect?: IsolatedRunInspector,
  ): Promise<IsolatedSampleRun> {
    this.requests.push(request);

    if (request.repetition === 1) {
      return {
        scenarioId: request.scenario.id,
        mode: request.mode,
        repetition: request.repetition,
        worktreeId: "docs-add-page-0001",
        worktreePath: "/runs/run-0001/worktrees/docs-add-page-0001",
        startedAt: "2026-08-15T18:14:00.000Z",
        durationMs: request.scenario.limits.timeoutMs,
        agentDurationMs: request.scenario.limits.timeoutMs,
        exit: "agent-failed",
        failure: `timeout: the agent was killed after ${request.scenario.limits.timeoutMs} ms limit`,
        agentClaimedDone: false,
        telemetry: undefined,
        usage: undefined,
        compression: undefined,
        workspace: workspace(),
        cleanup: { result: "removed", reason: "" },
      };
    }

    await inspect?.({
      request,
      worktree: { id: "docs-add-page-0002", path: "/runs/run-0001/worktrees/docs-add-page-0002", startCommit: workspace().baseCommit },
      capture: workspace(),
      agentClaimedDone: true,
    });

    return {
      scenarioId: request.scenario.id,
      mode: request.mode,
      repetition: request.repetition,
      worktreeId: "docs-add-page-0002",
      worktreePath: "/runs/run-0001/worktrees/docs-add-page-0002",
      startedAt: "2026-08-15T18:16:00.000Z",
      durationMs: 4_200,
      agentDurationMs: 4_200,
      exit: "completed",
      failure: "",
      agentClaimedDone: true,
      telemetry: {
        model: "claude-opus-5",
        inputTokens: 1_000,
        outputTokens: 200,
        llmCalls: 3,
        attempts: 1,
        repairs: 0,
        humanReviewEvents: 0,
      },
      usage: undefined,
      compression: undefined,
      workspace: workspace(),
      cleanup: { result: "removed", reason: "" },
    };
  }
}

class FakeVerifier implements AcceptanceVerifierPort {
  async verify(request: AcceptanceVerificationRequest): Promise<AcceptanceVerification> {
    return {
      checks: request.scenario.checks.map((check) => ({
        id: check.id,
        kind: "test",
        status: "passed",
        durationMs: 10,
      })),
      outOfScopeFiles: [],
      decision: { verdict: "verified-accepted", reasons: [], agentClaimedDone: request.agentClaimedDone },
    };
  }
}

function execution(): BenchmarkRunExecution {
  return {
    scenarios: [scenario()],
    modes: ["ag-loop"],
    repetitions: 2,
    allowNetworkModels: false,
    identityRecord: runIdentityRecord(),
  };
}

test("a timeout leaves a durable JSONL trace and the run continues to the next cell", async (t) => {
  const dir = await scratchDir(t);
  const ledgerPath = runLedgerPath(RUN_IDENTITY_RUN_ID);
  const store = new JsonlSampleStore(ledgerPath, dir);
  const identity = new RecordingRunIdentityStore();
  const runner = new TimeoutThenCompleteRunner();

  const outcome = await executeBenchmarkRun(execution(), {
    runner,
    verifier: new FakeVerifier(),
    store,
    identity,
  });

  // AC3: the run did not abort on the first cell's timeout.
  assert.deepEqual(
    runner.requests.map((request) => request.repetition),
    [1, 2],
    "the runner must have been asked for the second cell after the first one timed out",
  );
  assert.equal(outcome.samples.length, 1, "only the completed cell became a stored sample");
  assert.equal(outcome.unmeasured.length, 1, "the timed-out cell is reported as unmeasured");
  assert.match(outcome.unmeasured[0]?.reason ?? "", /timeout:/);

  // AC2: the timeout is not only the in-memory list above — it is on disk.
  const unmeasuredPath = `${store.filePath.slice(0, -".jsonl".length)}.unmeasured.jsonl`;
  const unmeasuredText = await readFile(unmeasuredPath, "utf8");
  const unmeasuredLines = unmeasuredText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(unmeasuredLines.length, 1);
  assert.equal(unmeasuredLines[0]?.status, "timeout");
  assert.equal(unmeasuredLines[0]?.repetition, 1);
  assert.equal(unmeasuredLines[0]?.scenarioId, "docs-add-page");
  assert.match(String(unmeasuredLines[0]?.reason ?? ""), /timeout:/);

  // AC5/AC6 guard: the completed cell's own sample still reads back untouched.
  const { samples } = await store.readAll();
  assert.deepEqual(
    samples.map((sample) => sample.repetition),
    [2],
  );

  // The sidecar must never be mistaken for a run ledger by the "latest run" scan.
  const latest = await findLatestRunLedger(dir);
  assert.equal(latest, ledgerPath);
});
