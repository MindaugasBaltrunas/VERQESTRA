import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXECUTION_MODES } from "../domain/result.js";
import { MINIMUM_NONDETERMINISTIC_OBSERVATIONS } from "../domain/statistics/scenario-observations.js";
import {
  DEFAULT_AGENT_INVOCATION_CONFIG,
  createAgentInvocations,
  createBenchmarkApplicationApi,
  type AgentInvocationTemplate,
} from "../interfaces/cli/benchmark-cli-composition.js";

/**
 * The composition root against the real package: `validate` and `plan` are
 * answered from the authored suite, so these tests prove the CLI is wired to the
 * artefact it claims to measure rather than to a fixture that happens to agree
 * with it.
 *
 * Package root is resolved from this module rather than from `process.cwd()`,
 * for the same reason `scenario-suite.test.ts` does it: a run started elsewhere
 * would validate some other directory, or none, and pass vacuously.
 */
const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");

const api = createBenchmarkApplicationApi();

const wholeSuite = {
  modes: EXECUTION_MODES,
  repetitions: MINIMUM_NONDETERMINISTIC_OBSERVATIONS,
  allowNetworkModels: true,
};

async function nondeterministicScenarioId(): Promise<string | undefined> {
  const directory = path.join(packageRoot, "scenarios");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".scenario.json")).sort();
  for (const name of names) {
    const value = JSON.parse(await readFile(path.join(directory, name), "utf8")) as {
      id?: unknown;
      deterministic?: unknown;
    };
    if (value.deterministic === false && typeof value.id === "string") return value.id;
  }
  return undefined;
}

test("validate answers from the authored suite and reports its hash", async () => {
  const report = await api.validate();
  assert.deepEqual(report.problems, [], "the authored suite must validate");
  assert.ok(report.scenarioCount >= 20, `expected the frozen suite, saw ${report.scenarioCount} scenarios`);
  assert.match(report.suiteHash, /^sha256:[0-9a-f]{64}$/);
});

test("validate is fail-closed: a package without a suite is a problem, not an empty pass", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "ag-benchmark-cli-"));
  const report = await createBenchmarkApplicationApi({ packageRoot: empty }).validate();
  assert.equal(report.suiteHash, "");
  assert.equal(report.scenarioCount, 0);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0] as string, /suite directory could not be read/);
});

test("a plan over the whole suite costs scenarios x modes x repetitions", async () => {
  const report = await api.validate();
  const plan = await api.plan(wholeSuite);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.scenarioIds.length, report.scenarioCount);
  assert.equal(plan.suiteHash, report.suiteHash);
  assert.equal(
    plan.sampleCount,
    report.scenarioCount * EXECUTION_MODES.length * MINIMUM_NONDETERMINISTIC_OBSERVATIONS,
  );
});

test("a network mode without explicit permission is refused before anything runs", async () => {
  const plan = await api.plan({ ...wholeSuite, allowNetworkModels: false });
  const refused = plan.problems.filter((problem) => problem.includes("--allow-network"));
  assert.equal(refused.length, 2, "both model-backed modes must be refused");
  assert.ok(refused.some((problem) => problem.includes("ag-loop")));
  assert.ok(refused.some((problem) => problem.includes("agent-solo")));
  assert.equal(plan.suiteHash, "", "a refused plan names no suite");
});

test("the deterministic control mode needs no network permission", async () => {
  const plan = await api.plan({
    modes: ["deterministic-control"],
    repetitions: MINIMUM_NONDETERMINISTIC_OBSERVATIONS,
    allowNetworkModels: false,
  });
  assert.deepEqual(plan.problems, []);
});

test("the scenario filter selects a subset and refuses an id the suite does not have", async () => {
  const report = await api.validate();
  const all = await api.plan(wholeSuite);
  const first = all.scenarioIds[0] as string;

  const selected = await api.plan({ ...wholeSuite, scenarioIds: [first] });
  assert.deepEqual(selected.scenarioIds, [first]);
  assert.equal(
    selected.sampleCount,
    EXECUTION_MODES.length * MINIMUM_NONDETERMINISTIC_OBSERVATIONS,
  );
  assert.ok(report.scenarioCount > 1, "the suite is large enough for a filter to mean something");

  const ghost = await api.plan({ ...wholeSuite, scenarioIds: [first, "no-such-scenario"] });
  assert.deepEqual(ghost.problems, ['"no-such-scenario" is not a scenario of this suite']);
});

test("too few repetitions for a nondeterministic scenario is refused (BENCH-9)", async () => {
  const id = await nondeterministicScenarioId();
  assert.ok(id !== undefined, "the suite must contain at least one nondeterministic scenario");

  const plan = await api.plan({
    ...wholeSuite,
    scenarioIds: [id],
    repetitions: MINIMUM_NONDETERMINISTIC_OBSERVATIONS - 1,
  });
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0] as string, /BENCH-9 requires .* at least 3 times/);
});

test("a plan is refused whole when the suite itself cannot be read", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "ag-benchmark-cli-"));
  const plan = await createBenchmarkApplicationApi({ packageRoot: empty }).plan(wholeSuite);
  assert.equal(plan.sampleCount, 0);
  assert.deepEqual(plan.scenarioIds, []);
  assert.equal(plan.problems.length, 1);
});

test("a mode this installation cannot drive is refused by the run, not by the plan", async () => {
  // The plan answers what a networked run would cost, which is a question worth
  // answering on a host that has no agent invocation configured for it.
  const plan = await api.plan(wholeSuite);
  assert.deepEqual(plan.problems, []);

  // The run is where it is refused, before a worktree is created and before
  // anything is spent.
  await assert.rejects(() => api.run(wholeSuite), (error: Error) => {
    assert.equal(error.name, "BenchmarkRunRefusedError");
    assert.match(error.message, /"ag-loop" has no configured agent invocation/);
    assert.match(error.message, /"agent-solo" has no configured agent invocation/);
    assert.doesNotMatch(
      error.message,
      /cannot execute/,
      "the refusal is about this host, not about an unimplemented capability",
    );
    return true;
  });
});

/**
 * The same composition root, wired with this installation's own command lines for
 * the paid modes.
 *
 * Every assertion below drives the run into a refusal it reaches *before*
 * executing anything — an unknown scenario id, or a missing `--allow-network` —
 * so what is observed is the executability gate itself rather than a run. A test
 * that let a wired paid mode reach execution would create worktrees and spawn an
 * agent, which is exactly the bill BENCH-12 says a check may never produce.
 *
 * Every factory call below states an empty environment. The default is
 * `process.env`, and on an operator's machine that would capture a real
 * credential into a live builder held by an API configured with
 * `allowNetworkModels: true` — a key in the test process for no reason the test
 * needs. Credential-free by construction rather than by the run staying refused.
 */
const NO_ENVIRONMENT: Readonly<Record<string, string | undefined>> = {};

const driven = createBenchmarkApplicationApi({
  agentInvocations: createAgentInvocations({ environment: NO_ENVIRONMENT }),
});

/**
 * A deployment whose loop entry point takes its task on the command line.
 *
 * The shipped default has no `ag-loop` entry, because this repository's own
 * `ag loop` reads its work from the project's task queue instead. So a test about
 * a drivable `ag-loop` supplies the template it is about, rather than depending on
 * a default that deliberately omits it.
 */
const AG_LOOP_TEMPLATE: AgentInvocationTemplate = {
  command: "ag",
  args: ["loop", "--task", "{{prompt}}"],
  stdin: "{{prompt}}",
  forwardedEnvironment: [],
  environment: {},
  stepLimit: 60,
};

const drivenIncludingLoop = createBenchmarkApplicationApi({
  agentInvocations: createAgentInvocations({
    config: { ...DEFAULT_AGENT_INVOCATION_CONFIG, "ag-loop": AG_LOOP_TEMPLATE },
    environment: NO_ENVIRONMENT,
  }),
});

const GHOST_SCENARIO = "no-such-scenario";
const NOT_DRIVABLE = /has no configured agent invocation/;

/** The message of the refusal `run` produced; fails if it produced none. */
async function refusalMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "BenchmarkRunRefusedError");
    return error.message;
  }
  return assert.fail("the run was not refused, so it executed something");
}

test("configured agent invocations are what make a paid mode drivable", async () => {
  const request = (mode: "ag-loop" | "agent-solo") => ({
    modes: [mode] as const,
    repetitions: MINIMUM_NONDETERMINISTIC_OBSERVATIONS,
    allowNetworkModels: true,
    // Refuses the run whole while the executability problems are still collected,
    // so the gate is read out of the refusal instead of out of an execution.
    scenarioIds: [GHOST_SCENARIO],
  });

  const bare = await refusalMessage(() => api.run(request("agent-solo")));
  assert.match(bare, NOT_DRIVABLE, "an installation with no invocation cannot drive agent-solo");

  const wired = await refusalMessage(() => driven.run(request("agent-solo")));
  assert.doesNotMatch(wired, NOT_DRIVABLE, "the configured invocation makes the mode drivable");
  assert.match(wired, /"no-such-scenario" is not a scenario of this suite/);

  // The shipped configuration drives `agent-solo` and nothing else: this
  // repository's `ag loop` takes no task on its command line, so a default
  // template for it would pay for cells that could not measure anything.
  const loop = await refusalMessage(() => driven.run(request("ag-loop")));
  assert.match(loop, NOT_DRIVABLE, "the shipped default must not claim to drive ag-loop");

  // The mechanism itself stays general: a deployment that supplies a template gets
  // the mode, exactly as `agent-solo` does above.
  const supplied = await refusalMessage(() => drivenIncludingLoop.run(request("ag-loop")));
  assert.doesNotMatch(supplied, NOT_DRIVABLE, "a supplied template makes ag-loop drivable");
  assert.match(supplied, /"no-such-scenario" is not a scenario of this suite/);
});

test("being drivable is not being permitted: --allow-network is still the spend gate", async () => {
  // The configuration that actually ships: `agent-solo` is drivable here, so the
  // only thing left to refuse the run is the missing permission. Without a builder
  // the run would be refused as undrivable and this check would pass for a reason
  // that has nothing to do with the spend gate.
  const shipped = await refusalMessage(() =>
    driven.run({
      modes: ["agent-solo"],
      repetitions: MINIMUM_NONDETERMINISTIC_OBSERVATIONS,
      allowNetworkModels: false,
    }),
  );
  assert.match(
    shipped,
    /mode "agent-solo" reaches a paid model over the network; re-run with --allow-network/,
  );
  assert.doesNotMatch(
    shipped,
    NOT_DRIVABLE,
    "the refusal must be the permission, not a mode this installation happens not to drive",
  );

  const message = await refusalMessage(() =>
    drivenIncludingLoop.run({
      modes: ["ag-loop", "agent-solo"],
      repetitions: MINIMUM_NONDETERMINISTIC_OBSERVATIONS,
      allowNetworkModels: false,
    }),
  );
  for (const mode of ["ag-loop", "agent-solo"]) {
    assert.match(
      message,
      new RegExp(`mode "${mode}" reaches a paid model over the network; re-run with --allow-network`),
    );
  }
  assert.doesNotMatch(message, NOT_DRIVABLE, "both modes are drivable; only the permission is missing");
});

test("the offline control mode behaves identically with and without agent invocations", async () => {
  const request = {
    modes: ["deterministic-control"] as const,
    repetitions: MINIMUM_NONDETERMINISTIC_OBSERVATIONS,
    allowNetworkModels: false,
  };

  assert.deepEqual(await driven.plan(request), await api.plan(request));
  assert.deepEqual(
    await refusalMessage(() => driven.run({ ...request, scenarioIds: [GHOST_SCENARIO] })),
    await refusalMessage(() => api.run({ ...request, scenarioIds: [GHOST_SCENARIO] })),
    "the control needs no invocation, so configuring one for the other modes cannot change it",
  );
});

test("no capability answers with a `cannot execute … yet` stub any more", async () => {
  const source = await readFile(
    path.join(packageRoot, "src", "interfaces", "cli", "benchmark-cli-composition.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /cannot execute|BenchmarkCapabilityUnavailable|queue tasks 0013-0017/,
    "the composition root no longer refuses a capability as unimplemented",
  );

  // `verify` re-derives acceptance from whatever it is handed, including an
  // empty ledger: a run that stored nothing is a real, empty answer rather than
  // a refusal about a capability this build lacks.
  const summary = await api.verify([]);
  assert.deepEqual(summary.samples, []);
  assert.match(summary.identity.suiteHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(summary.identity.configHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(summary.identity.policyHash, /^sha256:[0-9a-f]{64}$/);
});
