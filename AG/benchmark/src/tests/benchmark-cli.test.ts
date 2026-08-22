import assert from "node:assert/strict";
import test from "node:test";

import {
  BenchmarkRunNotExecutedError,
  type BenchmarkApplicationApi,
  type BenchmarkRunPlan,
  type BenchmarkRunSummary,
  type SuiteValidationReport,
} from "../application/benchmark-api.js";
import { SampleLedgerIntegrityError } from "../application/sample-ledger.js";
import type { BenchmarkBaseline } from "../domain/baseline.js";
import { validManifest } from "./baseline-fixtures.js";
import type { BenchmarkSample } from "../domain/result.js";
import type { BenchmarkComparison, ComparisonVerdict } from "../domain/verdict.js";
import { BENCHMARK_EXIT_CODES } from "../interfaces/cli/benchmark-exit-codes.js";
import { runBenchmarkCli, type BenchmarkCliPorts } from "../interfaces/cli/benchmark-cli.js";
import { validSample } from "./sample-fixtures.js";

/**
 * The exit-code and rendering contract of `ag benchmark` (BENCH-10).
 *
 * The API is stubbed throughout: this file is about what the delivery layer does
 * with an answer, and a test that needed a real suite, a worktree or a model
 * could not state "a regression exits 1 and an unreadable ledger exits 3" as two
 * separate, deterministic facts.
 */

const EMPTY_SUMMARY: BenchmarkRunSummary = {
  identity: {
    suiteHash: "sha256:suite",
    configHash: "sha256:config",
    policyHash: "sha256:policy",
    agCommit: "c".repeat(40),
    modeAdapterVersions: {
      "ag-loop": "ag-loop/1",
      "agent-solo": "agent-solo/1",
      "deterministic-control": "deterministic-control/1",
    },
  },
  environment: { platform: "linux", arch: "x64", nodeVersion: "v22.0.0", cpuCount: 8 },
  samples: [],
  aggregates: [],
};

function summaryOf(samples: readonly BenchmarkSample[]): BenchmarkRunSummary {
  return { ...EMPTY_SUMMARY, samples };
}

function comparisonOf(verdict: ComparisonVerdict): BenchmarkComparison {
  return { verdict, reasons: [], scenarios: [], limitations: [] };
}

const CLEAN_PLAN: BenchmarkRunPlan = {
  suiteHash: "sha256:suite",
  scenarioIds: ["alpha"],
  modes: ["deterministic-control"],
  repetitions: 3,
  allowNetworkModels: false,
  sampleCount: 3,
  problems: [],
};

/**
 * A dependency this test did not stub. It rejects with a value the delivery
 * layer classifies as a harness failure, so forgetting a stub shows up as exit 5
 * rather than as a passing assertion about a path that was never taken.
 */
function unavailable(capability: string): () => Promise<never> {
  return () => Promise.reject(new Error(`the test did not stub "${capability}"`));
}

/** Every method refuses by default, so a test that forgot to stub one fails loudly. */
function stubApi(overrides: Partial<BenchmarkApplicationApi> = {}): BenchmarkApplicationApi {
  return {
    validate: unavailable("validate"),
    plan: unavailable("plan"),
    run: unavailable("run"),
    createBaseline: unavailable("createBaseline"),
    compare: unavailable("compare"),
    report: unavailable("report"),
    verify: unavailable("verify"),
    ...overrides,
  };
}

function stubPorts(overrides: Partial<BenchmarkCliPorts> = {}): BenchmarkCliPorts {
  return {
    api: stubApi(),
    loadBaseline: unavailable("loadBaseline"),
    loadSamples: unavailable("loadSamples"),
    loadCurrentSummary: unavailable("loadCurrentSummary"),
    saveBaseline: unavailable("saveBaseline"),
    writeReport: unavailable("writeReport"),
    ...overrides,
  };
}

interface Invocation {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function invoke(argv: readonly string[], ports: BenchmarkCliPorts): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBenchmarkCli(argv, {
    createPorts: () => ports,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// ---------------------------------------------------------------------------
// Help and usage
// ---------------------------------------------------------------------------

test("help lists every command, its options and the exit-code contract", async () => {
  const result = await invoke(["--help"], stubPorts());
  assert.equal(result.code, BENCHMARK_EXIT_CODES.ok);
  for (const fragment of ["validate", "run", "baseline create", "compare", "report", "verify"]) {
    assert.ok(result.out.includes(fragment), `help omits the ${fragment} command`);
  }
  assert.match(result.out, /--allow-network/);
  assert.match(result.out, /--dry-run/);
  assert.match(result.out, /1 {2}gateNotPassed/);
  assert.match(result.out, /5 {2}infrastructureError/);
});

test("a usage error exits 2 and never builds the API", async () => {
  let built = 0;
  const err: string[] = [];
  const out: string[] = [];
  const code = await runBenchmarkCli(["nonsense"], {
    createPorts: () => {
      built += 1;
      return stubPorts();
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  assert.equal(code, BENCHMARK_EXIT_CODES.usageError);
  assert.match(err.join("\n"), /unknown command "nonsense"/);
  assert.match(err.join("\n"), /--help/);
  assert.deepEqual(out, []);
  assert.equal(built, 0, "a rejected invocation must not open a repository or read a suite");
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

test("a valid suite exits 0 and prints the hash it validated", async () => {
  const report: SuiteValidationReport = { suiteHash: "sha256:abc", scenarioCount: 21, problems: [] };
  const result = await invoke(["validate"], stubPorts({ api: stubApi({ validate: () => Promise.resolve(report) }) }));
  assert.equal(result.code, BENCHMARK_EXIT_CODES.ok);
  assert.match(result.out, /21 scenarios/);
  assert.match(result.out, /sha256:abc/);
});

test("an invalid suite exits 3 and lists every problem", async () => {
  const report: SuiteValidationReport = {
    suiteHash: "",
    scenarioCount: 3,
    problems: ["scenarios: empty: expected at least 20 scenarios, received 3"],
  };
  const result = await invoke(["validate"], stubPorts({ api: stubApi({ validate: () => Promise.resolve(report) }) }));
  assert.equal(result.code, BENCHMARK_EXIT_CODES.validationFailed);
  assert.match(result.out, /expected at least 20 scenarios/);
});

test("--json prints the report as parseable JSON instead of prose", async () => {
  const report: SuiteValidationReport = { suiteHash: "sha256:abc", scenarioCount: 21, problems: [] };
  const result = await invoke(
    ["validate", "--json"],
    stubPorts({ api: stubApi({ validate: () => Promise.resolve(report) }) }),
  );
  assert.deepEqual(JSON.parse(result.out), report);
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

test("a dry run reports the resolved plan and executes nothing", async () => {
  let executed = false;
  const result = await invoke(
    ["run", "--dry-run", "--scenario", "alpha", "--mode", "deterministic-control"],
    stubPorts({
      api: stubApi({
        plan: () => Promise.resolve(CLEAN_PLAN),
        run: () => {
          executed = true;
          return Promise.resolve(EMPTY_SUMMARY);
        },
      }),
    }),
  );
  assert.equal(result.code, BENCHMARK_EXIT_CODES.ok);
  assert.match(result.out, /3 sample\(s\) would be executed/);
  assert.equal(executed, false, "a dry run must not execute the suite");
});

test("a dry run whose plan was refused exits 3 with the reasons", async () => {
  const plan: BenchmarkRunPlan = {
    ...CLEAN_PLAN,
    suiteHash: "",
    problems: ['"ghost" is not a scenario of this suite'],
  };
  const result = await invoke(
    ["run", "--dry-run", "--scenario", "ghost"],
    stubPorts({ api: stubApi({ plan: () => Promise.resolve(plan) }) }),
  );
  assert.equal(result.code, BENCHMARK_EXIT_CODES.validationFailed);
  assert.match(result.out, /is not a scenario of this suite/);
});

test("a live run is refused before execution when the plan has problems", async () => {
  let executed = false;
  const plan: BenchmarkRunPlan = {
    ...CLEAN_PLAN,
    problems: ['mode "ag-loop" reaches a paid model over the network'],
  };
  const result = await invoke(
    ["run"],
    stubPorts({
      api: stubApi({
        plan: () => Promise.resolve(plan),
        run: () => {
          executed = true;
          return Promise.resolve(EMPTY_SUMMARY);
        },
      }),
    }),
  );
  assert.equal(result.code, BENCHMARK_EXIT_CODES.validationFailed);
  assert.equal(executed, false, "an unpermitted network run must not start");
  assert.match(result.err, /reaches a paid model/);
});

test("a run that stored samples exits 0 and reports them per mode", async () => {
  const summary = summaryOf([validSample(), validSample({ sampleId: "sample-0002", mode: "agent-solo" })]);
  const result = await invoke(
    ["run", "--allow-network"],
    stubPorts({
      api: stubApi({ plan: () => Promise.resolve(CLEAN_PLAN), run: () => Promise.resolve(summary) }),
    }),
  );
  assert.equal(result.code, BENCHMARK_EXIT_CODES.ok);
  assert.match(result.out, /samples: 2/);
  assert.match(result.out, /ag-loop: 1/);
});

test("a run that produced no sample is inconclusive, not a pass", async () => {
  const result = await invoke(
    ["run", "--allow-network"],
    stubPorts({
      api: stubApi({ plan: () => Promise.resolve(CLEAN_PLAN), run: () => Promise.resolve(EMPTY_SUMMARY) }),
    }),
  );
  assert.equal(result.code, BENCHMARK_EXIT_CODES.inconclusive);
  assert.match(result.err, /measured nothing/);
});

// ---------------------------------------------------------------------------
// compare, report
// ---------------------------------------------------------------------------

const BASELINE: BenchmarkBaseline = {
  schemaVersion: 1,
  createdAt: "2026-08-06T09:00:00.000Z",
  identity: EMPTY_SUMMARY.identity,
  modelSettings: { model: "claude-opus-5" },
  environment: EMPTY_SUMMARY.environment,
  samples: [],
  aggregates: [],
  manifest: validManifest(),
};

function comparingPorts(verdict: ComparisonVerdict): BenchmarkCliPorts {
  return stubPorts({
    loadBaseline: () => Promise.resolve(BASELINE),
    loadCurrentSummary: () => Promise.resolve(EMPTY_SUMMARY),
    api: stubApi({
      compare: () => Promise.resolve(comparisonOf(verdict)),
      report: (request) =>
        Promise.resolve({
          format: request.format,
          content: `# report\n\nverdict: ${request.comparison?.verdict ?? "none"}`,
          generatedFrom: EMPTY_SUMMARY.identity,
        }),
    }),
  });
}

test("each comparison verdict maps to its own exit code", async () => {
  const expected: ReadonlyArray<readonly [ComparisonVerdict, number]> = [
    ["improved", BENCHMARK_EXIT_CODES.ok],
    ["stable", BENCHMARK_EXIT_CODES.ok],
    ["regressed", BENCHMARK_EXIT_CODES.gateNotPassed],
    ["inconclusive", BENCHMARK_EXIT_CODES.inconclusive],
  ];
  for (const [verdict, code] of expected) {
    const result = await invoke(["compare", "--baseline", "baselines/v1.json"], comparingPorts(verdict));
    assert.equal(result.code, code, `verdict ${verdict} must exit ${code}`);
    assert.match(result.out, new RegExp(`verdict: ${verdict}`));
  }
});

test("a report without a baseline prints the document and claims no verdict", async () => {
  const result = await invoke(["report"], comparingPorts("regressed"));
  assert.equal(result.code, BENCHMARK_EXIT_CODES.ok);
  assert.match(result.out, /^# report/);
  assert.match(result.out, /verdict: none/);
});

test("a report that carries a regression exits 1, like the gate it feeds", async () => {
  const result = await invoke(["report", "--baseline", "baselines/v1.json"], comparingPorts("regressed"));
  assert.equal(result.code, BENCHMARK_EXIT_CODES.gateNotPassed);
  assert.match(result.out, /verdict: regressed/);
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

test("re-derived acceptance exits 0 when every stored sample could be judged", async () => {
  const samples = [validSample()];
  const result = await invoke(
    ["verify"],
    stubPorts({
      loadSamples: () => Promise.resolve(samples),
      api: stubApi({ verify: (given) => Promise.resolve(summaryOf(given)) }),
    }),
  );
  assert.equal(result.code, BENCHMARK_EXIT_CODES.ok);
  assert.match(result.out, /re-derived acceptance for 1 of 1 stored sample/);
});

test("a sample whose acceptance cannot be re-derived is inconclusive", async () => {
  const samples = [
    validSample({
      sampleId: "sample-0009",
      acceptance: { verdict: "inconclusive", reasons: ["telemetry-missing"], agentClaimedDone: true },
    }),
  ];
  const result = await invoke(
    ["verify"],
    stubPorts({
      loadSamples: () => Promise.resolve(samples),
      api: stubApi({ verify: (given) => Promise.resolve(summaryOf(given)) }),
    }),
  );
  assert.equal(result.code, BENCHMARK_EXIT_CODES.inconclusive);
  assert.match(result.err, /sample-0009/);
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

test("a baseline asked for before any run is a refused input naming the missing run", async () => {
  const result = await invoke(
    ["baseline", "create"],
    stubPorts({
      loadCurrentSummary: () => Promise.reject(new BenchmarkRunNotExecutedError("snapshot")),
    }),
  );
  assert.equal(result.code, BENCHMARK_EXIT_CODES.validationFailed);
  assert.match(result.err, /no executed run to snapshot/);
  assert.match(result.err, /ag benchmark run/);
  assert.doesNotMatch(
    result.err,
    /cannot execute/,
    "the refusal is about the missing run, not about a capability this build lacks",
  );
});

test("a corrupt sample ledger is a refused input, not a harness failure", async () => {
  const result = await invoke(
    ["verify"],
    stubPorts({
      loadSamples: () => Promise.reject(new SampleLedgerIntegrityError(["line 4: not JSON"])),
    }),
  );
  assert.equal(result.code, BENCHMARK_EXIT_CODES.validationFailed);
  assert.match(result.err, /unreadable record/);
});

test("an unexpected failure is infrastructure, never a verdict", async () => {
  const result = await invoke(
    ["validate"],
    stubPorts({ api: stubApi({ validate: () => Promise.reject(new Error("EACCES: permission denied")) }) }),
  );
  assert.equal(result.code, BENCHMARK_EXIT_CODES.infrastructureError);
  assert.match(result.err, /EACCES/);
});
