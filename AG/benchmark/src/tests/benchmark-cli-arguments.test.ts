import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_CLI_COMMANDS,
  DEFAULT_REPETITIONS,
  MAXIMUM_REPETITIONS,
  parseBenchmarkCliArguments,
  type BenchmarkCliInvocation,
} from "../interfaces/cli/benchmark-cli-arguments.js";
import { EXECUTION_MODES } from "../domain/result.js";

/**
 * The argument contract of BENCH-10. Every assertion here is about what the CLI
 * accepts and refuses before anything is measured — a parser that quietly
 * accepted a misspelled permission flag would run the whole suite against a paid
 * model on a caller's behalf.
 */

function parsed(argv: readonly string[]): BenchmarkCliInvocation {
  const result = parseBenchmarkCliArguments(argv);
  assert.ok(result.ok, `expected a request, got: ${result.ok ? "" : result.problem}`);
  return result.invocation;
}

function refusal(argv: readonly string[]): string {
  const result = parseBenchmarkCliArguments(argv);
  assert.ok(!result.ok, `expected a usage refusal for: ${argv.join(" ")}`);
  return result.problem;
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

test("every documented command parses under its documented name", () => {
  for (const command of BENCHMARK_CLI_COMMANDS) {
    const words = command.split(" ").slice(1);
    const argv = command === "benchmark compare" ? [...words, "--baseline", "b.json"] : words;
    assert.equal(parsed(argv).command, command);
  }
});

test("the two-word baseline command is not shadowed by a one-word prefix", () => {
  assert.equal(parsed(["baseline", "create"]).command, "benchmark baseline create");
  assert.match(refusal(["baseline"]), /unknown command "baseline"/);
});

test("no arguments and --help both ask for help rather than failing", () => {
  assert.equal(parsed([]).command, "help");
  assert.equal(parsed(["--help"]).command, "help");
  assert.equal(parsed(["-h"]).command, "help");
  assert.equal(parsed(["run", "--help"]).command, "help");
});

test("an unknown command is refused with the known command list", () => {
  const problem = refusal(["measure"]);
  assert.match(problem, /unknown command "measure"/);
  assert.match(problem, /baseline create/);
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test("run defaults to the whole suite, every mode, and the repetitions BENCH-9 requires", () => {
  const invocation = parsed(["run"]);
  assert.equal(invocation.command, "benchmark run");
  if (invocation.command !== "benchmark run") return;
  assert.deepEqual(invocation.scenarioIds, []);
  assert.deepEqual(invocation.modes, [...EXECUTION_MODES]);
  assert.equal(invocation.repetitions, DEFAULT_REPETITIONS);
  assert.equal(invocation.allowNetworkModels, false);
  assert.equal(invocation.dryRun, false);
});

test("the scenario filter is repeatable, comma-separable and deduplicated", () => {
  const invocation = parsed(["run", "--scenario", "a,b", "--scenario=b", "--scenario", "c"]);
  assert.equal(invocation.command, "benchmark run");
  if (invocation.command !== "benchmark run") return;
  assert.deepEqual(invocation.scenarioIds, ["a", "b", "c"]);
});

test("modes are checked against the known execution modes", () => {
  const invocation = parsed(["run", "--mode", "deterministic-control"]);
  assert.equal(invocation.command, "benchmark run");
  if (invocation.command !== "benchmark run") return;
  assert.deepEqual(invocation.modes, ["deterministic-control"]);
  assert.match(refusal(["run", "--mode", "vibes"]), /"vibes" is not an execution mode/);
});

test("network execution is off until it is asked for explicitly, under either spelling", () => {
  for (const flag of ["--allow-network", "--live"]) {
    const invocation = parsed(["run", flag]);
    assert.equal(invocation.command, "benchmark run");
    if (invocation.command !== "benchmark run") return;
    assert.equal(invocation.allowNetworkModels, true, `${flag} must grant the permission`);
  }
});

test("dry-run is a flag of run and takes no value", () => {
  const invocation = parsed(["run", "--dry-run"]);
  assert.equal(invocation.command, "benchmark run");
  if (invocation.command !== "benchmark run") return;
  assert.equal(invocation.dryRun, true);
  assert.match(refusal(["run", "--dry-run=yes"]), /is a flag and takes no value/);
});

test("repetitions must be a whole number inside the declared bounds", () => {
  const invocation = parsed(["run", "--repetitions", "5"]);
  assert.equal(invocation.command, "benchmark run");
  if (invocation.command !== "benchmark run") return;
  assert.equal(invocation.repetitions, 5);

  assert.match(refusal(["run", "--repetitions", "many"]), /expects a whole number/);
  assert.match(refusal(["run", "--repetitions", "0"]), /between 1 and /);
  assert.match(refusal(["run", "--repetitions", String(MAXIMUM_REPETITIONS + 1)]), /between 1 and /);
  assert.match(refusal(["run", "--repetitions"]), /requires a value/);
  assert.match(refusal(["run", "--repetitions", "3", "--repetitions", "4"]), /given more than once/);
});

test("compare refuses to run without the baseline it would compare against", () => {
  assert.match(refusal(["compare"]), /"--baseline" is required/);
  const invocation = parsed(["compare", "--baseline=baselines/v1.json"]);
  assert.equal(invocation.command, "benchmark compare");
  if (invocation.command !== "benchmark compare") return;
  assert.equal(invocation.baselinePath, "baselines/v1.json");
});

test("report defaults to markdown and refuses an unknown format", () => {
  const invocation = parsed(["report"]);
  assert.equal(invocation.command, "benchmark report");
  if (invocation.command !== "benchmark report") return;
  assert.equal(invocation.format, "markdown");
  assert.match(refusal(["report", "--format", "html"]), /is not a report format/);
});

test("an option of another command is not silently accepted", () => {
  assert.match(refusal(["validate", "--allow-network"]), /unknown option "--allow-network"/);
  assert.match(refusal(["run", "--allow-netwrok"]), /unknown option "--allow-netwrok"/);
});

test("a stray positional argument is refused rather than ignored", () => {
  assert.match(refusal(["validate", "everything"]), /unexpected argument "everything"/);
});

test("an option that needs a value refuses an empty one", () => {
  assert.match(refusal(["compare", "--baseline="]), /requires a non-empty value/);
});
