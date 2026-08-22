import assert from "node:assert/strict";
import test from "node:test";

import type { AcceptanceVerifierPort } from "../application/ports/acceptance-verifier-port.js";
import type { AgentExecutionPort } from "../application/ports/agent-execution-port.js";
import type { NormalizedExecutionPlan } from "../application/ports/execution-plan.js";
import { CONTROL_MODEL_ID } from "../application/ports/execution-plan.js";
import {
  executeBenchmarkRun,
  type IsolatedSampleRunnerPort,
} from "../application/run/execute-benchmark-run.js";
import {
  UNOBSERVED_WORKSPACE,
  type IsolatedSampleRun,
} from "../application/run/isolated-run-record.js";
import type { IsolatedSampleRequest } from "../application/run/isolated-sample-runner.js";
import { REDACTION_PLACEHOLDER } from "../application/secret-redaction.js";
import { EXECUTION_MODES } from "../domain/result.js";
import {
  AG_LOOP_ADAPTER_VERSION,
  createAgLoopExecutionAdapter,
} from "../infrastructure/adapters/ag-loop-execution-adapter.js";
import {
  AGENT_SOLO_ADAPTER_VERSION,
  createAgentSoloExecutionAdapter,
} from "../infrastructure/adapters/agent-solo-execution-adapter.js";
import {
  DeterministicControlAdapter,
  DETERMINISTIC_CONTROL_ADAPTER_VERSION,
  type DeterministicControlScript,
} from "../infrastructure/adapters/deterministic-control-adapter.js";
import {
  EXECUTION_FAILURE_CODES,
  TELEMETRY_ENVELOPE_KEY,
  isUnmeasuredFailure,
} from "../infrastructure/adapters/execution-adapter-support.js";
import { COMPRESSION_COHORT } from "../domain/compression/cohort.js";
import type { CompressionVariant } from "../domain/compression/variant.js";
import {
  executionRequest,
  executionSettings,
  FakeProcessPort,
  FakeWorkspaceFiles,
  fixedMonotonic,
  processResult,
  RecordingRunIdentityStore,
  RecordingSampleStore,
  RUN_MODEL,
  scenario,
  START_COMMIT,
  telemetryEnvelope,
  WORKTREE_PATH,
} from "./execution-fixtures.js";
import { runIdentityRecord } from "./run-identity-fixtures.js";
import { SYNTHETIC_SECRETS } from "./secret-samples.js";

/**
 * What the three execution-mode adapters owe the port (BENCH-3, BENCH-5).
 *
 * Three properties carry most of the weight here. Network execution is never
 * implicit — a mode that would reach a paid model refuses before assembling an
 * environment, let alone spawning anything. Cost is reported only when it was
 * observed, so a refused or unreadable run says its cost is unknown rather than
 * zero. And a failure carries a code that says whether an agent failed or whether
 * no measurement happened, because those two must never average together.
 */

const AGENT_ENVIRONMENT = { AGENT_PROFILE: "benchmark" } as const;

function invocation(plan: NormalizedExecutionPlan): {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
} {
  return {
    command: "agent",
    args: ["--model", plan.model, "--cwd", plan.workingDirectory],
    stdin: plan.prompt,
    env: AGENT_ENVIRONMENT,
  };
}

function loopAdapter(processes: FakeProcessPort): AgentExecutionPort {
  return createAgLoopExecutionAdapter({
    settings: executionSettings(),
    processes,
    invocation,
    monotonicMs: fixedMonotonic(4_200),
  });
}

function soloAdapter(processes: FakeProcessPort): AgentExecutionPort {
  return createAgentSoloExecutionAdapter({
    settings: executionSettings(),
    processes,
    invocation,
    monotonicMs: fixedMonotonic(4_200),
  });
}

function controlAdapter(
  files: FakeWorkspaceFiles,
  scripts: readonly DeterministicControlScript[] = [],
): AgentExecutionPort {
  return new DeterministicControlAdapter({
    settings: executionSettings(),
    files,
    scripts,
    monotonicMs: fixedMonotonic(12),
  });
}

/** A usage block as a version-2 envelope carries it: no `source`, which the reader supplies. */
const ENVELOPE_USAGE = {
  captured: true,
  cacheReadInputTokens: 12_000,
  cacheCreationInputTokens: 800,
  numTurns: 9,
  turnsSource: "recorded",
} as const;

function envelopeCompression(): Record<string, unknown> {
  const variant = COMPRESSION_COHORT[4] as CompressionVariant;
  return {
    variantId: variant.id,
    variantIdentity: variant.identity,
    features: [...variant.features],
    hookProfile: variant.hookProfile,
    diagnostics: { rawTaskChars: 9_000, compiledTaskChars: 2_400 },
  };
}

test("every execution mode has an adapter that identifies itself and its version", () => {
  const adapters = [
    loopAdapter(new FakeProcessPort()),
    soloAdapter(new FakeProcessPort()),
    controlAdapter(new FakeWorkspaceFiles()),
  ];
  assert.deepEqual(
    adapters.map((adapter) => adapter.mode).sort(),
    [...EXECUTION_MODES].sort(),
  );
  assert.deepEqual(
    adapters.map((adapter) => adapter.adapterVersion),
    [AG_LOOP_ADAPTER_VERSION, AGENT_SOLO_ADAPTER_VERSION, DETERMINISTIC_CONTROL_ADAPTER_VERSION],
  );
  for (const adapter of adapters) {
    assert.notEqual(adapter.adapterVersion, "", `${adapter.mode} reports no adapter version`);
  }
});

test("the two modes that read a telemetry envelope record the version of it they read", () => {
  // An adapter change alone can move every number in a report, so the version is
  // configuration: the two modes whose reading contract gained the v2 blocks
  // moved, and the control, which reads no envelope at all, did not.
  //
  // `ag-loop` moved again to /3 on 2026-08-22, when the mode stopped being one bounded agent
  // call and became a full cycle. The versions are deliberately NOT in step: the envelope
  // contract both modes read is still v2, while what the loop mode DOES with it changed.
  assert.equal(AG_LOOP_ADAPTER_VERSION, "ag-loop/3");
  assert.equal(AGENT_SOLO_ADAPTER_VERSION, "agent-solo/2");
  assert.equal(DETERMINISTIC_CONTROL_ADAPTER_VERSION, "deterministic-control/1");
});

test("an agent built against version 1 of the envelope is still measured", async () => {
  const processes = new FakeProcessPort(
    processResult({
      stdout: `${telemetryEnvelope({ [TELEMETRY_ENVELOPE_KEY]: 1, llmCalls: 5 })}\n`,
    }),
  );
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.telemetry?.llmCalls, 5);
  assert.equal(outcome.usage, undefined, "version 1 reports no usage detail, and none is invented");
  assert.equal(outcome.compression, undefined);
});

test("a version-2 envelope's usage and compression blocks reach the outcome", async () => {
  const processes = new FakeProcessPort(
    processResult({
      stdout: `${telemetryEnvelope({ usage: ENVELOPE_USAGE, compression: envelopeCompression() })}\n`,
    }),
  );
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.equal(outcome.failure, undefined);
  assert.deepEqual(outcome.usage, {
    source: "envelope",
    captured: true,
    cacheReadInputTokens: 12_000,
    cacheCreationInputTokens: 800,
    numTurns: 9,
    turnsSource: "recorded",
  });
  assert.equal(outcome.compression?.variantId, "compiled-prompt");
  assert.equal(outcome.compression?.diagnostics?.compiledTaskChars, 2_400);
});

test("an agent that reports no usage block reports no usage, not a run that used nothing", async () => {
  const processes = new FakeProcessPort();
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.usage, undefined);
  assert.equal(outcome.compression, undefined);
});

test("a malformed version-2 block is loud, and takes the cost record with it", async () => {
  const malformed: readonly Record<string, unknown>[] = [
    { usage: { captured: "yes" } },
    { usage: { captured: true, cacheReadInputTokens: -1 } },
    { usage: { captured: false, numTurns: 4, turnsSource: "recorded" } },
    { usage: { captured: true, costUsd: 12 } },
    { usage: 42 },
    { compression: { ...envelopeCompression(), variantIdentity: "sha256:nope" } },
    { compression: { ...envelopeCompression(), features: ["telepathy"] } },
    { compression: { ...envelopeCompression(), diagnostics: { rawTaskChars: -1 } } },
  ];
  for (const block of malformed) {
    const processes = new FakeProcessPort(
      processResult({ stdout: `${telemetryEnvelope(block)}\n` }),
    );
    const outcome = await loopAdapter(processes).execute(executionRequest());

    assert.match(
      outcome.failure ?? "",
      /^telemetry-invalid:/,
      `${JSON.stringify(block)} was accepted`,
    );
    assert.equal(outcome.telemetry, undefined, "a sample nobody could attribute is not a sample");
    assert.equal(outcome.usage, undefined, "and it is certainly not a run that used zero tokens");
  }
});

test("an envelope claiming version 1 may not carry a version-2 block", async () => {
  const processes = new FakeProcessPort(
    processResult({
      stdout: `${telemetryEnvelope({ [TELEMETRY_ENVELOPE_KEY]: 1, usage: ENVELOPE_USAGE })}\n`,
    }),
  );
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.match(outcome.failure ?? "", /^telemetry-invalid: the envelope declares version 1/);
});

test("an agent cannot label its own numbers as having come from somewhere else", async () => {
  const processes = new FakeProcessPort(
    processResult({
      stdout: `${telemetryEnvelope({ usage: { ...ENVELOPE_USAGE, source: "run-log" } })}\n`,
    }),
  );
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.match(outcome.failure ?? "", /^telemetry-invalid: the envelope's usage block names its own source/);
});

test("a mode that reaches a paid model spawns nothing without an explicit opt-in", async () => {
  for (const [mode, build] of [
    ["ag-loop", loopAdapter],
    ["agent-solo", soloAdapter],
  ] as const) {
    const processes = new FakeProcessPort();
    const outcome = await build(processes).execute(
      executionRequest({ mode, allowNetworkModels: false }),
    );

    assert.deepEqual(processes.spawns, [], `${mode} started a process without permission`);
    assert.ok(
      (outcome.failure ?? "").startsWith(`${EXECUTION_FAILURE_CODES.networkNotPermitted}:`),
      `${mode} reported "${outcome.failure ?? ""}" instead of the refusal code`,
    );
    assert.equal(outcome.telemetry, undefined, "a refused run must not report a cost of zero");
    assert.equal(outcome.agentClaimedDone, false);
    assert.equal(outcome.plan?.networkPermitted, false);
    assert.ok(
      isUnmeasuredFailure(outcome.failure ?? ""),
      "a refusal counted as a failed attempt would lower every success rate",
    );
  }
});

test("a completed run reports what the agent spent and what it was asked to do", async () => {
  const processes = new FakeProcessPort();
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.agentClaimedDone, true);
  assert.equal(outcome.durationMs, 4_200);
  assert.deepEqual(outcome.telemetry, {
    model: RUN_MODEL,
    inputTokens: 1_000,
    outputTokens: 200,
    llmCalls: 3,
    attempts: 1,
    repairs: 0,
    humanReviewEvents: 0,
  });
  assert.equal(outcome.plan?.model, RUN_MODEL);
  assert.equal(outcome.plan?.prompt, "Add the missing page.");
});

test("the process is confined to the checkout and bounded by the scenario's own limit", async () => {
  const processes = new FakeProcessPort();
  await soloAdapter(processes).execute(executionRequest({ mode: "agent-solo" }));

  assert.equal(processes.spawns.length, 1);
  const spawned = processes.spawns[0];
  assert.equal(spawned?.command, "agent");
  assert.deepEqual(spawned?.args, ["--model", RUN_MODEL, "--cwd", WORKTREE_PATH]);
  assert.equal(spawned?.cwd, WORKTREE_PATH);
  assert.equal(spawned?.stdin, "Add the missing page.");
  assert.deepEqual(spawned?.env, AGENT_ENVIRONMENT);
  assert.equal(
    spawned?.timeoutMs,
    60_000,
    "the effective timeout is the scenario's, which is below the run ceiling",
  );
});

test("a killed run is reported as a timeout rather than as the non-zero exit it caused", async () => {
  const processes = new FakeProcessPort(
    processResult({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "" }),
  );
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.match(outcome.failure ?? "", /^timeout: /);
  assert.match(outcome.failure ?? "", /60000 ms/);
  assert.equal(
    isUnmeasuredFailure(outcome.failure ?? ""),
    false,
    "an agent that ran out of time did run, and that is a measurement",
  );
});

test("an agent that exits non-zero is a measured failure carrying its own diagnosis", async () => {
  const processes = new FakeProcessPort(
    processResult({ exitCode: 3, stdout: "", stderr: "the task file could not be read" }),
  );
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.match(outcome.failure ?? "", /^process-failed: exited 3: the task file could not be read/);
  assert.equal(isUnmeasuredFailure(outcome.failure ?? ""), false);
});

test("a credential the agent echoed on failure never reaches the recorded reason", async () => {
  for (const secret of Object.values(SYNTHETIC_SECRETS)) {
    const processes = new FakeProcessPort(
      processResult({ exitCode: 1, stdout: "", stderr: `refused: ${secret}` }),
    );
    const outcome = await loopAdapter(processes).execute(executionRequest());

    assert.ok(!(outcome.failure ?? "").includes(secret), `"${secret}" survived into a failure`);
    assert.match(outcome.failure ?? "", new RegExp(REDACTION_PLACEHOLDER.replace(/[[\]]/g, "\\$&")));
  }
});

test("an agent that reports no cost is recorded as unmeasured, not as free", async () => {
  const processes = new FakeProcessPort(processResult({ stdout: "done!\n" }));
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.match(outcome.failure ?? "", /^telemetry-missing:/);
  assert.equal(outcome.telemetry, undefined);
  assert.ok(isUnmeasuredFailure(outcome.failure ?? ""));
});

test("an envelope that is not a usable cost record is rejected field by field", async () => {
  for (const [field, value] of [
    ["inputTokens", -1],
    ["outputTokens", 1.5],
    ["llmCalls", "many"],
    ["humanReviewEvents", null],
  ] as const) {
    const processes = new FakeProcessPort(
      processResult({ stdout: `${telemetryEnvelope({ [field]: value })}\n` }),
    );
    const outcome = await loopAdapter(processes).execute(executionRequest());

    assert.match(
      outcome.failure ?? "",
      /^telemetry-invalid:/,
      `${field} = ${String(value)} was accepted as a cost record`,
    );
    assert.equal(outcome.telemetry, undefined);
  }

  // `attempts: 0` left this list when the loop gained the right to refuse before dispatching.
  // For every mode that always executes it is still a broken record read field by field — the
  // exemption is the loop's alone, and it is the loop's own verifier that bounds it.
  const soloZero = new FakeProcessPort(
    processResult({ stdout: `${telemetryEnvelope({ attempts: 0 })}\n` }),
  );
  const soloOutcome = await soloAdapter(soloZero).execute(executionRequest({ mode: "agent-solo" }));
  assert.match(soloOutcome.failure ?? "", /^telemetry-invalid: the envelope reports fewer than one attempt/);
  assert.equal(soloOutcome.telemetry, undefined);
});

test("a malformed final envelope is not silently replaced by an earlier one", async () => {
  const processes = new FakeProcessPort(
    processResult({
      stdout: `${telemetryEnvelope()}\nretrying…\n${telemetryEnvelope({ model: "" })}\n`,
    }),
  );
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.match(outcome.failure ?? "", /^telemetry-invalid: the envelope names no model/);
  assert.equal(
    outcome.telemetry,
    undefined,
    "a stale line standing in for the run that happened is worse than no cost record",
  );
});

test("output that is not an envelope is passed over rather than parsed", async () => {
  const processes = new FakeProcessPort(
    processResult({
      stdout: `${telemetryEnvelope({ llmCalls: 9 })}\n{"unrelated":true}\n{"agBenchmarkTelemetry":99,"model":"other"}\nnot json {\ndone\n`,
    }),
  );
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.equal(outcome.failure, undefined);
  assert.equal(
    outcome.telemetry?.llmCalls,
    9,
    "trailing output the agent happens to print must not hide the envelope behind it",
  );
});

test("an agent that spent more than the scenario allowed still has its cost recorded", async () => {
  const processes = new FakeProcessPort(
    processResult({ stdout: `${telemetryEnvelope({ inputTokens: 99_000, outputTokens: 2_000 })}\n` }),
  );
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.match(
    outcome.failure ?? "",
    /^token-limit-exceeded: the agent spent 101000 billable tokens against a limit of 100000/,
  );
  assert.equal(outcome.telemetry?.inputTokens, 99_000, "the tokens were spent whether or not they were allowed");
  assert.equal(isUnmeasuredFailure(outcome.failure ?? ""), false);
});

// 2026-08-22: the gate summed `input + output` alone. With prompt caching that is not a small
// omission — two measured cells spent 27 928 and 22 038 billable tokens while the gate saw 7 381
// and 6 191 — so a bound declared at 150 000 could not fire. The limit now reads the same
// quantity the report publishes as the primary cost KPI.
test("cache creation counts against the scenario limit; a cache read does not", async () => {
  const overLimit = new FakeProcessPort(
    processResult({
      stdout: `${telemetryEnvelope({
        inputTokens: 10_000,
        outputTokens: 5_000,
        usage: { captured: true, cacheCreationInputTokens: 90_000, cacheReadInputTokens: 400_000 },
      })}
`,
    }),
  );
  const refused = await loopAdapter(overLimit).execute(executionRequest());
  assert.match(
    refused.failure ?? "",
    /^token-limit-exceeded: the agent spent 105000 billable tokens against a limit of 100000/,
    "writing 90k into the cache is charged like input and must be inside the bound",
  );

  // The same 400k cache read, without the cache write, stays outside the bound: it is charged at
  // a fraction this package holds no price list for.
  const withinLimit = new FakeProcessPort(
    processResult({
      stdout: `${telemetryEnvelope({
        inputTokens: 10_000,
        outputTokens: 5_000,
        usage: { captured: true, cacheReadInputTokens: 400_000 },
      })}
`,
    }),
  );
  const accepted = await loopAdapter(withinLimit).execute(executionRequest());
  assert.equal(accepted.failure, undefined);
});

test("a model the run did not ask for is audited as a difference, not hidden and not fatal", async () => {
  const processes = new FakeProcessPort(
    processResult({ stdout: `${telemetryEnvelope({ model: "claude-sonnet-5" })}\n` }),
  );
  const outcome = await loopAdapter(processes).execute(executionRequest());

  assert.equal(outcome.failure, undefined, "a substitution weakens a comparison; it does not void the run");
  const substitution = outcome.plan?.differences.find((entry) => entry.code === "model-substituted");
  assert.ok(substitution !== undefined, "the substitution left no trace in the audit");
  assert.equal(substitution?.aspect, "model");
  assert.match(substitution?.detail ?? "", /claude-sonnet-5/);
});

test("the solo mode refuses a cost record that contradicts its own declared shape", async () => {
  for (const contradiction of [{ attempts: 2 }, { repairs: 1 }, { humanReviewEvents: 1 }]) {
    const processes = new FakeProcessPort(
      processResult({ stdout: `${telemetryEnvelope(contradiction)}\n` }),
    );
    const outcome = await soloAdapter(processes).execute(executionRequest({ mode: "agent-solo" }));

    assert.match(
      outcome.failure ?? "",
      /^telemetry-invalid: the solo mode has no retry, repair or review layer/,
      `${JSON.stringify(contradiction)} was accepted as a single-attempt run`,
    );
  }
});

test("the loop mode accepts a cost summed over attempts but not one that does not add up", async () => {
  const summed = new FakeProcessPort(
    processResult({ stdout: `${telemetryEnvelope({ attempts: 3, repairs: 2, humanReviewEvents: 1 })}\n` }),
  );
  const summedOutcome = await loopAdapter(summed).execute(executionRequest());
  assert.equal(summedOutcome.failure, undefined);
  assert.equal(summedOutcome.telemetry?.repairs, 2);

  // The sample schema refuses `repairs >= attempts`; the adapter refuses it too,
  // so a run says so while it is happening rather than losing the sample at the
  // store after the tokens are already spent.
  for (const contradiction of [
    { attempts: 1, repairs: 4 },
    { attempts: 2, repairs: 2 },
  ]) {
    const impossible = new FakeProcessPort(
      processResult({ stdout: `${telemetryEnvelope(contradiction)}\n` }),
    );
    const impossibleOutcome = await loopAdapter(impossible).execute(executionRequest());
    assert.match(
      impossibleOutcome.failure ?? "",
      /^telemetry-invalid: the loop reported \d+ repairs against \d+ attempts/,
      `${JSON.stringify(contradiction)} was accepted as a loop cost record`,
    );
  }

  const free = new FakeProcessPort(
    processResult({ stdout: `${telemetryEnvelope({ llmCalls: 0 })}\n` }),
  );
  const freeOutcome = await loopAdapter(free).execute(executionRequest());
  assert.match(freeOutcome.failure ?? "", /^telemetry-invalid: the loop reported tokens without a single LLM call/);
});

/**
 * A loop that refused before it dispatched anything.
 *
 * 2026-08-22 pilot: all three `security-log-session-tokens` cells reported zero LLM calls, and
 * every one of them was discarded. The cycle log said why — a deterministic risk gate turned down
 * a request to log session tokens and the signing key, before a single token was spent — and the
 * scenario's own `expectedOutcome` is `rejected`. `agent-solo` spent about 16 000 billable tokens
 * per repetition on the same task and produced no accepted change either.
 *
 * So the cheapest correct outcome a loop has was the one outcome the harness could not record,
 * and it was unrecordable in exactly the scenario category built to test refusal. The invariant
 * `repairs >= attempts` was reading `0 >= 0` as a contradiction.
 */
test("a loop that refused before dispatch is a measurement, not a contradiction", async () => {
  const refused = new FakeProcessPort(
    processResult({
      stdout: `${telemetryEnvelope({
        llmCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        attempts: 0,
        repairs: 0,
        humanReviewEvents: 1,
        claimedDone: false,
      })}\n`,
    }),
  );
  const outcome = await loopAdapter(refused).execute(executionRequest());

  assert.equal(outcome.failure, undefined, "a refusal that cost nothing must still be a sample");
  assert.equal(outcome.telemetry?.llmCalls, 0);
  assert.equal(outcome.telemetry?.attempts, 0);
  assert.equal(outcome.telemetry?.humanReviewEvents, 1);

  // The rule the zero case must NOT weaken: a repair is itself an attempt, so one without any
  // attempt is still a contradiction — now caught by its own clause rather than by arithmetic.
  for (const contradiction of [
    { llmCalls: 0, inputTokens: 0, outputTokens: 0, attempts: 0, repairs: 1 },
    { llmCalls: 2, inputTokens: 10, outputTokens: 10, attempts: 0, repairs: 0 },
  ]) {
    const impossible = new FakeProcessPort(
      processResult({ stdout: `${telemetryEnvelope(contradiction)}\n` }),
    );
    const impossibleOutcome = await loopAdapter(impossible).execute(executionRequest());
    assert.match(
      impossibleOutcome.failure ?? "",
      /^telemetry-invalid: the loop reported .* against no attempt at all/,
      `${JSON.stringify(contradiction)} was accepted as a loop cost record`,
    );
  }
});

test("a request routed to the wrong adapter is a wiring fault, not that mode's result", async () => {
  const processes = new FakeProcessPort();
  const outcome = await loopAdapter(processes).execute(executionRequest({ mode: "agent-solo" }));

  assert.match(outcome.failure ?? "", /^mode-mismatch:/);
  assert.deepEqual(processes.spawns, []);
  assert.equal(outcome.plan, undefined);
  assert.ok(isUnmeasuredFailure(outcome.failure ?? ""));
});

test("a scenario that cannot produce a plan is refused before anything is spawned", async () => {
  const processes = new FakeProcessPort();
  const outcome = await loopAdapter(processes).execute(
    executionRequest({ scenario: scenario({ task: "   " }) }),
  );

  assert.match(outcome.failure ?? "", /^plan-rejected: .*task text is empty/);
  assert.deepEqual(processes.spawns, []);
  assert.ok(isUnmeasuredFailure(outcome.failure ?? ""));
});

test("the control mode runs offline, with the network switch off and no model involved", async () => {
  const files = new FakeWorkspaceFiles();
  const outcome = await controlAdapter(files, [
    { scenarioId: "docs-add-page", edits: [{ path: "docs/new-page.md", contents: "# new page\n" }], claimsDone: true },
  ]).execute(executionRequest({ mode: "deterministic-control", allowNetworkModels: false }));

  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.agentClaimedDone, true);
  assert.equal(outcome.plan?.networkPermitted, false);
  assert.equal(outcome.plan?.model, CONTROL_MODEL_ID);
  assert.deepEqual(outcome.telemetry, {
    model: CONTROL_MODEL_ID,
    inputTokens: 0,
    outputTokens: 0,
    llmCalls: 0,
    attempts: 1,
    repairs: 0,
    humanReviewEvents: 0,
  });
  assert.deepEqual(files.applied, [
    {
      worktreePath: WORKTREE_PATH,
      edits: [{ path: "docs/new-page.md", contents: "# new page\n" }],
    },
  ]);
});

test("permitting the network cannot make the control mode use one", async () => {
  const files = new FakeWorkspaceFiles();
  const outcome = await controlAdapter(files).execute(
    executionRequest({ mode: "deterministic-control", allowNetworkModels: true }),
  );

  assert.equal(outcome.plan?.networkPermitted, false);
  assert.equal(outcome.failure, undefined, "the control needs no permission it was never going to use");
});

test("a scenario the control has no script for is an empty change, not an error", async () => {
  const files = new FakeWorkspaceFiles();
  const outcome = await controlAdapter(files).execute(
    executionRequest({ mode: "deterministic-control", allowNetworkModels: false }),
  );

  assert.equal(outcome.failure, undefined);
  assert.equal(outcome.agentClaimedDone, false, "doing nothing is the floor, and it never claims success");
  assert.equal(outcome.telemetry?.llmCalls, 0);
  assert.deepEqual(files.applied, [], "an absent script must not reach the filesystem at all");
});

test("a control that could not apply its own script is unmeasured, not an honest empty change", async () => {
  const files = new FakeWorkspaceFiles(new Error("the path leaves the isolated checkout"));
  const outcome = await controlAdapter(files, [
    { scenarioId: "docs-add-page", edits: [{ path: "../escape.md", contents: "" }], claimsDone: true },
  ]).execute(executionRequest({ mode: "deterministic-control" }));

  assert.match(outcome.failure ?? "", /^control-edit-failed: .*leaves the isolated checkout/);
  assert.equal(outcome.telemetry, undefined);
  assert.equal(outcome.agentClaimedDone, false);
  assert.ok(isUnmeasuredFailure(outcome.failure ?? ""));
});

test("two control scripts for one scenario is a configuration error, not a silent choice", () => {
  assert.throws(
    () =>
      new DeterministicControlAdapter({
        settings: executionSettings(),
        files: new FakeWorkspaceFiles(),
        scripts: [
          { scenarioId: "docs-add-page", edits: [], claimsDone: false },
          { scenarioId: "docs-add-page", edits: [], claimsDone: true },
        ],
      }),
    /Two deterministic control scripts are configured for the "docs-add-page" scenario/,
  );
});

test("the control adapter refuses a request meant for another mode", async () => {
  const files = new FakeWorkspaceFiles();
  const outcome = await controlAdapter(files).execute(executionRequest({ mode: "ag-loop" }));

  assert.match(outcome.failure ?? "", /^mode-mismatch:/);
  assert.deepEqual(files.applied, []);
});

/**
 * The pipeline as this file needs it: one adapter, no Git and no clock.
 *
 * It does what `IsolatedSampleRunner` does minus the isolation, so the question
 * under test stays "what does the run pipeline make of an execution that reported
 * no cost" rather than "can a worktree be created here".
 */
class StubIsolatedRunner implements IsolatedSampleRunnerPort {
  constructor(private readonly agent: AgentExecutionPort) {}

  async run(request: IsolatedSampleRequest): Promise<IsolatedSampleRun> {
    const outcome = await this.agent.execute({
      scenario: request.scenario,
      mode: request.mode,
      worktree: { id: "stub-0001", path: WORKTREE_PATH, startCommit: START_COMMIT },
      allowNetworkModels: request.allowNetworkModels,
    });
    return {
      scenarioId: request.scenario.id,
      mode: request.mode,
      repetition: request.repetition,
      worktreeId: "stub-0001",
      worktreePath: WORKTREE_PATH,
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: outcome.durationMs,
      agentDurationMs: outcome.durationMs,
      exit: outcome.failure === undefined ? "completed" : "agent-failed",
      failure: outcome.failure ?? "",
      agentClaimedDone: outcome.agentClaimedDone,
      telemetry: outcome.telemetry,
      usage: outcome.usage,
      compression: outcome.compression,
      workspace: { ...UNOBSERVED_WORKSPACE, baseCommit: START_COMMIT },
      cleanup: { result: "removed", reason: "" },
    };
  }
}

/** A verdict on a run that produced no measurement would be a verdict about nothing. */
const unusedVerifier: AcceptanceVerifierPort = {
  verify: () => {
    throw new Error("an unmeasured cell must not be verified");
  },
};

test("an agent killed at its limit costs the cell, not the ledger", async () => {
  const processes = new FakeProcessPort(
    processResult({
      timedOut: true,
      stdout: "",
      exitCode: null,
      signal: "SIGTERM",
      stderr: "",
      outputTruncated: false,
    }),
  );
  const adapter = loopAdapter(processes);

  const outcome = await adapter.execute(executionRequest());
  assert.match(outcome.failure ?? "", /^timeout: /);
  assert.equal(outcome.telemetry, undefined, "a killed run reports no cost, and none is invented");

  // And the pipeline stores nothing for it. A sample assembled from an execution
  // that never reported what it spent would enter the ledger as a real, cheap
  // failure; the cell is carried out of the run as unmeasured instead (BENCH-5).
  const store = new RecordingSampleStore();
  const run = await executeBenchmarkRun(
    {
      scenarios: [scenario()],
      modes: ["ag-loop"],
      repetitions: 1,
      allowNetworkModels: true,
      identityRecord: runIdentityRecord(),
    },
    {
      runner: new StubIsolatedRunner(adapter),
      verifier: unusedVerifier,
      store,
      identity: new RecordingRunIdentityStore(),
    },
  );

  assert.deepEqual(run.samples, []);
  assert.deepEqual(store.appended, []);
  assert.equal(run.unmeasured.length, 1);
  assert.equal(run.unmeasured[0]?.scenarioId, "docs-add-page");
  assert.equal(run.unmeasured[0]?.mode, "ag-loop");
  assert.match(run.unmeasured[0]?.reason ?? "", /^no-cost-record: timeout: /);
});
