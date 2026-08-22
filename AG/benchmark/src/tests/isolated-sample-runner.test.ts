import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentExecutionOutcome,
  AgentExecutionPort,
  AgentExecutionRequest,
} from "../application/ports/agent-execution-port.js";
import type {
  IsolatedWorktree,
  IsolatedWorktreeRequest,
} from "../application/ports/worktree-port.js";
import type {
  IsolatedCleanupOutcome,
  IsolatedWorkspaceCapture,
  IsolatedWorkspacePort,
} from "../application/run/isolated-run-record.js";
import {
  IsolatedSampleRunner,
  type RunClock,
  type IsolatedSampleRequest,
} from "../application/run/isolated-sample-runner.js";
import { REDACTION_PLACEHOLDER } from "../application/secret-redaction.js";
import type { ExecutionMode, SampleTelemetry } from "../domain/result.js";
import type { BenchmarkScenario } from "../domain/scenario.js";
import { SYNTHETIC_SECRETS } from "./secret-samples.js";

/**
 * The order one isolated execution runs in, and what it records when a step of
 * that order fails (BENCH-4, BENCH-5).
 *
 * Every port is a double here on purpose: the question is what the runner does
 * with what it is told, and a real Git or a real agent would answer that
 * question with their own behaviour. The integration proof that the isolation
 * itself holds lives in `git-worktree-isolation.test.ts`.
 */

const BASE_COMMIT = "a".repeat(40);
const FINAL_COMMIT = "b".repeat(40);

const CAPTURE: IsolatedWorkspaceCapture = {
  baseCommit: BASE_COMMIT,
  finalCommit: FINAL_COMMIT,
  changedFiles: ["docs/new-page.md"],
  diff: { text: "+# new page\n", truncated: false, byteLength: 12 },
};

const TELEMETRY: SampleTelemetry = {
  model: "claude-opus-5",
  inputTokens: 1_000,
  outputTokens: 200,
  llmCalls: 3,
  attempts: 1,
  repairs: 0,
  humanReviewEvents: 0,
};

function scenario(overrides: Partial<BenchmarkScenario> = {}): BenchmarkScenario {
  return {
    id: "docs-add-page",
    title: "Add a documentation page",
    category: "docs",
    fixture: "fixtures/docs-site",
    task: "Add the missing page.",
    allowedPaths: ["docs/**"],
    forbiddenPaths: [],
    checks: [{ id: "docs", command: ["node", "--test"], expect: "pass" }],
    expectedOutcome: "accepted",
    limits: { timeoutMs: 60_000, tokenLimit: 100_000 },
    deterministic: false,
    ...overrides,
  };
}

function request(overrides: Partial<IsolatedSampleRequest> = {}): IsolatedSampleRequest {
  return {
    scenario: scenario(),
    mode: "ag-loop",
    repetition: 1,
    allowNetworkModels: false,
    ...overrides,
  };
}

/** A clock whose first reading starts the run and whose later readings are `elapsedMs` later. */
function fixedClock(elapsedMs: number): RunClock {
  let readings = 0;
  return {
    monotonicMs: () => (readings++ === 0 ? 1_000 : 1_000 + elapsedMs),
    wallClockIso: () => "2026-08-06T09:00:00.000Z",
  };
}

interface WorkspaceBehaviour {
  readonly createError?: Error;
  readonly captureError?: Error;
  readonly cleanupError?: Error;
  readonly cleanup?: IsolatedCleanupOutcome;
}

class FakeWorkspace implements IsolatedWorkspacePort {
  readonly created: IsolatedWorktreeRequest[] = [];
  readonly captured: string[] = [];
  readonly cleaned: string[] = [];

  constructor(private readonly behaviour: WorkspaceBehaviour = {}) {}

  async create(request: IsolatedWorktreeRequest): Promise<IsolatedWorktree> {
    this.created.push(request);
    if (this.behaviour.createError !== undefined) throw this.behaviour.createError;
    return { id: "docs-add-page-0001", path: "/runs/run-0001/worktrees/docs-add-page-0001", startCommit: BASE_COMMIT };
  }

  async capture(worktree: IsolatedWorktree): Promise<IsolatedWorkspaceCapture> {
    this.captured.push(worktree.id);
    if (this.behaviour.captureError !== undefined) throw this.behaviour.captureError;
    return CAPTURE;
  }

  async changedFiles(worktree: IsolatedWorktree): Promise<{
    readonly endCommit: string;
    readonly changedFiles: readonly string[];
  }> {
    const capture = await this.capture(worktree);
    return { endCommit: capture.finalCommit, changedFiles: capture.changedFiles };
  }

  async cleanupIsolated(worktree: IsolatedWorktree): Promise<IsolatedCleanupOutcome> {
    this.cleaned.push(worktree.id);
    if (this.behaviour.cleanupError !== undefined) throw this.behaviour.cleanupError;
    return this.behaviour.cleanup ?? { result: "removed", reason: "" };
  }

  async cleanup(worktree: IsolatedWorktree): Promise<IsolatedCleanupOutcome["result"]> {
    return (await this.cleanupIsolated(worktree)).result;
  }
}

class FakeAgent implements AgentExecutionPort {
  readonly adapterVersion = "fake-1";
  readonly requests: AgentExecutionRequest[] = [];

  constructor(
    readonly mode: ExecutionMode,
    private readonly behaviour: { readonly outcome?: AgentExecutionOutcome; readonly error?: Error } = {},
  ) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionOutcome> {
    this.requests.push(request);
    if (this.behaviour.error !== undefined) throw this.behaviour.error;
    return (
      this.behaviour.outcome ?? {
        telemetry: TELEMETRY,
        durationMs: 4_200,
        agentClaimedDone: true,
      }
    );
  }
}

function runnerWith(
  workspace: FakeWorkspace,
  agents: readonly AgentExecutionPort[],
  elapsedMs = 5_000,
): IsolatedSampleRunner {
  return new IsolatedSampleRunner({ worktrees: workspace, agents, clock: fixedClock(elapsedMs) });
}

test("a completed execution records its isolation evidence, cost and cleanup", async () => {
  const workspace = new FakeWorkspace();
  const agent = new FakeAgent("ag-loop");
  const run = await runnerWith(workspace, [agent]).run(request());

  assert.equal(run.exit, "completed");
  assert.equal(run.failure, "");
  assert.equal(run.scenarioId, "docs-add-page");
  assert.equal(run.mode, "ag-loop");
  assert.equal(run.repetition, 1);
  assert.equal(run.worktreeId, "docs-add-page-0001");
  assert.equal(run.startedAt, "2026-08-06T09:00:00.000Z");
  assert.equal(run.durationMs, 5_000);
  assert.equal(run.agentDurationMs, 4_200);
  assert.deepEqual(run.telemetry, TELEMETRY);
  assert.deepEqual(run.workspace, CAPTURE);
  assert.deepEqual(run.cleanup, { result: "removed", reason: "" });
  assert.equal(run.agentClaimedDone, true);
  assert.deepEqual(workspace.created, [
    { scenarioId: "docs-add-page", fixturePath: "fixtures/docs-site" },
  ]);
  assert.deepEqual(workspace.cleaned, ["docs-add-page-0001"]);
});

test("the adapter receives the scenario, the checkout and the network decision unchanged", async () => {
  const workspace = new FakeWorkspace();
  const agent = new FakeAgent("agent-solo");
  await runnerWith(workspace, [agent]).run(request({ mode: "agent-solo", allowNetworkModels: true }));

  assert.equal(agent.requests.length, 1);
  const received = agent.requests[0];
  assert.equal(received?.mode, "agent-solo");
  assert.equal(received?.allowNetworkModels, true);
  assert.equal(received?.scenario.id, "docs-add-page");
  assert.equal(received?.worktree.startCommit, BASE_COMMIT);
});

test("an agent that reports a failure is a measurement, and the checkout is still released", async () => {
  const workspace = new FakeWorkspace();
  const agent = new FakeAgent("ag-loop", {
    outcome: {
      telemetry: TELEMETRY,
      durationMs: 900,
      agentClaimedDone: false,
      failure: "the token limit was exceeded",
    },
  });

  const run = await runnerWith(workspace, [agent]).run(request());

  assert.equal(run.exit, "agent-failed");
  assert.equal(run.failure, "the token limit was exceeded");
  assert.deepEqual(run.telemetry, TELEMETRY, "a failed attempt still cost tokens");
  assert.deepEqual(run.cleanup, { result: "removed", reason: "" });
  assert.deepEqual(workspace.cleaned, ["docs-add-page-0001"]);
});

test("a timed-out agent is a measurement, not a harness crash, and carries no cost record (task 0028)", async () => {
  const workspace = new FakeWorkspace();
  const agent = new FakeAgent("ag-loop", {
    outcome: {
      durationMs: 60_000,
      agentClaimedDone: false,
      failure: "timeout: the agent was killed after 60000 ms limit",
    },
  });

  const run = await runnerWith(workspace, [agent]).run(request());

  assert.equal(run.exit, "agent-failed", "a killed process is a measurement attempt, not an absence of one");
  assert.match(run.failure, /^timeout:/);
  assert.equal(run.telemetry, undefined, "a killed agent never printed a cost record");
  assert.deepEqual(run.cleanup, { result: "removed", reason: "" }, "a timeout still releases its checkout normally");
  assert.deepEqual(workspace.cleaned, ["docs-add-page-0001"]);
});

test("an adapter that throws is a harness failure, and its checkout is kept for diagnosis", async () => {
  const workspace = new FakeWorkspace();
  const agent = new FakeAgent("ag-loop", { error: new Error("the dispatch process died") });

  const run = await runnerWith(workspace, [agent]).run(request());

  assert.equal(run.exit, "harness-failed");
  assert.match(run.failure, /the dispatch process died/);
  assert.equal(run.cleanup.result, "kept-for-diagnosis");
  assert.match(run.cleanup.reason, /^harness-failure:/);
  assert.match(run.cleanup.reason, /worktrees[\\/]docs-add-page-0001/);
  assert.deepEqual(workspace.cleaned, [], "a crashed run's evidence was deleted");
  assert.deepEqual(workspace.captured, ["docs-add-page-0001"], "the crash was not captured at all");
});

test("an execution whose evidence cannot be captured is unmeasured, not accepted", async () => {
  const workspace = new FakeWorkspace({ captureError: new Error("the checkout vanished") });
  const agent = new FakeAgent("ag-loop");

  const run = await runnerWith(workspace, [agent]).run(request());

  assert.equal(run.exit, "harness-failed", "a successful agent with no evidence must not read as completed");
  assert.match(run.failure, /the checkout vanished/);
  assert.equal(run.workspace.baseCommit, BASE_COMMIT, "the starting commit is known even so");
  assert.equal(run.workspace.finalCommit, "");
  assert.equal(run.cleanup.result, "kept-for-diagnosis");
  assert.deepEqual(workspace.cleaned, []);
});

test("both failures are reported when a crash is followed by a failed capture", async () => {
  const workspace = new FakeWorkspace({ captureError: new Error("the checkout vanished") });
  const agent = new FakeAgent("ag-loop", { error: new Error("the dispatch process died") });

  const run = await runnerWith(workspace, [agent]).run(request());

  assert.match(run.failure, /the dispatch process died/);
  assert.match(run.failure, /the checkout vanished/);
});

test("a checkout that could not be created leaves no agent result behind", async () => {
  const workspace = new FakeWorkspace({ createError: new Error("the fixture is missing") });
  const agent = new FakeAgent("ag-loop");

  const run = await runnerWith(workspace, [agent]).run(request());

  assert.equal(run.exit, "harness-failed");
  assert.equal(run.worktreeId, "");
  assert.equal(run.worktreePath, "");
  assert.equal(run.telemetry, undefined);
  assert.equal(run.agentClaimedDone, false);
  assert.match(run.cleanup.reason, /^worktree-not-created:/);
  assert.equal(run.cleanup.result, "failed");
  assert.deepEqual(agent.requests, [], "the agent ran without an isolated checkout");
});

test("a mode with no adapter is refused before anything is created", async () => {
  const workspace = new FakeWorkspace();
  const run = await runnerWith(workspace, [new FakeAgent("ag-loop")]).run(
    request({ mode: "deterministic-control" }),
  );

  assert.equal(run.exit, "harness-failed");
  assert.match(run.failure, /no adapter is configured for the "deterministic-control" mode/);
  assert.deepEqual(workspace.created, []);
});

test("cleanup cannot fail the run it is cleaning up after", async () => {
  const workspace = new FakeWorkspace({ cleanupError: new Error("the checkout is locked") });
  const run = await runnerWith(workspace, [new FakeAgent("ag-loop")]).run(request());

  assert.equal(run.exit, "completed", "a cleanup fault must not rewrite the execution's outcome");
  assert.equal(run.cleanup.result, "failed");
  assert.match(run.cleanup.reason, /^cleanup-error:/);
  assert.match(run.cleanup.reason, /the checkout is locked/);
});

test("a refused cleanup is reported with the reason the isolation layer gave", async () => {
  const workspace = new FakeWorkspace({
    cleanup: { result: "kept-for-diagnosis", reason: "dirty-worktree: 2 uncommitted entries remain" },
  });
  const run = await runnerWith(workspace, [new FakeAgent("ag-loop")]).run(request());

  assert.deepEqual(run.cleanup, {
    result: "kept-for-diagnosis",
    reason: "dirty-worktree: 2 uncommitted entries remain",
  });
});

test("two adapters claiming one mode is a configuration error, not a silent choice", () => {
  assert.throws(
    () =>
      new IsolatedSampleRunner({
        worktrees: new FakeWorkspace(),
        agents: [new FakeAgent("ag-loop"), new FakeAgent("ag-loop")],
      }),
    /Two adapters are configured for the "ag-loop" mode/,
  );
});

test("a credential in a failure description is redacted before it is recorded", async () => {
  for (const secret of Object.values(SYNTHETIC_SECRETS)) {
    const reported = new FakeAgent("ag-loop", {
      outcome: {
        telemetry: TELEMETRY,
        durationMs: 10,
        agentClaimedDone: false,
        failure: `the request was rejected: ${secret}`,
      },
    });
    const thrown = new FakeAgent("agent-solo", {
      error: new Error(`the adapter crashed: ${secret}`),
    });
    const runner = runnerWith(new FakeWorkspace(), [reported, thrown]);

    const fromReport = await runner.run(request());
    const fromCrash = await runner.run(request({ mode: "agent-solo" }));

    for (const failure of [fromReport.failure, fromCrash.failure]) {
      assert.ok(!failure.includes(secret), `"${secret}" survived into a recorded failure`);
      assert.match(failure, new RegExp(REDACTION_PLACEHOLDER.replace(/[[\]]/g, "\\$&")));
    }
  }
});
