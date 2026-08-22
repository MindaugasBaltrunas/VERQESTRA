import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXTURE_ROOT,
  REFUSAL_SCENARIO_CATEGORIES,
  SCENARIO_SUITE_MINIMUM_SIZE,
  assembleScenarioSuite,
  canonicalizeScenarioSuite,
  checkSuiteIntegrity,
  computeScenarioSuiteHash,
  toSuiteValidationReport,
  validateBenchmarkSuite,
  validateScenarioSuiteManifest,
  type ScenarioDocument,
} from "../application/validate-suite.js";
import {
  SCENARIO_CATEGORIES,
  type BenchmarkScenario,
  type ScenarioSuite,
} from "../domain/scenario.js";

/**
 * Unit tests for the pure suite layer. Everything here is built in memory: the
 * authored suite on disk is covered by `scenario-suite.test.ts`, and mixing the
 * two would make a failure here ambiguous between "the rule is wrong" and "the
 * data is wrong".
 */

const MANIFEST = { schemaVersion: 1, version: "1.0.0" } as const;

function scenario(overrides: Partial<BenchmarkScenario> = {}): BenchmarkScenario {
  return {
    id: "code-example",
    title: "Example",
    category: "code-change",
    fixture: `${FIXTURE_ROOT}/task-service`,
    task: "Do the thing.",
    allowedPaths: ["src/**"],
    forbiddenPaths: ["test/**"],
    checks: [{ id: "unit", command: ["node", "--test", "test/unit.test.mjs"], expect: "pass" }],
    expectedOutcome: "accepted",
    limits: { timeoutMs: 600_000, tokenLimit: 150_000 },
    deterministic: false,
    ...overrides,
  };
}

/** One scenario per category, so a suite built from it is complete by construction. */
function coveringScenarios(): BenchmarkScenario[] {
  return SCENARIO_CATEGORIES.flatMap((category, index) =>
    Array.from({ length: 3 }, (_unused, repeat) =>
      scenario({
        id: `${category}-${index}-${repeat}`,
        category,
        expectedOutcome: REFUSAL_SCENARIO_CATEGORIES.includes(category) ? "rejected" : "accepted",
      }),
    ),
  );
}

function suite(scenarios: readonly BenchmarkScenario[]): ScenarioSuite {
  return { schemaVersion: 1, version: "1.0.0", scenarios };
}

function documents(scenarios: readonly BenchmarkScenario[]): ScenarioDocument[] {
  return scenarios.map((value) => ({ source: `${value.id}.scenario.json`, value }));
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test("the manifest accepts exactly a schema version and a semantic version", () => {
  const result = validateScenarioSuiteManifest({ schemaVersion: 1, version: "2.3.4" });
  assert.equal(result.ok, true);
});

test("the manifest refuses a non-semantic version, an unknown field and a future schema", () => {
  for (const input of [
    { schemaVersion: 1, version: "1.0" },
    { schemaVersion: 1, version: "1.0.0", scenarios: [] },
    { schemaVersion: 2, version: "1.0.0" },
    { version: "1.0.0" },
    "not an object",
  ]) {
    assert.equal(validateScenarioSuiteManifest(input).ok, false, JSON.stringify(input));
  }
});

// ---------------------------------------------------------------------------
// Canonicalization and hashing
// ---------------------------------------------------------------------------

test("the canonical form sorts object keys and drops insignificant whitespace", () => {
  const canonical = canonicalizeScenarioSuite(suite([scenario()]));
  assert.match(canonical, /^\{"scenarios":\[\{"allowedPaths":/);
  assert.ok(!canonical.includes("\n"), canonical);
});

test("the hash ignores the order the scenario files were read in", () => {
  const scenarios = coveringScenarios();
  const forwards = computeScenarioSuiteHash(suite(scenarios));
  const backwards = computeScenarioSuiteHash(suite([...scenarios].reverse()));
  const rotated = computeScenarioSuiteHash(suite([...scenarios.slice(7), ...scenarios.slice(0, 7)]));
  assert.equal(backwards, forwards);
  assert.equal(rotated, forwards);
});

test("the hash ignores the key order inside a scenario", () => {
  const original = scenario();
  const reordered = Object.fromEntries(
    Object.entries(original).reverse(),
  ) as unknown as BenchmarkScenario;
  assert.equal(
    computeScenarioSuiteHash(suite([reordered])),
    computeScenarioSuiteHash(suite([original])),
  );
});

test("the hash ignores the line endings a checkout wrote", () => {
  const lf = scenario({ task: "First line.\nSecond line.\n\nThird." });
  const crlf = scenario({ task: "First line.\r\nSecond line.\r\n\r\nThird." });
  const cr = scenario({ task: "First line.\rSecond line.\r\rThird." });
  const expected = computeScenarioSuiteHash(suite([lf]));
  assert.equal(computeScenarioSuiteHash(suite([crlf])), expected);
  assert.equal(computeScenarioSuiteHash(suite([cr])), expected);
});

test("the hash ignores the Unicode normal form of the same text", () => {
  const composed = scenario({ title: "Užblokuota".normalize("NFC") });
  const decomposed = scenario({ title: "Užblokuota".normalize("NFD") });
  assert.equal(
    computeScenarioSuiteHash(suite([decomposed])),
    computeScenarioSuiteHash(suite([composed])),
  );
});

test("the hash changes when any scenario field or the suite version changes", () => {
  const base = suite([scenario()]);
  const baseline = computeScenarioSuiteHash(base);
  assert.notEqual(
    computeScenarioSuiteHash(suite([scenario({ task: "Do the other thing." })])),
    baseline,
  );
  assert.notEqual(
    computeScenarioSuiteHash(suite([scenario({ limits: { timeoutMs: 600_001, tokenLimit: 150_000 } })])),
    baseline,
  );
  assert.notEqual(computeScenarioSuiteHash({ ...base, version: "1.0.1" }), baseline);
});

test("the hash names its algorithm and is a sha256 digest", () => {
  assert.match(computeScenarioSuiteHash(suite([scenario()])), /^sha256:[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

test("assembly joins the manifest with the scenario files", () => {
  const result = assembleScenarioSuite(MANIFEST, documents(coveringScenarios()));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.version, "1.0.0");
});

test("assembly refuses an empty set, a duplicate file and a malformed scenario", () => {
  assert.equal(assembleScenarioSuite(MANIFEST, []).ok, false);

  const twice = documents([scenario()]);
  assert.equal(assembleScenarioSuite(MANIFEST, [...twice, ...twice]).ok, false);

  const malformed = assembleScenarioSuite(MANIFEST, [
    { source: "broken.scenario.json", value: { id: "broken" } },
  ]);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.ok(malformed.problems.some((problem) => problem.code === "missing"), "expected a missing-field problem");
  }
});

test("a manifest problem is reported under the manifest, not under a scenario", () => {
  const result = assembleScenarioSuite({ schemaVersion: 1, version: "oops" }, documents([scenario()]));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.problems.map((problem) => problem.path), ["manifest.version"]);
  }
});

test("problems are reported at positions that do not depend on the read order", () => {
  const scenarios = [scenario({ id: "aaa" }), scenario({ id: "zzz" })];
  const broken: ScenarioDocument[] = [
    { source: "zzz.scenario.json", value: { ...scenarios[1], limits: { timeoutMs: 1, tokenLimit: 1 } } },
    { source: "aaa.scenario.json", value: scenarios[0] },
  ];
  const forwards = assembleScenarioSuite(MANIFEST, broken);
  const backwards = assembleScenarioSuite(MANIFEST, [...broken].reverse());
  assert.equal(forwards.ok, false);
  assert.equal(backwards.ok, false);
  if (!forwards.ok && !backwards.ok) {
    assert.deepEqual(
      backwards.problems.map((problem) => problem.path),
      forwards.problems.map((problem) => problem.path),
    );
    assert.ok(forwards.problems.every((problem) => problem.path.startsWith("scenarios[1]")));
  }
});

// ---------------------------------------------------------------------------
// Suite-level integrity
// ---------------------------------------------------------------------------

test("a complete suite passes every suite-level rule", () => {
  assert.deepEqual(
    checkSuiteIntegrity(suite(coveringScenarios()), {
      availableFixtures: [`${FIXTURE_ROOT}/task-service`],
    }),
    [],
  );
});

test("a suite below the declared minimum is refused", () => {
  const problems = checkSuiteIntegrity(suite([scenario()]));
  assert.ok(
    problems.some((problem) => problem.message.includes(String(SCENARIO_SUITE_MINIMUM_SIZE))),
    JSON.stringify(problems),
  );
});

test("every missing category is named, not just the first", () => {
  const problems = checkSuiteIntegrity(suite([scenario()]));
  const missing = problems.filter((problem) => problem.message.includes("category"));
  assert.equal(missing.length, SCENARIO_CATEGORIES.length - 1);
});

test("a violation scenario expecting acceptance is refused", () => {
  for (const category of REFUSAL_SCENARIO_CATEGORIES) {
    const problems = checkSuiteIntegrity(
      suite([...coveringScenarios(), scenario({ id: "wrong-way-round", category })]),
    );
    assert.ok(
      problems.some((problem) => problem.path.endsWith(".expectedOutcome")),
      `${category} was allowed to expect acceptance`,
    );
  }
});

test("an ordinary scenario expecting rejection is refused", () => {
  const problems = checkSuiteIntegrity(
    suite([...coveringScenarios(), scenario({ id: "never-passes", expectedOutcome: "rejected" })]),
  );
  assert.ok(problems.some((problem) => problem.path.endsWith(".expectedOutcome")));
});

test("a violation scenario must name the paths it may not touch", () => {
  const problems = checkSuiteIntegrity(
    suite([
      ...coveringScenarios(),
      scenario({
        id: "unbounded-refusal",
        category: "security-violation",
        expectedOutcome: "rejected",
        forbiddenPaths: [],
      }),
    ]),
  );
  assert.ok(problems.some((problem) => problem.path.endsWith(".forbiddenPaths")));
});

test("a fixture outside the fixture root or absent from disk is refused", () => {
  const outside = checkSuiteIntegrity(
    suite([...coveringScenarios(), scenario({ id: "stray-fixture", fixture: "src/domain" })]),
  );
  assert.ok(outside.some((problem) => problem.code === "unsafe-path"));

  const absent = checkSuiteIntegrity(suite(coveringScenarios()), { availableFixtures: [] });
  assert.ok(absent.some((problem) => problem.code === "missing"));
});

// ---------------------------------------------------------------------------
// Façade
// ---------------------------------------------------------------------------

test("a valid suite yields a hash and a per-category count", () => {
  const outcome = validateBenchmarkSuite(MANIFEST, documents(coveringScenarios()), {
    availableFixtures: [`${FIXTURE_ROOT}/task-service`],
  });
  assert.deepEqual(outcome.problems, []);
  assert.match(outcome.suiteHash ?? "", /^sha256:/);
  assert.equal(outcome.suite?.scenarios.length, outcome.scenarioCount);
  for (const category of SCENARIO_CATEGORIES) {
    assert.equal(outcome.categoryCoverage[category], 3);
  }
});

test("a refused suite carries no hash and no suite, so nothing can be recorded against it", () => {
  const outcome = validateBenchmarkSuite(MANIFEST, documents([scenario()]));
  assert.ok(outcome.problems.length > 0);
  assert.equal(outcome.suiteHash, undefined);
  assert.equal(outcome.suite, undefined);
});

test("the report form keeps the empty hash and the flattened problems in step", () => {
  const refused = toSuiteValidationReport(validateBenchmarkSuite(MANIFEST, []));
  assert.equal(refused.suiteHash, "");
  assert.equal(refused.scenarioCount, 0);
  assert.ok(refused.problems.every((problem) => problem.includes(": ")));

  const accepted = toSuiteValidationReport(
    validateBenchmarkSuite(MANIFEST, documents(coveringScenarios())),
  );
  assert.deepEqual(accepted.problems, []);
  assert.match(accepted.suiteHash, /^sha256:/);
});
