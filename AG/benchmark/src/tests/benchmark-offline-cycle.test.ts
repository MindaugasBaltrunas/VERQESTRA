import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CANONICAL_DIGEST_PATTERN } from "../domain/baseline/canonical-json.js";
import { SCENARIO_CATEGORIES, type ScenarioCategory } from "../domain/scenario.js";
import { execFileGitRunner } from "../infrastructure/git/git-runner.js";
import { RUN_LEDGER_DIRECTORY, runIdentityPath } from "../infrastructure/run-ledger-store.js";
import { BENCHMARK_EXIT_CODES } from "../interfaces/cli/benchmark-exit-codes.js";
import { runBenchmarkCommand } from "../interfaces/cli/benchmark-cli-composition.js";

/**
 * The whole command, offline, end to end (BENCH-8, BENCH-9, BENCH-10).
 *
 * `deterministic-control` calls no model and reaches no network, so this is the
 * one mode in which `run → baseline create → compare → report` can be executed
 * for real in a test — real Git worktrees, real check processes, real stored
 * samples, and no bill. Everything the unit tests assert about the rules is
 * asserted about a value; what only this file can show is that the assembled
 * command actually executes them, which is precisely the gap the operator hit
 * when `run` answered "the benchmark API cannot execute run yet".
 *
 * The suite is generated into a temporary package root rather than taken from
 * the authored one. Two reasons, both about what the test would otherwise be
 * measuring: the authored fixtures carry real projects whose checks take
 * minutes, and a run against the shipped package would write ledgers and
 * baselines into the repository.
 */

/** Every scenario points at one fixture, so the run materializes a single repository. */
const FIXTURE = "fixtures/sample-project";

/** The categories whose correct outcome is a refusal; the suite validator insists on the pairing. */
const REFUSAL_CATEGORIES: ReadonlySet<ScenarioCategory> = new Set([
  "architecture-violation",
  "security-violation",
  "impossible-task",
]);

/** Twenty is the floor the suite validator enforces (BENCH-2). */
const SUITE_SIZE = 20;

/**
 * A check that exits 0 without reading anything.
 *
 * A bare program name, because the check runner refuses a path — a fixture that
 * could name its own grader would be graded by the change under test.
 */
const PASSING_CHECK = ["node", "-e", "process.exit(0)"] as const;

function scenarioDocument(index: number): Record<string, unknown> {
  const category = SCENARIO_CATEGORIES[index % SCENARIO_CATEGORIES.length] as ScenarioCategory;
  const refuses = REFUSAL_CATEGORIES.has(category);
  return {
    id: `cycle-scenario-${String(index + 1).padStart(2, "0")}`,
    title: `Cycle scenario ${index + 1}`,
    category,
    fixture: FIXTURE,
    task: `Do the ${category} task described by scenario ${index + 1}.`,
    allowedPaths: ["src"],
    // A refusal scenario has to name what it must not touch, or nothing
    // separates a refusal from inaction.
    forbiddenPaths: refuses ? ["secrets"] : [],
    checks: [{ id: "unit", command: [...PASSING_CHECK], expect: "pass" }],
    expectedOutcome: refuses ? "rejected" : "accepted",
    limits: { timeoutMs: 60_000, tokenLimit: 100_000 },
    // Deterministic throughout, so one repetition is enough for BENCH-9 and the
    // cycle stays a test rather than a benchmark of the test host.
    deterministic: true,
  };
}

/** A benchmark package with a valid suite, one fixture, and a commit to be attributed to. */
async function createPackageRoot(): Promise<string> {
  const packageRoot = await mkdtemp(path.join(tmpdir(), "ag-benchmark-cycle-"));
  await mkdir(path.join(packageRoot, "scenarios"), { recursive: true });
  await mkdir(path.join(packageRoot, FIXTURE), { recursive: true });

  await writeFile(
    path.join(packageRoot, FIXTURE, "README.md"),
    "# sample project\n\nA fixture with one file, which is all an isolation test needs.\n",
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "scenarios", "suite.manifest.json"),
    JSON.stringify({ schemaVersion: 1, version: "1.0.0" }, null, 2),
    "utf8",
  );
  for (let index = 0; index < SUITE_SIZE; index += 1) {
    const document = scenarioDocument(index);
    await writeFile(
      path.join(packageRoot, "scenarios", `${String(document["id"])}.scenario.json`),
      JSON.stringify(document, null, 2),
      "utf8",
    );
  }

  // The environment capture reads the commit of the tree under measurement, and
  // a baseline that names no commit is refused as unattributable (BENCH-8). So
  // the temporary package is a repository with one commit, exactly as the real
  // one is.
  for (const args of [["init"], ["add", "--all"], ["commit", "--message", "cycle fixture"]]) {
    const result = await execFileGitRunner(args, { cwd: packageRoot });
    assert.ok(result.ok, `git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return packageRoot;
}

interface Invocation {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function invoke(argv: readonly string[], packageRoot: string): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBenchmarkCommand(
    argv,
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    { packageRoot },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("deterministic-control runs the whole cycle offline: run, baseline, compare, report", async () => {
  const packageRoot = await createPackageRoot();

  const validated = await invoke(["validate"], packageRoot);
  assert.equal(validated.code, BENCHMARK_EXIT_CODES.ok, validated.out || validated.err);

  const run = await invoke(
    ["run", "--mode", "deterministic-control", "--repetitions", "1"],
    packageRoot,
  );
  assert.equal(run.code, BENCHMARK_EXIT_CODES.ok, run.err);
  assert.match(run.out, new RegExp(`samples: ${SUITE_SIZE}`));
  assert.match(run.out, new RegExp(`deterministic-control: ${SUITE_SIZE}`));

  // The samples are on disk, in the run's own ledger, in the ledger format the
  // store already writes.
  const ledgerDirectory = path.join(packageRoot, ...RUN_LEDGER_DIRECTORY.split("/"));
  const written = await readdir(ledgerDirectory);
  const ledgers = written.filter((name) => name.endsWith(".jsonl"));
  assert.equal(ledgers.length, 1, "one run wrote exactly one ledger");
  const ledgerName = ledgers[0] as string;
  const stored = (await readFile(path.join(ledgerDirectory, ledgerName), "utf8"))
    .split("\n")
    .filter((line) => line !== "");
  assert.equal(stored.length, SUITE_SIZE);

  // And beside it, what the run states about itself (BENCH-8). Only the assembled
  // command can show this: every other test drives the pipeline with stores a
  // test wired, and none of them would notice a composition root that built the
  // ledger without the sidecar.
  const identityName = runIdentityPath(ledgerName);
  assert.ok(written.includes(identityName), `the run recorded no identity beside ${ledgerName}`);
  const recorded = JSON.parse(
    await readFile(path.join(ledgerDirectory, identityName), "utf8"),
  ) as { readonly identity: { readonly configHash: string; readonly policyHash: string } };
  assert.match(recorded.identity.configHash, CANONICAL_DIGEST_PATTERN);
  assert.match(recorded.identity.policyHash, CANONICAL_DIGEST_PATTERN);

  const created = await invoke(["baseline", "create", "--out", "baselines/cycle.json"], packageRoot);
  assert.equal(created.code, BENCHMARK_EXIT_CODES.ok, created.err);
  assert.match(created.out, /baseline created at /);
  assert.match(created.out, new RegExp(`samples ${SUITE_SIZE}`));
  assert.match(created.out, /written baselines\/cycle\.json/);

  const compared = await invoke(["compare", "--baseline", "baselines/cycle.json"], packageRoot);
  assert.equal(
    compared.code,
    BENCHMARK_EXIT_CODES.ok,
    `a run compared against a baseline of itself is not a regression: ${compared.out}${compared.err}`,
  );
  assert.match(compared.out, /verdict: (stable|improved)/);

  const reported = await invoke(
    ["report", "--baseline", "baselines/cycle.json", "--format", "json", "--out", "reports/cycle.json"],
    packageRoot,
  );
  assert.equal(reported.code, BENCHMARK_EXIT_CODES.ok, reported.err);
  const document = JSON.parse(
    await readFile(path.join(packageRoot, "reports", "cycle.json"), "utf8"),
  ) as { readonly verdict?: unknown };
  assert.ok(typeof document.verdict === "string", "the written report carries the verdict");
});

test("a baseline asked for before any run refuses, and writes nothing", async () => {
  const packageRoot = await createPackageRoot();
  const result = await invoke(["baseline", "create"], packageRoot);

  assert.equal(result.code, BENCHMARK_EXIT_CODES.validationFailed);
  assert.match(result.err, /no executed run to summarize/);
  assert.match(result.err, /verqestra benchmark run/);
  await assert.rejects(() => readFile(path.join(packageRoot, "baselines"), "utf8"));
});

/**
 * A suite edit is refused once it has been MEASURED, and not before.
 *
 * This test used to edit the suite and compare immediately, expecting a refusal. It got one, and
 * for the wrong reason: `compare` re-derived the current run's methodology from the suite as it
 * stood at that moment, so it labelled samples taken under 1.0.0 as having been taken under 2.0.0
 * and then refused the mismatch it had just invented. The gate was catching the code's own false
 * statement, and it looked like BENCH-8 working.
 *
 * Once the current run is described by the identity it actually recorded, editing a file changes
 * nothing about samples already on disk — and so the two halves below are both required. The
 * refusal must still happen when a run genuinely was taken under a different suite, and it must
 * NOT happen when nothing has been re-measured. The second half is what the old test could not
 * express, because the behaviour it pinned made every suite edit look like a measurement.
 */
test("a suite edit is a mismatch only once a run has been taken under it", async () => {
  const packageRoot = await createPackageRoot();

  assert.equal(
    (await invoke(["run", "--mode", "deterministic-control", "--repetitions", "1"], packageRoot))
      .code,
    BENCHMARK_EXIT_CODES.ok,
  );
  assert.equal(
    (await invoke(["baseline", "create", "--out", "baselines/before.json"], packageRoot)).code,
    BENCHMARK_EXIT_CODES.ok,
  );

  // The scenarios themselves are untouched; only the version the suite is
  // published under moves. That alone re-identifies the suite, which is what
  // BENCH-8 asks it to do.
  await writeFile(
    path.join(packageRoot, "scenarios", "suite.manifest.json"),
    JSON.stringify({ schemaVersion: 1, version: "2.0.0" }, null, 2),
    "utf8",
  );

  // Nothing has been re-measured yet. The stored samples were taken under 1.0.0 and still say so,
  // so comparing them against a 1.0.0 baseline is a comparison of like with like.
  const beforeRerun = await invoke(["compare", "--baseline", "baselines/before.json"], packageRoot);
  assert.equal(
    beforeRerun.code,
    BENCHMARK_EXIT_CODES.ok,
    "an edit to a file on disk must not re-attribute samples that were already recorded",
  );
  assert.doesNotMatch(beforeRerun.out, /methodology-mismatch/);

  // Now the edited suite is actually executed, and the new run records 2.0.0 as its own.
  assert.equal(
    (await invoke(["run", "--mode", "deterministic-control", "--repetitions", "1"], packageRoot))
      .code,
    BENCHMARK_EXIT_CODES.ok,
  );

  const compared = await invoke(["compare", "--baseline", "baselines/before.json"], packageRoot);
  assert.equal(compared.code, BENCHMARK_EXIT_CODES.inconclusive);
  assert.match(compared.out, /verdict: inconclusive/);
  assert.match(compared.out, /methodology-mismatch/);
  assert.match(compared.out, /identity\.suiteHash differs/);
  assert.doesNotMatch(
    compared.out,
    /verdict: (stable|improved|regressed)/,
    "a pair the gate refused must not also publish a comparison",
  );
});
