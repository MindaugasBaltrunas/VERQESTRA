import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FIXTURE_ROOT } from "../application/validate-suite.js";

/**
 * The fixture baseline (BENCH-2).
 *
 * A scenario is only a measurement if the fixture starts in the state the
 * scenario assumes. Two things can silently break that: a check the scenario
 * expects to be green having rotted, or a bug-report test having been "fixed"
 * in the fixture itself, which would leave the corresponding bugfix scenario
 * scoring an agent for doing nothing. Both are cheap to detect and impossible to
 * notice by reading, so the tests are actually executed here.
 *
 * Fixtures are dependency-free ESM, so `node --test` runs them as they stand.
 */
const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");

interface FixtureBaseline {
  readonly fixture: string;
  /** Green on a clean checkout: the ground a scenario is not allowed to break. */
  readonly green: readonly string[];
  /** Red on a clean checkout: the bug and gap reports, documented in each fixture README. */
  readonly red: readonly string[];
}

const BASELINES: readonly FixtureBaseline[] = [
  {
    fixture: "task-service",
    green: ["task-store.test.mjs", "priority.test.mjs", "summary.test.mjs"],
    red: ["priority-unknown-label.test.mjs"],
  },
  {
    fixture: "web-widget",
    green: ["render-status-badge.test.mjs", "i18n.test.mjs"],
    red: ["i18n-missing-key.test.mjs"],
  },
  {
    fixture: "auth-gateway",
    green: ["permissions.test.mjs", "session-token.test.mjs"],
    red: ["session-token-expiry.test.mjs"],
  },
  {
    fixture: "docs-site",
    green: ["docs-conventions.test.mjs"],
    red: ["settings-documented.test.mjs", "changelog-releases.test.mjs"],
  },
];

/**
 * The environment a fixture run must NOT inherit. `node --test` marks its
 * children with `NODE_TEST_CONTEXT`, and a child that sees it refuses to run any
 * file and exits 0 — which would turn every assertion below into a vacuous pass
 * in exactly the direction that hides a broken fixture.
 */
const INHERITED_TEST_RUNNER_VARIABLES = ["NODE_TEST_CONTEXT", "NODE_OPTIONS"];

/** A hung fixture must fail this suite rather than stall it forever. */
const FIXTURE_TEST_TIMEOUT_MS = 60_000;

interface FixtureRun {
  readonly status: number;
  readonly total: number;
  readonly failed: number;
  readonly output: string;
}

/**
 * Runs one fixture test file and reads its TAP summary.
 *
 * The counts, not the exit status, are what the assertions below rely on. An
 * exit code alone cannot tell "two assertions failed" apart from "the file has
 * a syntax error", "an import is missing" or "the process was killed" — and
 * every one of those would satisfy a bare `notEqual(status, 0)` while proving
 * nothing about the defect the file is supposed to report. The reporter is
 * pinned so the parsing does not depend on whether a terminal is attached.
 */
function runFixtureTest(fixture: string, file: string): FixtureRun {
  const environment = { ...process.env };
  for (const name of INHERITED_TEST_RUNNER_VARIABLES) delete environment[name];
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", path.posix.join("test", file)],
    {
      cwd: path.join(packageRoot, FIXTURE_ROOT, fixture),
      encoding: "utf8",
      env: environment,
      timeout: FIXTURE_TEST_TIMEOUT_MS,
    },
  );
  if (result.error !== undefined) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  const where = `${fixture}/test/${file}`;

  assert.equal(result.signal, null, `${where} was killed by ${result.signal}:\n${output}`);
  const count = (label: string): number => {
    const matched = output.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
    assert.ok(matched !== null, `${where} produced no TAP "${label}" line, so it never ran:\n${output}`);
    return Number(matched[1]);
  };
  const total = count("tests");
  assert.ok(total > 0, `${where} declares no tests:\n${output}`);
  return { status: result.status ?? -1, total, failed: count("fail"), output };
}

for (const baseline of BASELINES) {
  test(`${baseline.fixture}: every test file is classified as green or red`, () => {
    const onDisk = readdirSync(path.join(packageRoot, FIXTURE_ROOT, baseline.fixture, "test"))
      .filter((name) => name.endsWith(".test.mjs"))
      .sort();
    const classified = [...baseline.green, ...baseline.red].sort();
    assert.deepEqual(
      onDisk,
      classified,
      "a fixture test file was added or removed without deciding its baseline",
    );
  });

  test(`${baseline.fixture}: the tests a scenario relies on are green`, () => {
    for (const file of baseline.green) {
      const run = runFixtureTest(baseline.fixture, file);
      assert.equal(run.failed, 0, `${baseline.fixture}/test/${file} is not green:\n${run.output}`);
      assert.equal(
        run.status,
        0,
        `${baseline.fixture}/test/${file} exited ${run.status}:\n${run.output}`,
      );
    }
  });

  test(`${baseline.fixture}: the bug and gap reports still fail`, () => {
    for (const file of baseline.red) {
      const run = runFixtureTest(baseline.fixture, file);
      assert.ok(
        run.failed >= 1,
        `${baseline.fixture}/test/${file} reports no failing assertion; the defect it documents was fixed in the fixture, which leaves its scenario measuring nothing:\n${run.output}`,
      );
    }
  });
}

test("every fixture directory declares a baseline", () => {
  const onDisk = readdirSync(path.join(packageRoot, FIXTURE_ROOT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(onDisk, BASELINES.map((baseline) => baseline.fixture).sort());
});

/** Every file under `fixtures/`, relative to the fixture root, in a stable order. */
function fixtureFiles(directory = path.join(packageRoot, FIXTURE_ROOT)): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return fixtureFiles(absolute);
      return [path.relative(path.join(packageRoot, FIXTURE_ROOT), absolute).split(path.sep).join("/")];
    });
}

/**
 * Names the repository's `.gitignore` silences at any depth. A fixture file
 * matching one of these would be untracked, so a clean clone would materialise a
 * different fixture than the one the suite hash was frozen against — and the
 * failure would appear on someone else's machine, not on the author's.
 */
const IGNORED_FIXTURE_NAMES = [/^node_modules$/, /^dist$/, /\.log$/, /^\.env/];

test("no fixture file is one the repository would refuse to track", () => {
  for (const file of fixtureFiles()) {
    for (const segment of file.split("/")) {
      for (const pattern of IGNORED_FIXTURE_NAMES) {
        assert.doesNotMatch(segment, pattern, `fixtures/${file} would be gitignored`);
      }
    }
  }
});

test("no fixture declares a package, so nothing has to be installed to run one", () => {
  for (const file of fixtureFiles()) {
    assert.ok(
      !file.endsWith("package.json") && !file.endsWith("pnpm-lock.yaml"),
      `fixtures/${file} turns its fixture into a package the workspace would try to resolve`,
    );
  }
});

/** `import x from`, `export … from`, bare `import "…"`, `import()` and `require()`. */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s+)["']([^"']+)["']/g;

test("every fixture module imports only its own files and the Node standard library", () => {
  for (const file of fixtureFiles().filter((name) => name.endsWith(".mjs"))) {
    const source = readFileSync(path.join(packageRoot, FIXTURE_ROOT, file), "utf8");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] as string;
      assert.ok(
        specifier.startsWith(".") || specifier.startsWith("node:"),
        `fixtures/${file} imports "${specifier}", which would have to be installed before the fixture could run`,
      );
    }
  }
});
