import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeExecutionPlan,
  type NormalizedExecutionPlan,
} from "../application/ports/execution-plan.js";
import type { ExecutionMode } from "../domain/result.js";
import {
  AG_LOOP_BOUNDED_CELL_VALUE,
  AG_LOOP_BOUNDED_CELL_VARIABLE,
  AGENT_SOLO_STEP_LIMIT,
  AgentInvocationConfigError,
  DEFAULT_AGENT_INVOCATION_CONFIG,
  FORWARDED_CREDENTIAL_VARIABLES,
  createAgentInvocations,
  type AgentInvocationConfig,
  type AgentInvocationFactory,
  type AgentInvocationTemplate,
} from "../infrastructure/adapters/agent-invocation-builders.js";
import {
  executionSettings,
  planInput,
  RUN_MODEL,
  scenario,
  START_COMMIT,
  WORKTREE_PATH,
} from "./execution-fixtures.js";

/**
 * The deployment's command lines for the paid modes.
 *
 * Two questions decide whether these builders are safe to point at a live model.
 * Is the command line the one the deployment declared, whatever a scenario's task
 * text happens to contain? And does a credential reach the child only when the
 * operator's own environment holds one? Everything below is one of those two, plus
 * the fail-closed rule that a broken configuration is refused while the CLI is
 * wired rather than after a paid cell has already run.
 *
 * Nothing here spawns anything: a builder is a pure function of a plan, which is
 * what makes the command line testable without a model.
 */

/** No host credentials, so a test states what reaches the child rather than what this machine holds. */
const NO_ENVIRONMENT: Readonly<Record<string, string | undefined>> = {};

/** Synthetic; the shape of a key, never one. */
const TEST_API_KEY = "sk-test";

/**
 * A caller-supplied `ag-loop` template.
 *
 * The shipped default drives `agent-solo` only, because this repository's own
 * `ag loop` takes no task on its command line. The mechanism is unchanged though —
 * a deployment whose loop entry point does take one configures it — and that is
 * what this template stands for here.
 */
const AG_LOOP_STEP_LIMIT = 60;

const AG_LOOP_TEMPLATE: AgentInvocationTemplate = {
  command: "ag",
  args: ["loop", "--task", "{{prompt}}"],
  stdin: "{{prompt}}",
  forwardedEnvironment: FORWARDED_CREDENTIAL_VARIABLES,
  environment: {
    CLAUDE_PROJECT_DIR: "{{workingDirectory}}",
    AG_BENCHMARK_SCENARIO: "{{scenarioId}}",
    AG_BENCHMARK_TIMEOUT_MS: "{{timeoutMs}}",
    AG_BENCHMARK_TOKEN_LIMIT: "{{tokenLimit}}",
    AG_BENCHMARK_STEP_LIMIT: "{{stepLimit}}",
  },
  stepLimit: AG_LOOP_STEP_LIMIT,
};

function planFor(mode: ExecutionMode, task?: string): NormalizedExecutionPlan {
  return normalizeExecutionPlan(
    planInput({ mode, ...(task === undefined ? {} : { scenario: scenario({ task }) }) }),
    executionSettings(),
  );
}

function builderFor(
  mode: ExecutionMode,
  environment: Readonly<Record<string, string | undefined>> = NO_ENVIRONMENT,
): AgentInvocationFactory {
  const builder = createAgentInvocations({ environment })[mode];
  assert.ok(builder, `the default configuration builds no invocation for "${mode}"`);
  return builder;
}

/** The same factory, driven from a configuration the caller supplied rather than the shipped one. */
function loopBuilder(
  environment: Readonly<Record<string, string | undefined>> = NO_ENVIRONMENT,
): AgentInvocationFactory {
  const builder = createAgentInvocations({ config: { "ag-loop": AG_LOOP_TEMPLATE }, environment })[
    "ag-loop"
  ];
  assert.ok(builder, "a caller-supplied ag-loop template must still be built");
  return builder;
}

/** A usable template, so each refusal test states only the field it is about. */
function template(overrides: Partial<AgentInvocationTemplate> = {}): AgentInvocationTemplate {
  return {
    command: "claude",
    args: ["--print", "--model", "{{model}}"],
    stdin: "{{prompt}}",
    forwardedEnvironment: [],
    environment: {},
    stepLimit: 10,
    ...overrides,
  };
}

function refuses(config: AgentInvocationConfig, expected: RegExp): void {
  assert.throws(
    () => createAgentInvocations({ config, environment: NO_ENVIRONMENT }),
    (error: unknown) => {
      assert.ok(error instanceof AgentInvocationConfigError, `threw ${String(error)}`);
      assert.match(error.message, expected);
      return true;
    },
  );
}

test("the shipped default drives the one mode this repository can measure", () => {
  const invocations = createAgentInvocations({ environment: NO_ENVIRONMENT });

  assert.deepEqual(Object.keys(invocations).sort(), ["agent-solo"]);
  assert.ok(
    !Object.hasOwn(DEFAULT_AGENT_INVOCATION_CONFIG, "ag-loop"),
    "this repository's `ag loop` takes its work from the task queue rather than from a command line, so an argv template for it would pay for cells that measure nothing",
  );
  assert.equal(
    invocations["deterministic-control"],
    undefined,
    "a control driven as a process would be another agent, not the floor the others are measured against",
  );
  assert.ok(!Object.hasOwn(DEFAULT_AGENT_INVOCATION_CONFIG, "deterministic-control"));
});

test("a caller-supplied template makes any mode drivable, including ag-loop", () => {
  const plan = planFor("ag-loop");
  const invocation = loopBuilder()(plan);

  assert.equal(invocation.command, "ag");
  assert.deepEqual([...invocation.args], ["loop", "--task", "Add the missing page."]);
  // Pointing the loop at the scenario's checkout is what keeps its own state out
  // of the repository that started it.
  assert.equal(invocation.env["CLAUDE_PROJECT_DIR"], plan.workingDirectory);
  assert.equal(plan.workingDirectory, WORKTREE_PATH);
});

test("one plan produces one command line, and the same one every time", () => {
  const build = builderFor("agent-solo");
  const plan = planFor("agent-solo");
  const invocation = build(plan);

  assert.deepEqual(
    { command: invocation.command, args: [...invocation.args], stdin: invocation.stdin },
    {
      command: "claude",
      args: [
        "--print",
        "--model",
        RUN_MODEL,
        "--max-turns",
        String(AGENT_SOLO_STEP_LIMIT),
        "--permission-mode",
        "acceptEdits",
      ],
      stdin: "Add the missing page.",
    },
  );
  // A builder that answered differently on a second call would make two samples of
  // one scenario incomparable for a reason nothing in the record would show.
  assert.deepEqual(build(plan), invocation);
});

test("a prompt full of shell syntax stays one value and adds no argument", () => {
  const hostile = "$(rm -rf /) ; & `whoami`\nsecond line";
  const declared = [...builderFor("agent-solo")(planFor("agent-solo")).args];

  const solo = builderFor("agent-solo")(planFor("agent-solo", hostile));
  assert.equal(solo.stdin, hostile, "agent-solo did not deliver the prompt verbatim");
  for (const argument of solo.args) {
    assert.ok(!argument.includes("whoami"), "agent-solo let the prompt into its argument vector");
  }

  // Element for element the template's own vector: substitution happens inside an
  // element and never splits one, so a task text cannot become a second argument.
  assert.deepEqual([...solo.args], declared);

  // A template that does place the prompt in an argument keeps it in exactly one.
  const loop = loopBuilder()(planFor("ag-loop", hostile));
  assert.deepEqual([...loop.args], ["loop", "--task", hostile]);
});

test("a task text that mentions a placeholder is delivered, not rewritten", () => {
  // The prompt is substituted in, and what is substituted in is never rescanned.
  // Were it, the delivered prompt would carry this host's paths and this run's
  // limits — a different prompt per run, which is the equality BENCH-3 requires.
  const authored = "Document {{workingDirectory}} and the {{timeoutMs}} budget.";

  const solo = builderFor("agent-solo")(planFor("agent-solo", authored));
  assert.equal(solo.stdin, authored);

  const loop = loopBuilder()(planFor("ag-loop", authored));
  assert.equal(loop.stdin, authored);
  assert.deepEqual([...loop.args], ["loop", "--task", authored]);
  // The template's own placeholders are still substituted; only the value that
  // arrived through one of them is left alone.
  assert.equal(loop.env["CLAUDE_PROJECT_DIR"], WORKTREE_PATH);
});

test("a task text full of replacement patterns is delivered byte for byte", () => {
  // `$&`, "$`", `$'`, `$$` and `$n` are expansions of a *string* replacement; the
  // substitution uses a function, so they are ordinary characters of the prompt.
  const authored = "$& $` $' $$ $1";

  assert.equal(builderFor("agent-solo")(planFor("agent-solo", authored)).stdin, authored);
  assert.equal(loopBuilder()(planFor("ag-loop", authored)).stdin, authored);
});

test("the plan's budget is stated to the child that is being held to it", () => {
  const plan = planFor("ag-loop");
  const loop = loopBuilder()(plan);

  assert.equal(loop.env["AG_BENCHMARK_SCENARIO"], plan.scenarioId);
  assert.equal(loop.env["AG_BENCHMARK_TIMEOUT_MS"], String(plan.limits.timeoutMs));
  assert.equal(loop.env["AG_BENCHMARK_TOKEN_LIMIT"], String(plan.limits.tokenLimit));
  assert.equal(loop.env["AG_BENCHMARK_STEP_LIMIT"], String(AG_LOOP_STEP_LIMIT));
  assert.equal(plan.limits.timeoutMs, 60_000, "the effective limit is the scenario's, below the ceiling");

  const solo = builderFor("agent-solo")(planFor("agent-solo"));
  const turns = solo.args.indexOf("--max-turns");
  assert.notEqual(turns, -1);
  assert.equal(solo.args[turns + 1], String(AGENT_SOLO_STEP_LIMIT));

  // The kill stays with the adapter and the runner: these values inform the child
  // of its budget, they do not enforce it.
  assert.ok(!Object.hasOwn(loop, "cwd"));
  assert.ok(!Object.hasOwn(loop, "timeoutMs"));
});

test("a credential is forwarded when the host holds one, and is absent when it does not", () => {
  const supplied = builderFor("agent-solo", { ANTHROPIC_API_KEY: TEST_API_KEY })(planFor("agent-solo"));
  assert.equal(supplied.env["ANTHROPIC_API_KEY"], TEST_API_KEY);
  assert.ok(
    !Object.hasOwn(supplied.env, "CLAUDE_CODE_OAUTH_TOKEN"),
    "an unset variable must not arrive as an empty string; a CLI reads that as a blank credential",
  );

  const bare = builderFor("agent-solo")(planFor("agent-solo"));
  assert.deepEqual(Object.keys(bare.env), [], "no host credential, no credential in the child");

  // A literal environment entry carries a placeholder or a name, never a value the
  // captured environment did not hold. The bounded-cell marker (task 0027) is the one
  // key the builder itself adds, for this mode only; it is still the exact key set
  // that is pinned, because a mode that could add a key from anywhere else is the
  // defect this assertion exists to catch.
  const loop = loopBuilder({ ANTHROPIC_API_KEY: TEST_API_KEY })(planFor("ag-loop"));
  assert.deepEqual(Object.keys(loop.env).sort(), [
    AG_LOOP_BOUNDED_CELL_VARIABLE,
    "AG_BENCHMARK_SCENARIO",
    "AG_BENCHMARK_STEP_LIMIT",
    "AG_BENCHMARK_TIMEOUT_MS",
    "AG_BENCHMARK_TOKEN_LIMIT",
    "ANTHROPIC_API_KEY",
    "CLAUDE_PROJECT_DIR",
  ]);
});

test("a credential set to nothing is treated as a credential the host does not have", () => {
  // "Set but blank" is worse than absent: a CLI reads it as a key the operator
  // supplied and fails authentication instead of falling back to the session the
  // operator actually has — on every paid cell of the run.
  const blank = builderFor("agent-solo", { ANTHROPIC_API_KEY: "" })(planFor("agent-solo"));
  assert.ok(!Object.hasOwn(blank.env, "ANTHROPIC_API_KEY"));
  assert.deepEqual(Object.keys(blank.env), []);
});

test("a configuration no run can be driven from is refused while the CLI is wired", () => {
  refuses(
    { "agent-solo": template({ args: ["--task", "{{scenario}}"] }) },
    /unknown placeholder "\{\{scenario\}\}"/,
  );
  refuses({ "agent-solo": template({ stdin: "{{}}" }) }, /unknown placeholder/);
  refuses(
    { "agent-solo": template({ environment: { AG_TASK: "{{taskText}}" } }) },
    /unknown placeholder "\{\{taskText\}\}"/,
  );
  refuses({ "deterministic-control": template() }, /never driven as a process/);
  refuses({ "agent-solo": template({ command: "   " }) }, /names no command to run/);
  refuses({ "agent-solo": template({ stepLimit: 0 }) }, /step limit of 0/);
  refuses({ "agent-solo": template({ stepLimit: -1 }) }, /step limit of -1/);
  refuses({ "agent-solo": template({ stepLimit: Number.NaN }) }, /step limit of NaN/);
  refuses({ "agent-solo": template({ stepLimit: 1.5 }) }, /step limit of 1.5/);
  refuses({ "agent-solo": template({ environment: { "A=B": "x" } }) }, /"A=B", which contains/);
  refuses({ "agent-solo": template({ environment: { "": "x" } }) }, /empty name/);
  refuses(
    { "agent-solo": template({ forwardedEnvironment: ["WITH=EQUALS"] }) },
    /"WITH=EQUALS", which contains/,
  );
  refuses({ "agent-solo": template({ args: ["--task", "a\0b"] }) }, /NUL byte in argument 1/);
  refuses({ "agent-solo": template({ stdin: "a\0b" }) }, /NUL byte in its standard input/);

  // Every named mode is validated, not only the first: a run refused half-way
  // through has already paid for the modes before it.
  refuses(
    { "ag-loop": template(), "agent-solo": template({ command: "" }) },
    /"agent-solo" mode names no command/,
  );
});

test("the command is a binary the deployment named, so a placeholder in it is refused", () => {
  // The command is used literally rather than substituted. Left unchecked, this
  // template would pass wiring and then try to spawn a program named "{{model}}",
  // which reaches an operator as an ENOENT with nothing to trace it to.
  refuses(
    { "agent-solo": template({ command: "{{model}}" }) },
    /placeholder "\{\{model\}\}" in its command, which is used literally/,
  );
});

test("a builder refuses a plan for a mode it was not configured for", () => {
  const build = builderFor("agent-solo");
  assert.throws(
    () => build(planFor("ag-loop")),
    (error: unknown) => {
      assert.ok(error instanceof AgentInvocationConfigError);
      assert.match(
        error.message,
        /"agent-solo" agent invocation was handed a plan for the "ag-loop" mode/,
      );
      return true;
    },
  );
  assert.equal(build(planFor("agent-solo")).stdin, "Add the missing page.");
});

test("a built invocation cannot be edited after the fact", () => {
  const plan = planFor("ag-loop");
  const invocation = loopBuilder({ ANTHROPIC_API_KEY: TEST_API_KEY })(plan);

  assert.ok(Object.isFrozen(invocation));
  assert.ok(Object.isFrozen(invocation.args));
  assert.ok(Object.isFrozen(invocation.env));
  assert.equal(plan.startCommit, START_COMMIT);
});

/**
 * The bounded-cell marker (task 0027).
 *
 * A driven `ag loop` that reaches an empty queue would start bootstrapping,
 * synthesizing waves and auditing the project it was pointed at — work that ends a
 * cell only when the whole project is finished, on a budget the harness is paying.
 * The marker is what tells the loop it is one bounded cell, so the property under
 * test is not "the marker can be set" but "a built ag-loop invocation carries it
 * whatever the deployment or the scenario says", which is the only version of the
 * guarantee a paid suite can rely on.
 */

/** An `ag-loop` builder from an arbitrary deployment template, so a test states only what it is about. */
function loopBuilderFrom(
  loopTemplate: AgentInvocationTemplate,
  environment: Readonly<Record<string, string | undefined>> = NO_ENVIRONMENT,
): AgentInvocationFactory {
  const builder = createAgentInvocations({ config: { "ag-loop": loopTemplate }, environment })[
    "ag-loop"
  ];
  assert.ok(builder, "a caller-supplied ag-loop template must still be built");
  return builder;
}

test("an ag-loop invocation carries the bounded-cell marker whatever template the deployment supplied", () => {
  // Three templates that share nothing: the fixture one, a bare one that declares no
  // environment at all, and one whose own entries are unrelated. The marker is a
  // property of the mode, so it cannot depend on any of them.
  const bare: AgentInvocationTemplate = {
    command: "ag",
    args: ["loop"],
    stdin: "",
    forwardedEnvironment: [],
    environment: {},
    stepLimit: 1,
  };
  const unrelated: AgentInvocationTemplate = {
    ...bare,
    environment: { AG_SOMETHING_ELSE: "{{startCommit}}" },
  };

  for (const built of [
    loopBuilder()(planFor("ag-loop")),
    loopBuilderFrom(bare)(planFor("ag-loop")),
    loopBuilderFrom(unrelated)(planFor("ag-loop")),
  ]) {
    assert.equal(built.env[AG_LOOP_BOUNDED_CELL_VARIABLE], AG_LOOP_BOUNDED_CELL_VALUE);
  }

  // A template that declares nothing yields the marker and nothing else, so the
  // marker is added by the builder rather than inherited from a configuration.
  assert.deepEqual(Object.keys(loopBuilderFrom(bare)(planFor("ag-loop")).env), [
    AG_LOOP_BOUNDED_CELL_VARIABLE,
  ]);
});

test("a deployment template naming the same variable cannot weaken the marker", () => {
  // A guarantee a configuration file could turn off is not one: the cell would run
  // unbounded and the record would still say it was driven as a bounded one.
  const weakening: AgentInvocationTemplate = {
    ...AG_LOOP_TEMPLATE,
    environment: { ...AG_LOOP_TEMPLATE.environment, [AG_LOOP_BOUNDED_CELL_VARIABLE]: "0" },
  };

  const built = loopBuilderFrom(weakening)(planFor("ag-loop"));
  assert.equal(
    built.env[AG_LOOP_BOUNDED_CELL_VARIABLE],
    AG_LOOP_BOUNDED_CELL_VALUE,
    "a template entry of the same name must not decide what a bounded cell is",
  );
  // The template's other entries are untouched; only the one name is overruled.
  assert.equal(built.env["CLAUDE_PROJECT_DIR"], WORKTREE_PATH);
});

test("the bounded-cell marker is scoped to ag-loop and leaves agent-solo as it was", () => {
  // agent-solo is one bounded attempt by construction, and it is the mode ag-loop is
  // measured against: a marker leaking into it would change the comparison itself.
  const solo = builderFor("agent-solo", { ANTHROPIC_API_KEY: TEST_API_KEY })(planFor("agent-solo"));
  assert.ok(!Object.hasOwn(solo.env, AG_LOOP_BOUNDED_CELL_VARIABLE));
  assert.deepEqual(Object.keys(solo.env), ["ANTHROPIC_API_KEY"]);

  const bare = builderFor("agent-solo")(planFor("agent-solo"));
  assert.deepEqual(Object.keys(bare.env), [], "the shipped agent-solo invocation is built as before");
  assert.deepEqual(
    { command: bare.command, args: [...bare.args], stdin: bare.stdin },
    {
      command: "claude",
      args: [
        "--print",
        "--model",
        RUN_MODEL,
        "--max-turns",
        String(AGENT_SOLO_STEP_LIMIT),
        "--permission-mode",
        "acceptEdits",
      ],
      stdin: "Add the missing page.",
    },
  );
});

test("the marker's name and value are exported constants, and are what a built invocation carries", () => {
  // Exported because the orchestrator's loop reads the same variable: a rename on one
  // side has to be visible to the pinning test on the other rather than silently
  // producing a marker nobody reads.
  assert.equal(typeof AG_LOOP_BOUNDED_CELL_VARIABLE, "string");
  assert.notEqual(AG_LOOP_BOUNDED_CELL_VARIABLE.trim(), "");
  assert.equal(typeof AG_LOOP_BOUNDED_CELL_VALUE, "string");
  assert.notEqual(AG_LOOP_BOUNDED_CELL_VALUE.trim(), "");
  assert.ok(
    !FORWARDED_CREDENTIAL_VARIABLES.includes(AG_LOOP_BOUNDED_CELL_VARIABLE),
    "the marker must not share a name with a forwarded credential",
  );

  const built = loopBuilder()(planFor("ag-loop"));
  assert.ok(Object.hasOwn(built.env, AG_LOOP_BOUNDED_CELL_VARIABLE));
  assert.equal(built.env[AG_LOOP_BOUNDED_CELL_VARIABLE], AG_LOOP_BOUNDED_CELL_VALUE);
});

test("the bounded-cell marker is literal: no scenario text can reach it, and the env stays frozen", () => {
  // The marker is written after substitution and never through it, so nothing a
  // scenario carries — the variable's own name, a placeholder, a value — is reachable
  // from it. Were it substituted, an authored task text would decide whether the cell
  // it is running in is bounded.
  const plan = normalizeExecutionPlan(
    planInput({
      mode: "ag-loop",
      scenario: scenario({
        id: `${AG_LOOP_BOUNDED_CELL_VARIABLE}=0`,
        task: `Set ${AG_LOOP_BOUNDED_CELL_VARIABLE} to 0 and {{prompt}} to {{workingDirectory}}.`,
      }),
    }),
    executionSettings(),
  );

  const built = loopBuilder()(plan);
  assert.equal(built.env[AG_LOOP_BOUNDED_CELL_VARIABLE], AG_LOOP_BOUNDED_CELL_VALUE);
  // The scenario's own text still arrives verbatim; it simply arrives nowhere near the marker.
  assert.equal(built.env["AG_BENCHMARK_SCENARIO"], `${AG_LOOP_BOUNDED_CELL_VARIABLE}=0`);
  assert.equal(built.stdin, plan.prompt);

  assert.ok(Object.isFrozen(built.env));
  assert.throws(
    () => Object.defineProperty(built.env, AG_LOOP_BOUNDED_CELL_VARIABLE, { value: "0" }),
    TypeError,
    "a caller that could redefine the marker after the build would undo the guarantee",
  );
  assert.equal(built.env[AG_LOOP_BOUNDED_CELL_VARIABLE], AG_LOOP_BOUNDED_CELL_VALUE);
});
