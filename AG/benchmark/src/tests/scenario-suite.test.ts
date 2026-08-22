import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_ROOT,
  REFUSAL_SCENARIO_CATEGORIES,
  SCENARIO_SUITE_MINIMUM_SIZE,
  computeScenarioSuiteHash,
  validateBenchmarkSuite,
  type ScenarioDocument,
} from "../application/validate-suite.js";
import { SCENARIO_CATEGORIES } from "../domain/scenario.js";
import { isInsideBenchmarkWorkspace } from "../infrastructure/benchmark-workspace-paths.js";
import {
  HARNESS_EXCLUDED_PATHS,
  TOOLCHAIN_EXCLUDED_PATHS,
} from "../infrastructure/git/git-worktree-manager.js";

/**
 * The authored suite, checked as the artefact it is (BENCH-2).
 *
 * Package root is resolved from this module rather than from `process.cwd()`:
 * the runner is started from the repository root, and a cwd-relative root would
 * read some other package's `scenarios` directory — or none — and pass
 * vacuously.
 */
const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const scenariosDirectory = path.join(packageRoot, "scenarios");
const fixturesDirectory = path.join(packageRoot, FIXTURE_ROOT);

const SCENARIO_FILE_SUFFIX = ".scenario.json";

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

async function scenarioFileNames(): Promise<string[]> {
  const entries = await readdir(scenariosDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SCENARIO_FILE_SUFFIX))
    .map((entry) => entry.name);
}

async function loadDocuments(): Promise<ScenarioDocument[]> {
  const names = await scenarioFileNames();
  return Promise.all(
    names.map(async (name) => ({
      source: name,
      value: await readJson(path.join(scenariosDirectory, name)),
    })),
  );
}

async function availableFixtures(): Promise<string[]> {
  const entries = await readdir(fixturesDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${FIXTURE_ROOT}/${entry.name}`);
}

const manifest = () => readJson(path.join(scenariosDirectory, "suite.manifest.json"));

async function validated() {
  const outcome = validateBenchmarkSuite(await manifest(), await loadDocuments(), {
    availableFixtures: await availableFixtures(),
  });
  assert.deepEqual(
    outcome.problems.map((problem) => `${problem.path}: ${problem.code}: ${problem.message}`),
    [],
    "the authored suite does not validate",
  );
  assert.ok(outcome.suite !== undefined && outcome.suiteHash !== undefined);
  return { suite: outcome.suite, suiteHash: outcome.suiteHash, outcome };
}

// ---------------------------------------------------------------------------
// The suite as authored
// ---------------------------------------------------------------------------

test("the authored suite validates against the schema and the suite-level rules", async () => {
  await validated();
});

test("the suite holds at least the required number of scenarios", async () => {
  const { suite } = await validated();
  assert.ok(
    suite.scenarios.length >= SCENARIO_SUITE_MINIMUM_SIZE,
    `expected at least ${SCENARIO_SUITE_MINIMUM_SIZE} scenarios, found ${suite.scenarios.length}`,
  );
});

test("every category BENCH-2 requires is covered", async () => {
  const { outcome } = await validated();
  const uncovered = SCENARIO_CATEGORIES.filter((category) => outcome.categoryCoverage[category] === 0);
  assert.deepEqual(uncovered, [], `categories with no scenario: ${uncovered.join(", ")}`);
});

test("each scenario file contributes the scenario its name promises", async () => {
  const documents = await loadDocuments();
  for (const document of documents) {
    const declared = (document.value as { id?: unknown }).id;
    assert.equal(
      `${String(declared)}${SCENARIO_FILE_SUFFIX}`,
      document.source,
      `${document.source} declares the id "${String(declared)}"`,
    );
  }
});

test("every fixture a scenario names exists, is a directory and documents itself", async () => {
  const { suite } = await validated();
  for (const scenario of new Set(suite.scenarios.map((entry) => entry.fixture))) {
    const resolved = path.join(packageRoot, scenario);
    assert.ok((await stat(resolved)).isDirectory(), `${scenario} is not a directory`);
    assert.ok((await stat(path.join(resolved, "README.md"))).isFile(), `${scenario} has no README`);
  }
});

test("no declared path can leave the benchmark workspace", async () => {
  const { suite } = await validated();
  for (const scenario of suite.scenarios) {
    for (const declared of [scenario.fixture, ...scenario.allowedPaths, ...scenario.forbiddenPaths]) {
      // Globs are scope patterns, not paths to resolve; the traversal forms a
      // glob could hide behind are already refused by the schema.
      if (declared.includes("*")) continue;
      assert.ok(
        isInsideBenchmarkWorkspace(path.posix.join(scenario.fixture, declared)) ||
          isInsideBenchmarkWorkspace(declared),
        `${scenario.id} declares "${declared}", which resolves outside the workspace`,
      );
    }
  }
});

test("a check command is an argument vector, never a shell string", async () => {
  const { suite } = await validated();
  for (const scenario of suite.scenarios) {
    for (const check of scenario.checks) {
      assert.ok(check.command.length >= 2, `${scenario.id}/${check.id} has no arguments`);
      for (const argument of check.command) {
        assert.doesNotMatch(
          argument,
          /[|&;<>$`\n]/,
          `${scenario.id}/${check.id} passes "${argument}", which only means something to a shell`,
        );
      }
    }
  }
});

test("a scenario that must be refused allows nothing it is forbidden to change", async () => {
  const { suite } = await validated();
  for (const scenario of suite.scenarios) {
    if (!REFUSAL_SCENARIO_CATEGORIES.includes(scenario.category)) continue;
    assert.deepEqual(
      scenario.allowedPaths,
      ["README.md"],
      `${scenario.id} may only allow a place to record the refusal`,
    );
    assert.ok(
      scenario.checks.length > 0,
      `${scenario.id} declares no check, so an unharmed tree cannot be evidenced`,
    );
  }
});

test("every scenario is marked nondeterministic, because every mode runs a model", async () => {
  const { suite } = await validated();
  for (const scenario of suite.scenarios) {
    assert.equal(
      scenario.deterministic,
      false,
      `${scenario.id} claims a reproducible result BENCH-9 would then not repeat`,
    );
  }
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("the suite hash is the one the lock file froze", async () => {
  const { suiteHash } = await validated();
  const lock = (await readJson(path.join(scenariosDirectory, "suite.lock.json"))) as {
    version: string;
    suiteHash: string;
  };
  const { suite } = await validated();
  assert.equal(lock.version, suite.version, "the lock file was written for another suite version");
  assert.equal(
    suiteHash,
    lock.suiteHash,
    "the suite changed without the lock file being updated; bump the manifest version deliberately or revert the edit",
  );
});

test("the hash does not depend on the order the directory listing returned", async () => {
  const documents = await loadDocuments();
  const expected = (await validated()).suiteHash;
  const fixtures = await availableFixtures();
  for (const order of [
    [...documents].reverse(),
    [...documents.slice(5), ...documents.slice(0, 5)],
    [...documents].sort((left, right) => (left.source > right.source ? -1 : 1)),
  ]) {
    const outcome = validateBenchmarkSuite(await manifest(), order, {
      availableFixtures: fixtures,
    });
    assert.equal(outcome.suiteHash, expected);
  }
});

test("the hash does not depend on the line endings the files were checked out with", async () => {
  const expected = (await validated()).suiteHash;
  const names = await scenarioFileNames();
  // Both rewrites matter and only the second is load-bearing. Replacing the
  // newlines BETWEEN tokens proves the parse path is insensitive to how the file
  // was stored; replacing the escaped `\n` sequences INSIDE strings puts CRLF
  // into the parsed task text itself, which is the case a checkout with
  // `core.autocrlf` produces and the only one canonicalization has to normalise.
  const crlf = await Promise.all(
    names.map(async (name) => {
      const raw = await readFile(path.join(scenariosDirectory, name), "utf8");
      return {
        source: name,
        value: JSON.parse(raw.replace(/\r?\n/g, "\r\n").replace(/\\n/g, "\\r\\n")),
      };
    }),
  );
  const rewritten = crlf.filter((document) =>
    (document.value as { task: string }).task.includes("\r\n"),
  );
  assert.ok(rewritten.length > 0, "no scenario carries a multi-line task, so nothing was proven");

  const manifestRaw = await readFile(path.join(scenariosDirectory, "suite.manifest.json"), "utf8");
  const outcome = validateBenchmarkSuite(JSON.parse(manifestRaw.replace(/\r?\n/g, "\r\n")), crlf, {
    availableFixtures: await availableFixtures(),
  });
  assert.deepEqual(outcome.problems, []);
  assert.equal(outcome.suiteHash, expected);
});

test("every check names a file the scenario either ships or is allowed to create", async () => {
  const { suite } = await validated();
  for (const scenario of suite.scenarios) {
    const fixture = path.join(packageRoot, scenario.fixture);
    for (const check of scenario.checks) {
      assert.equal(check.command[0], "node", `${scenario.id}/${check.id} does not run Node`);
      const file = check.command.at(-1) as string;
      const exists = await stat(path.join(fixture, file)).then(
        () => true,
        () => false,
      );
      assert.ok(
        exists || scenario.allowedPaths.includes(file),
        `${scenario.id}/${check.id} runs "${file}", which the fixture does not ship and the scenario is not allowed to create`,
      );
    }
  }
});

/**
 * Whether a declared scope pattern covers a file. Only the two glob shapes the
 * suite actually uses are recognised; anything else must match literally, so an
 * unrecognised pattern narrows this check rather than silently widening it.
 */
function scopeCovers(pattern: string, file: string): boolean {
  if (pattern === file) return true;
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2));
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return file.startsWith(prefix) && !file.slice(prefix.length).includes("/");
  }
  return false;
}

test("a scenario that must produce a change ties every outcome to its own scope", async () => {
  const { suite } = await validated();
  for (const scenario of suite.scenarios) {
    if (scenario.expectedOutcome !== "accepted") continue;
    // A check is decisive when the scenario must create the file it runs, or
    // when that file is forbidden and therefore cannot be rewritten to pass. A
    // scenario with neither would be satisfied by an agent that changed nothing
    // — or by one that edited the check itself.
    const decisive = scenario.checks.some((check) => {
      const file = check.command.at(-1) as string;
      return [...scenario.allowedPaths, ...scenario.forbiddenPaths].some((pattern) =>
        scopeCovers(pattern, file),
      );
    });
    assert.ok(
      decisive,
      `${scenario.id} declares no check tied to its own scope, so doing nothing would pass it`,
    );
  }
});

test("the hash is stable across repeated computation of the same suite", async () => {
  const { suite } = await validated();
  assert.equal(computeScenarioSuiteHash(suite), computeScenarioSuiteHash(suite));
});

/**
 * The measured diff excludes some paths, and this is the argument that keeps that safe.
 *
 * `git-worktree-manager.ts` drops toolchain and harness paths from the diff both the report and
 * the scope gate read. Anything excluded there is invisible to `outOfScopeFiles`, so the
 * exclusion is defensible only while no scenario can legitimately name such a path. That was
 * checked by hand when the lists were written; this test is what keeps it true, because the
 * failure mode is silent — a new scenario naming `AG/…` would simply stop being scope-checked.
 */
test("no scenario names a path the measured diff excludes", async () => {
  const { suite } = await validated();
  const excluded: readonly string[] = [...TOOLCHAIN_EXCLUDED_PATHS, ...HARNESS_EXCLUDED_PATHS];
  const offenders: string[] = [];

  for (const scenario of suite.scenarios) {
    for (const declaredPath of [...scenario.allowedPaths, ...scenario.forbiddenPaths]) {
      const head = declaredPath.split("/")[0] ?? "";
      if (excluded.includes(head)) {
        offenders.push(`${scenario.id}: ${declaredPath}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a scenario declaring an excluded path would never be scope-checked on it",
  );
});
