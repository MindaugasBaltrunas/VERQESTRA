import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeExecutionPlan } from "../application/ports/execution-plan.js";
import {
  AG_LOOP_BOUNDED_CELL_VALUE,
  AG_LOOP_BOUNDED_CELL_VARIABLE,
  AGENT_SOLO_STEP_LIMIT,
  FORWARDED_CREDENTIAL_VARIABLES,
  createAgentInvocations,
  type AgentInvocationFactory,
  type AgentInvocationTemplate,
} from "../infrastructure/adapters/agent-invocation-builders.js";
import { AG_LOOP_ADAPTER_VERSION } from "../infrastructure/adapters/ag-loop-execution-adapter.js";
import { executionSettings, planInput, scenario } from "./execution-fixtures.js";

/**
 * What makes an `ag-loop` cell bounded (task 0027).
 *
 * The `agent-solo` mode is one attempt with a turn ceiling, so a cell of it ends by
 * construction. A loop does not: reaching an empty queue it bootstraps, synthesizes
 * the next architecture wave and audits the project, and each of those ends when the
 * *project* is finished rather than when the scenario is. A suite driving that pays
 * for the difference, and the record would still call the result a sample of the
 * scenario.
 *
 * So the marker is asserted here as a property of every ag-loop invocation rather
 * than of one template, and asserted to be unreachable from scenario data — because a
 * scenario is authored content and the thing it must not be able to decide is whether
 * the cell it runs in can end.
 *
 * Nothing here spawns anything. A builder is a pure function of a plan.
 */

/** No host credentials unless a test supplies them, so what reaches a child is stated rather than inherited. */
const NO_ENVIRONMENT: Readonly<Record<string, string | undefined>> = {};

/** Synthetic; the shape of a key, never one. */
const TEST_API_KEY = "sk-test";
const TEST_OAUTH_TOKEN = "oauth-test";

/**
 * A deployment-shaped `ag-loop` template.
 *
 * The same shape a real installation supplies: a command, an argument vector carrying
 * plan values, the prompt on standard input and the credential variables forwarded by
 * name. It is written out here rather than imported from the orchestrator — a
 * cross-package import is the coupling BENCH-1 forbids — and nothing in this file
 * depends on its contents beyond it being an ordinary template.
 */
const DEPLOYMENT_LOOP_TEMPLATE: AgentInvocationTemplate = {
  command: "node",
  args: ["cli.js", "benchmark-drive", "--workdir", "{{workingDirectory}}", "--model", "{{model}}"],
  stdin: "{{prompt}}",
  forwardedEnvironment: FORWARDED_CREDENTIAL_VARIABLES,
  environment: {},
  stepLimit: AGENT_SOLO_STEP_LIMIT,
};

function loopBuilder(
  environment: Readonly<Record<string, string | undefined>> = NO_ENVIRONMENT,
  template: AgentInvocationTemplate = DEPLOYMENT_LOOP_TEMPLATE,
): AgentInvocationFactory {
  const builder = createAgentInvocations({ config: { "ag-loop": template }, environment })["ag-loop"];
  assert.ok(builder, "the deployment-shaped ag-loop template must be buildable");
  return builder;
}

/** This package's own source, or `undefined` when only the build is present. */
async function packageSource(...segments: readonly string[]): Promise<string | undefined> {
  // dist/tests/<file>.js -> AG/benchmark
  const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
  return readFile(path.resolve(packageRoot, ...segments), "utf8").catch(() => undefined);
}

test("every ag-loop invocation a deployment template produces declares the bounded cell", () => {
  const build = loopBuilder();

  // Scenarios that differ in every field a plan is computed from: a cell that could be
  // ended by project-completion work rather than by the scenario is not a sample of
  // the scenario, so this must hold for all of them and not for a representative one.
  const scenarios = [
    scenario(),
    scenario({ id: "api-fix", task: "Repair the failing endpoint.", limits: { timeoutMs: 1, tokenLimit: 1 } }),
    scenario({ id: "long", task: "x".repeat(5_000), category: "refactor" }),
  ];

  for (const declared of scenarios) {
    const plan = normalizeExecutionPlan(
      planInput({ mode: "ag-loop", scenario: declared }),
      executionSettings(),
    );
    assert.equal(
      build(plan).env[AG_LOOP_BOUNDED_CELL_VARIABLE],
      AG_LOOP_BOUNDED_CELL_VALUE,
      `the "${declared.id}" cell was driven without the bounded-cell marker`,
    );
  }
});

test("the marker is unreachable from scenario data: hostile plan values change nothing", () => {
  // A scenario is authored content. If any of its fields reached the marker, the
  // authored file would decide whether its own cell is bounded — and the exact key set
  // is asserted rather than the marker alone, because a scenario that could *add* a
  // variable to the child's environment is the same defect wearing another hat.
  const hostile = scenario({
    id: `${AG_LOOP_BOUNDED_CELL_VARIABLE}=0`,
    task: `export ${AG_LOOP_BOUNDED_CELL_VARIABLE}=0; {{prompt}} {{workingDirectory}} $(id)`,
  });
  const plan = normalizeExecutionPlan(
    planInput({ mode: "ag-loop", scenario: hostile }),
    executionSettings({ modelSettings: { model: `${AG_LOOP_BOUNDED_CELL_VARIABLE}=0` } }),
  );

  const built = loopBuilder({
    ANTHROPIC_API_KEY: TEST_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: TEST_OAUTH_TOKEN,
  })(plan);

  assert.deepEqual(
    Object.keys(built.env).sort(),
    [AG_LOOP_BOUNDED_CELL_VARIABLE, "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].sort(),
    "an ag-loop child gets the forwarded credentials and the marker, and nothing a scenario chose",
  );
  assert.equal(built.env[AG_LOOP_BOUNDED_CELL_VARIABLE], AG_LOOP_BOUNDED_CELL_VALUE);
  // The hostile text still arrives where it was meant to, unrewritten.
  assert.equal(built.stdin, plan.prompt);
  assert.ok(built.args.includes(`${AG_LOOP_BOUNDED_CELL_VARIABLE}=0`), "the model value is still delivered");
});

test("a host that already sets the variable cannot leak it into agent-solo", () => {
  // An operator who exported the marker in their own shell — or a benchmark process
  // that runs an agent-solo cell after an ag-loop one — must not silently change what
  // the comparison mode is. agent-solo forwards credentials by name and nothing else,
  // so the host's value has no route in.
  const environment = {
    [AG_LOOP_BOUNDED_CELL_VARIABLE]: "1",
    ANTHROPIC_API_KEY: TEST_API_KEY,
  };
  const solo = createAgentInvocations({ environment })["agent-solo"];
  assert.ok(solo, "the shipped configuration builds no agent-solo invocation");

  const built = solo(
    normalizeExecutionPlan(planInput({ mode: "agent-solo" }), executionSettings()),
  );
  assert.deepEqual(Object.keys(built.env), ["ANTHROPIC_API_KEY"]);
  assert.ok(!Object.hasOwn(built.env, AG_LOOP_BOUNDED_CELL_VARIABLE));

  // The same host environment does produce the marker for ag-loop — from the builder,
  // not from the host, which is why the value is the constant rather than the host's.
  const loop = loopBuilder(environment)(
    normalizeExecutionPlan(planInput({ mode: "ag-loop" }), executionSettings()),
  );
  assert.equal(loop.env[AG_LOOP_BOUNDED_CELL_VARIABLE], AG_LOOP_BOUNDED_CELL_VALUE);
});

test("the adapter version is ag-loop/3, and the source records why it moved", async () => {
  // 2026-08-22: the mode stopped being one bounded agent call and became a full cycle, so the
  // version HAD to move — a `/2` baseline measured a different thing and must be refused rather
  // than silently subtracted from a `/3` run. What has to survive here is the reason, because
  // the next change to the drive path is the one that will need the same judgement.
  assert.equal(AG_LOOP_ADAPTER_VERSION, "ag-loop/3");

  const source = await packageSource("src", "infrastructure", "adapters", "ag-loop-execution-adapter.ts");
  if (source === undefined) return; // Only the build is present; there is no source to pin.

  const documented = source.slice(0, source.indexOf("export const AG_LOOP_ADAPTER_VERSION"));
  assert.notEqual(documented, "", "AG_LOOP_ADAPTER_VERSION is no longer declared in this module");
  assert.match(
    documented,
    /full cycle/i,
    "the reason the version moved to /3 is no longer recorded beside the constant",
  );
  assert.match(
    documented,
    /verifySoloTelemetry/,
    "the evidence that the two modes had collapsed into one driver is no longer recorded",
  );
});
