import assert from "node:assert/strict";
import test from "node:test";

import {
  validateBenchmarkSample,
  validateScenario,
  validateScenarioSuite,
  validateSuiteConfig,
} from "../domain/schema-validation.js";
import { COMPRESSION_COHORT } from "../domain/compression/cohort.js";
import type { CompressionVariant } from "../domain/compression/variant.js";
import {
  BENCHMARK_SAMPLE_SCHEMA_VERSION,
  type BenchmarkSample,
  type SampleCompressionRecord,
  type SampleUsageRecord,
} from "../domain/result.js";
import {
  SCENARIO_SUITE_SCHEMA_VERSION,
  type BenchmarkScenario,
  type ScenarioSuite,
} from "../domain/scenario.js";
import { SUITE_CONFIG_SCHEMA_VERSION, type BenchmarkSuiteConfig } from "../domain/suite-config.js";
import { isSafeRelativePath, type ValidationResult } from "../domain/validation.js";

/**
 * Fail-closed validation gate for BENCH-2 and BENCH-5.
 *
 * Two properties are asserted throughout: a valid document survives the journey
 * it really makes — object, JSON text, object again — unchanged; and every
 * invalid document is refused with a problem naming the field and the reason.
 * The rejection cases are written as data so a new rule is one row, and so a
 * rule that silently stops firing shows up as a failing row rather than as a
 * missing test.
 */

const VALID_SCENARIO: BenchmarkScenario = {
  id: "bugfix-null-guard",
  title: "Fix the null guard in the parser",
  category: "bugfix",
  fixture: "fixtures/bugfix-null-guard",
  task: "The parser throws on empty input. Make it return an empty document instead.",
  allowedPaths: ["src/parser.ts", "src/tests/*"],
  forbiddenPaths: ["src/public-api.ts"],
  checks: [
    { id: "unit", command: ["npm", "test"], expect: "pass" },
    { id: "regression", command: ["npm", "run", "test:regression"], expect: "fail" },
  ],
  expectedOutcome: "accepted",
  limits: { timeoutMs: 600_000, tokenLimit: 200_000 },
  deterministic: false,
};

const VALID_SUITE: ScenarioSuite = {
  schemaVersion: SCENARIO_SUITE_SCHEMA_VERSION,
  version: "1.0.0",
  scenarios: [VALID_SCENARIO],
};

const VALID_CONFIG: BenchmarkSuiteConfig = {
  schemaVersion: SUITE_CONFIG_SCHEMA_VERSION,
  suiteVersion: "1.0.0",
  modes: ["ag-loop", "agent-solo"],
  repetitions: 3,
  modelSettings: { model: "claude-opus-5", temperature: 0, maxOutputTokens: 32_000 },
  limits: { timeoutMs: 900_000, tokenLimit: 1_000_000 },
  modeAdapterVersions: {
    "ag-loop": "1.0.0",
    "agent-solo": "1.0.0",
    "deterministic-control": "1.0.0",
  },
  allowNetworkModels: false,
};

const VALID_SAMPLE: BenchmarkSample = {
  schemaVersion: BENCHMARK_SAMPLE_SCHEMA_VERSION,
  sampleId: "bugfix-null-guard-ag-loop-1",
  scenarioId: "bugfix-null-guard",
  mode: "ag-loop",
  repetition: 1,
  startedAt: "2026-08-06T09:00:00.000Z",
  durationMs: 412_000,
  telemetry: {
    model: "claude-opus-5",
    inputTokens: 120_000,
    outputTokens: 18_000,
    llmCalls: 14,
    attempts: 2,
    repairs: 1,
    humanReviewEvents: 0,
  },
  checks: [
    { id: "unit", kind: "test", status: "passed", durationMs: 21_000 },
    { id: "boundaries", kind: "architecture", status: "passed", durationMs: 4_000 },
  ],
  workspace: {
    startCommit: "0123456789abcdef0123456789abcdef01234567",
    endCommit: "89abcdef0123456789abcdef0123456789abcdef",
    changedFiles: ["src/parser.ts", "src/tests/parser.test.ts"],
    outOfScopeFiles: ["src/tests/parser.test.ts"],
    cleanup: "removed",
  },
  acceptance: {
    verdict: "verified-accepted",
    reasons: [],
    agentClaimedDone: true,
  },
};

const VALID_USAGE: SampleUsageRecord = {
  source: "envelope",
  captured: true,
  cacheReadInputTokens: 41_000,
  cacheCreationInputTokens: 3_000,
  numTurns: 12,
  turnsSource: "recorded",
};

/**
 * A compression record as the runner would write it: the identity computed by
 * the domain, never a digest typed by hand, so a case that changes the features
 * changes the record the way a real writer would.
 */
function validCompression(
  variant: CompressionVariant = COMPRESSION_COHORT[4] as CompressionVariant,
): SampleCompressionRecord {
  return {
    variantId: variant.id,
    variantIdentity: variant.identity,
    features: variant.features,
    hookProfile: variant.hookProfile,
    diagnostics: { rawTaskChars: 8_200, compiledTaskChars: 2_100, workerPromptChars: 3_400 },
  };
}

/** The journey a document really makes: authored or produced, written as JSON, read back. */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** A mutable deep copy, so a case can delete or replace any field without touching the fixture. */
function copyOf<T>(value: T): Record<string, unknown> {
  return roundTrip(value) as Record<string, unknown>;
}

function assertOk<T>(result: ValidationResult<T>): T {
  assert.ok(
    result.ok,
    result.ok ? "" : `expected a valid document, got: ${JSON.stringify(result.problems)}`,
  );
  return result.value;
}

interface RejectionCase {
  readonly name: string;
  /** Mutates a deep copy of the valid document into the invalid one under test. */
  readonly corrupt: (document: Record<string, unknown>) => unknown;
  readonly code: string;
  /** Substring the reported problem path must contain, so a rule cannot pass by firing elsewhere. */
  readonly path: string;
}

function runRejectionCases<T>(
  cases: readonly RejectionCase[],
  validDocument: unknown,
  validate: (input: unknown) => ValidationResult<T>,
): void {
  for (const rejection of cases) {
    test(`rejects ${rejection.name}`, () => {
      const result = validate(rejection.corrupt(copyOf(validDocument)));
      assert.equal(result.ok, false, "expected the document to be rejected");
      if (result.ok) return;
      const matching = result.problems.filter(
        (problem) => problem.code === rejection.code && problem.path.includes(rejection.path),
      );
      assert.ok(
        matching.length > 0,
        `expected a "${rejection.code}" problem at "${rejection.path}", got: ${JSON.stringify(result.problems)}`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Round-trips
// ---------------------------------------------------------------------------

test("a valid scenario round-trips through JSON unchanged", () => {
  assert.deepStrictEqual(assertOk(validateScenario(roundTrip(VALID_SCENARIO))), VALID_SCENARIO);
});

test("a valid suite round-trips through JSON unchanged", () => {
  assert.deepStrictEqual(assertOk(validateScenarioSuite(roundTrip(VALID_SUITE))), VALID_SUITE);
});

test("a valid config round-trips through JSON unchanged", () => {
  assert.deepStrictEqual(assertOk(validateSuiteConfig(roundTrip(VALID_CONFIG))), VALID_CONFIG);
});

test("a valid run result round-trips through JSON unchanged", () => {
  assert.deepStrictEqual(assertOk(validateBenchmarkSample(roundTrip(VALID_SAMPLE))), VALID_SAMPLE);
});

test("optional model settings stay absent rather than becoming defaults", () => {
  const minimal = { ...VALID_CONFIG, modelSettings: { model: "claude-opus-5" } };
  const validated = assertOk(validateSuiteConfig(roundTrip(minimal)));
  assert.deepStrictEqual(validated.modelSettings, { model: "claude-opus-5" });
  assert.ok(!Object.hasOwn(validated.modelSettings, "temperature"));
});

test("a rejected verdict round-trips with its reason codes", () => {
  const rejected = {
    ...VALID_SAMPLE,
    acceptance: {
      verdict: "rejected",
      reasons: ["check-failed", "out-of-scope-change"],
      agentClaimedDone: true,
    },
  };
  assert.deepStrictEqual(assertOk(validateBenchmarkSample(roundTrip(rejected))), rejected);
});

// ---------------------------------------------------------------------------
// Non-documents
// ---------------------------------------------------------------------------

test("every validator refuses values that are not objects", () => {
  const validators = [
    validateScenario,
    validateScenarioSuite,
    validateSuiteConfig,
    validateBenchmarkSample,
  ] as const;
  for (const validate of validators) {
    for (const input of [null, undefined, [], "{}", 42, true]) {
      const result = validate(input);
      assert.equal(result.ok, false, `expected ${JSON.stringify(input) ?? "undefined"} to be refused`);
      if (!result.ok) {
        assert.ok(result.problems.length > 0, "a refusal always carries at least one problem");
      }
    }
  }
});

test("an empty suite is refused rather than reported as zero scenarios", () => {
  const result = validateScenarioSuite({ ...VALID_SUITE, scenarios: [] });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

const UNSAFE_PATHS = [
  "/etc/passwd",
  "../secrets.env",
  "src/../../outside.ts",
  "..",
  "C:/Windows/System32",
  "c:\\Windows",
  "\\\\server\\share",
  "src\\parser.ts",
  "src//parser.ts",
  "./src/parser.ts",
  "src/./parser.ts",
  "src/parser.ts/",
  " src/parser.ts",
  "",
];

test("unsafe paths are refused by the path predicate", () => {
  for (const unsafe of UNSAFE_PATHS) {
    assert.equal(isSafeRelativePath(unsafe), false, `expected "${unsafe}" to be unsafe`);
  }
  for (const safe of ["src/parser.ts", "fixtures/a-b/c.ts", "src/tests/*", "a"]) {
    assert.equal(isSafeRelativePath(safe), true, `expected "${safe}" to be safe`);
  }
});

test("a scenario fixture pointing outside the workspace is refused", () => {
  for (const unsafe of UNSAFE_PATHS) {
    const result = validateScenario({ ...VALID_SCENARIO, fixture: unsafe });
    assert.equal(result.ok, false, `expected fixture "${unsafe}" to be refused`);
  }
});

test("an unsafe path anywhere in a list is refused", () => {
  for (const field of ["allowedPaths", "forbiddenPaths"] as const) {
    const result = validateScenario({ ...VALID_SCENARIO, [field]: ["src/ok.ts", "../escape.ts"] });
    assert.equal(result.ok, false, `expected an unsafe ${field} entry to be refused`);
  }
  const changed = validateBenchmarkSample({
    ...VALID_SAMPLE,
    workspace: { ...VALID_SAMPLE.workspace, changedFiles: ["../escape.ts"], outOfScopeFiles: [] },
  });
  assert.equal(changed.ok, false);
});

// ---------------------------------------------------------------------------
// Incomplete documents
// ---------------------------------------------------------------------------

test("a scenario missing any required field is refused", () => {
  for (const field of Object.keys(copyOf(VALID_SCENARIO))) {
    const document = copyOf(VALID_SCENARIO);
    delete document[field];
    const result = validateScenario(document);
    assert.equal(result.ok, false, `expected a scenario without "${field}" to be refused`);
    if (!result.ok) {
      assert.ok(
        result.problems.some(
          (problem) => problem.code === "missing" && problem.path.includes(field),
        ),
        `expected a "missing" problem for "${field}"`,
      );
    }
  }
});

test("a run result missing any required field is refused", () => {
  for (const field of Object.keys(copyOf(VALID_SAMPLE))) {
    const document = copyOf(VALID_SAMPLE);
    delete document[field];
    assert.equal(
      validateBenchmarkSample(document).ok,
      false,
      `expected a sample without "${field}" to be refused`,
    );
  }
});

test("a config missing any required field is refused", () => {
  for (const field of Object.keys(copyOf(VALID_CONFIG))) {
    const document = copyOf(VALID_CONFIG);
    delete document[field];
    assert.equal(
      validateSuiteConfig(document).ok,
      false,
      `expected a config without "${field}" to be refused`,
    );
  }
});

test("a nested object missing one field is refused", () => {
  const withoutTokenLimit = copyOf(VALID_SCENARIO);
  delete (withoutTokenLimit["limits"] as Record<string, unknown>)["tokenLimit"];
  const result = validateScenario(withoutTokenLimit);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.problems.some((problem) => problem.path === "limits.tokenLimit"));
  }
});

// ---------------------------------------------------------------------------
// Scenario rules
// ---------------------------------------------------------------------------

runRejectionCases(
  [
    {
      name: "an unknown scenario category",
      corrupt: (document) => ({ ...document, category: "performance" }),
      code: "unknown-enum-value",
      path: "category",
    },
    {
      name: "an unknown expected outcome",
      corrupt: (document) => ({ ...document, expectedOutcome: "maybe" }),
      code: "unknown-enum-value",
      path: "expectedOutcome",
    },
    {
      name: "an unknown check expectation",
      corrupt: (document) => ({
        ...document,
        checks: [{ id: "unit", command: ["npm", "test"], expect: "flaky" }],
      }),
      code: "unknown-enum-value",
      path: "checks[0].expect",
    },
    {
      name: "a field this schema version does not define",
      corrupt: (document) => ({ ...document, retries: 3 }),
      code: "unknown-field",
      path: "retries",
    },
    {
      name: "an id that is not kebab-case",
      corrupt: (document) => ({ ...document, id: "Bugfix Null Guard" }),
      code: "malformed",
      path: "id",
    },
    {
      name: "an id padded with whitespace",
      corrupt: (document) => ({ ...document, id: " bugfix-null-guard" }),
      code: "malformed",
      path: "id",
    },
    {
      name: "an empty title",
      corrupt: (document) => ({ ...document, title: "   " }),
      code: "empty",
      path: "title",
    },
    {
      name: "a scenario with no checks",
      corrupt: (document) => ({ ...document, checks: [] }),
      code: "empty",
      path: "checks",
    },
    {
      name: "a scenario with no allowed paths",
      corrupt: (document) => ({ ...document, allowedPaths: [] }),
      code: "empty",
      path: "allowedPaths",
    },
    {
      name: "a check whose command is an empty argument vector",
      corrupt: (document) => ({
        ...document,
        checks: [{ id: "unit", command: [], expect: "pass" }],
      }),
      code: "empty",
      path: "checks[0].command",
    },
    {
      name: "a check command given as a shell string",
      corrupt: (document) => ({
        ...document,
        checks: [{ id: "unit", command: "npm test && rm -rf /", expect: "pass" }],
      }),
      code: "wrong-type",
      path: "checks[0].command",
    },
    {
      name: "duplicate check ids",
      corrupt: (document) => ({
        ...document,
        checks: [
          { id: "unit", command: ["npm", "test"], expect: "pass" },
          { id: "unit", command: ["npm", "run", "other"], expect: "pass" },
        ],
      }),
      code: "duplicate",
      path: "checks",
    },
    {
      name: "a path declared both allowed and forbidden",
      corrupt: (document) => ({
        ...document,
        allowedPaths: ["src/parser.ts"],
        forbiddenPaths: ["src/parser.ts"],
      }),
      code: "inconsistent",
      path: "forbiddenPaths",
    },
    {
      name: "a timeout of zero",
      corrupt: (document) => ({ ...document, limits: { timeoutMs: 0, tokenLimit: 200_000 } }),
      code: "out-of-range",
      path: "limits.timeoutMs",
    },
    {
      name: "a negative timeout",
      corrupt: (document) => ({ ...document, limits: { timeoutMs: -1, tokenLimit: 200_000 } }),
      code: "out-of-range",
      path: "limits.timeoutMs",
    },
    {
      name: "a timeout beyond the declared ceiling",
      corrupt: (document) => ({
        ...document,
        limits: { timeoutMs: 86_400_000, tokenLimit: 200_000 },
      }),
      code: "out-of-range",
      path: "limits.timeoutMs",
    },
    {
      name: "a fractional timeout",
      corrupt: (document) => ({ ...document, limits: { timeoutMs: 1500.5, tokenLimit: 200_000 } }),
      code: "not-an-integer",
      path: "limits.timeoutMs",
    },
    {
      name: "a token limit beyond the declared ceiling",
      corrupt: (document) => ({
        ...document,
        limits: { timeoutMs: 600_000, tokenLimit: 999_000_000 },
      }),
      code: "out-of-range",
      path: "limits.tokenLimit",
    },
    {
      name: "a token limit given as a string",
      corrupt: (document) => ({ ...document, limits: { timeoutMs: 600_000, tokenLimit: "200000" } }),
      code: "wrong-type",
      path: "limits.tokenLimit",
    },
    {
      name: "a non-boolean determinism flag",
      corrupt: (document) => ({ ...document, deterministic: "false" }),
      code: "wrong-type",
      path: "deterministic",
    },
    {
      name: "limits given as a non-object",
      corrupt: (document) => ({ ...document, limits: 600_000 }),
      code: "wrong-type",
      path: "limits",
    },
  ],
  VALID_SCENARIO,
  validateScenario,
);

// ---------------------------------------------------------------------------
// Suite rules
// ---------------------------------------------------------------------------

runRejectionCases(
  [
    {
      name: "a suite written under a newer schema version",
      corrupt: (document) => ({ ...document, schemaVersion: SCENARIO_SUITE_SCHEMA_VERSION + 1 }),
      code: "unsupported-schema-version",
      path: "schemaVersion",
    },
    {
      name: "a schema version given as a string",
      corrupt: (document) => ({ ...document, schemaVersion: "1" }),
      code: "unsupported-schema-version",
      path: "schemaVersion",
    },
    {
      name: "a suite version that is not semantic",
      corrupt: (document) => ({ ...document, version: "v1" }),
      code: "malformed",
      path: "version",
    },
    {
      name: "duplicate scenario ids",
      corrupt: (document) => ({
        ...document,
        scenarios: [copyOf(VALID_SCENARIO), copyOf(VALID_SCENARIO)],
      }),
      code: "duplicate",
      path: "scenarios",
    },
    {
      name: "a suite whose nested scenario is invalid",
      corrupt: (document) => ({
        ...document,
        scenarios: [{ ...copyOf(VALID_SCENARIO), category: "unknown" }],
      }),
      code: "unknown-enum-value",
      path: "scenarios[0].category",
    },
  ],
  VALID_SUITE,
  validateScenarioSuite,
);

// ---------------------------------------------------------------------------
// Config rules
// ---------------------------------------------------------------------------

runRejectionCases(
  [
    {
      name: "a config written under an unknown schema version",
      corrupt: (document) => ({ ...document, schemaVersion: 99 }),
      code: "unsupported-schema-version",
      path: "schemaVersion",
    },
    {
      name: "an unknown execution mode",
      corrupt: (document) => ({ ...document, modes: ["ag-loop", "turbo"] }),
      code: "unknown-enum-value",
      path: "modes[1]",
    },
    {
      name: "a repeated execution mode",
      corrupt: (document) => ({ ...document, modes: ["ag-loop", "ag-loop"] }),
      code: "duplicate",
      path: "modes",
    },
    {
      name: "an empty mode list",
      corrupt: (document) => ({ ...document, modes: [] }),
      code: "empty",
      path: "modes",
    },
    {
      name: "zero repetitions",
      corrupt: (document) => ({ ...document, repetitions: 0 }),
      code: "out-of-range",
      path: "repetitions",
    },
    {
      name: "an adapter version missing for one mode",
      corrupt: (document) => ({
        ...document,
        modeAdapterVersions: { "ag-loop": "1.0.0", "agent-solo": "1.0.0" },
      }),
      code: "missing",
      path: "modeAdapterVersions.deterministic-control",
    },
    {
      name: "an adapter version for a mode this version does not know",
      corrupt: (document) => ({
        ...document,
        modeAdapterVersions: { ...copyOf(VALID_CONFIG["modeAdapterVersions"]), turbo: "1.0.0" },
      }),
      code: "unknown-field",
      path: "modeAdapterVersions.turbo",
    },
    {
      name: "a temperature outside the accepted range",
      corrupt: (document) => ({
        ...document,
        modelSettings: { model: "claude-opus-5", temperature: 7 },
      }),
      code: "out-of-range",
      path: "modelSettings.temperature",
    },
    {
      name: "an empty model name",
      corrupt: (document) => ({ ...document, modelSettings: { model: "" } }),
      code: "empty",
      path: "modelSettings.model",
    },
    {
      name: "a network permission given as a string",
      corrupt: (document) => ({ ...document, allowNetworkModels: "false" }),
      code: "wrong-type",
      path: "allowNetworkModels",
    },
  ],
  VALID_CONFIG,
  validateSuiteConfig,
);

// ---------------------------------------------------------------------------
// Run result rules
// ---------------------------------------------------------------------------

runRejectionCases(
  [
    {
      name: "a run result written under an unknown schema version",
      corrupt: (document) => ({
        ...document,
        schemaVersion: BENCHMARK_SAMPLE_SCHEMA_VERSION + 1,
      }),
      code: "unsupported-schema-version",
      path: "schemaVersion",
    },
    {
      name: "a version-1 record carrying a block version 2 introduced",
      corrupt: (document) => ({ ...document, schemaVersion: 1, usage: VALID_USAGE }),
      code: "inconsistent",
      path: "usage",
    },
    {
      name: "a version-1 record carrying a compression block",
      corrupt: (document) => ({ ...document, schemaVersion: 1, compression: validCompression() }),
      code: "inconsistent",
      path: "compression",
    },
    {
      name: "a usage record naming a source this version does not know",
      corrupt: (document) => ({ ...document, usage: { ...VALID_USAGE, source: "guesswork" } }),
      code: "unknown-enum-value",
      path: "usage.source",
    },
    {
      name: "a usage field this schema version does not define",
      corrupt: (document) => ({ ...document, usage: { ...VALID_USAGE, costUsd: 1 } }),
      code: "unknown-field",
      path: "usage.costUsd",
    },
    {
      name: "a token count reported by a record that says usage was never captured",
      corrupt: (document) => ({
        ...document,
        usage: { source: "envelope", captured: false, cacheReadInputTokens: 10 },
      }),
      code: "inconsistent",
      path: "usage.cacheReadInputTokens",
    },
    {
      name: "a turn count whose source was not recorded",
      corrupt: (document) => ({
        ...document,
        usage: { source: "envelope", captured: true, numTurns: 4 },
      }),
      code: "inconsistent",
      path: "usage.turnsSource",
    },
    {
      name: "a negative cache token count",
      corrupt: (document) => ({
        ...document,
        usage: { ...VALID_USAGE, cacheReadInputTokens: -1 },
      }),
      code: "out-of-range",
      path: "usage.cacheReadInputTokens",
    },
    {
      name: "a compression record naming a flag this registry version does not have",
      corrupt: (document) => ({
        ...document,
        compression: { ...validCompression(), features: ["telepathy"] },
      }),
      code: "malformed",
      path: "compression.features[0]",
    },
    {
      name: "a compression record enabling one flag twice",
      corrupt: (document) => ({
        ...document,
        compression: { ...validCompression(), features: ["compact_dsl", "compact_dsl"] },
      }),
      code: "duplicate",
      path: "compression.features",
    },
    {
      name: "a compression record naming an unknown hook profile",
      corrupt: (document) => ({
        ...document,
        compression: { ...validCompression(), hookProfile: "handwired" },
      }),
      code: "unknown-enum-value",
      path: "compression.hookProfile",
    },
    {
      name: "a variant identity that is not a canonical digest",
      corrupt: (document) => ({
        ...document,
        compression: { ...validCompression(), variantIdentity: "sha256:short" },
      }),
      code: "malformed",
      path: "compression.variantIdentity",
    },
    {
      name: "a compression field this schema version does not define",
      corrupt: (document) => ({
        ...document,
        compression: { ...validCompression(), promptChars: 10 },
      }),
      code: "unknown-field",
      path: "compression.promptChars",
    },
    {
      name: "a fractional character counter",
      corrupt: (document) => ({
        ...document,
        compression: { ...validCompression(), diagnostics: { rawTaskChars: 10.5 } },
      }),
      code: "not-an-integer",
      path: "compression.diagnostics.rawTaskChars",
    },
    {
      name: "a negative character counter",
      corrupt: (document) => ({
        ...document,
        compression: { ...validCompression(), diagnostics: { toolDigestChars: -1 } },
      }),
      code: "out-of-range",
      path: "compression.diagnostics.toolDigestChars",
    },
    {
      name: "a diagnostics field this schema version does not define",
      corrupt: (document) => ({
        ...document,
        compression: { ...validCompression(), diagnostics: { totalChars: 10 } },
      }),
      code: "unknown-field",
      path: "compression.diagnostics.totalChars",
    },
    {
      name: "an unknown execution mode",
      corrupt: (document) => ({ ...document, mode: "vibes" }),
      code: "unknown-enum-value",
      path: "mode",
    },
    {
      name: "an unknown acceptance verdict",
      corrupt: (document) => ({
        ...document,
        acceptance: { verdict: "probably-fine", reasons: [], agentClaimedDone: true },
      }),
      code: "unknown-enum-value",
      path: "acceptance.verdict",
    },
    {
      name: "an unknown cleanup result",
      corrupt: (document) => ({
        ...document,
        workspace: { ...copyOf(VALID_SAMPLE["workspace"]), cleanup: "nuked" },
      }),
      code: "unknown-enum-value",
      path: "workspace.cleanup",
    },
    {
      name: "an unknown check status",
      corrupt: (document) => ({
        ...document,
        checks: [{ id: "unit", kind: "test", status: "flaky", durationMs: 10 }],
      }),
      code: "unknown-enum-value",
      path: "checks[0].status",
    },
    {
      name: "an abbreviated commit id",
      corrupt: (document) => ({
        ...document,
        workspace: { ...copyOf(VALID_SAMPLE["workspace"]), startCommit: "0123456" },
      }),
      code: "malformed",
      path: "workspace.startCommit",
    },
    {
      name: "a commit id that is not hexadecimal",
      corrupt: (document) => ({
        ...document,
        workspace: {
          ...copyOf(VALID_SAMPLE["workspace"]),
          endCommit: "zzzzzzzz89abcdef0123456789abcdef01234567",
        },
      }),
      code: "malformed",
      path: "workspace.endCommit",
    },
    {
      name: "a timestamp without a timezone",
      corrupt: (document) => ({ ...document, startedAt: "2026-08-06 09:00:00" }),
      code: "malformed",
      path: "startedAt",
    },
    {
      name: "a timestamp naming a date that does not exist",
      corrupt: (document) => ({ ...document, startedAt: "2026-13-45T09:00:00.000Z" }),
      code: "malformed",
      path: "startedAt",
    },
    {
      name: "a negative duration",
      corrupt: (document) => ({ ...document, durationMs: -1 }),
      code: "out-of-range",
      path: "durationMs",
    },
    {
      name: "a repetition counted from zero",
      corrupt: (document) => ({ ...document, repetition: 0 }),
      code: "out-of-range",
      path: "repetition",
    },
    {
      name: "negative token counts",
      corrupt: (document) => ({
        ...document,
        telemetry: { ...copyOf(VALID_SAMPLE["telemetry"]), inputTokens: -5 },
      }),
      code: "out-of-range",
      path: "telemetry.inputTokens",
    },
    {
      name: "a fractional LLM call count",
      corrupt: (document) => ({
        ...document,
        telemetry: { ...copyOf(VALID_SAMPLE["telemetry"]), llmCalls: 1.5 },
      }),
      code: "not-an-integer",
      path: "telemetry.llmCalls",
    },
    {
      name: "a sample reporting no attempt at all",
      corrupt: (document) => ({
        ...document,
        telemetry: { ...copyOf(VALID_SAMPLE["telemetry"]), attempts: 0, repairs: 0 },
      }),
      code: "out-of-range",
      path: "telemetry.attempts",
    },
    {
      name: "tokens reported without a single LLM call",
      corrupt: (document) => ({
        ...document,
        telemetry: { ...copyOf(VALID_SAMPLE["telemetry"]), llmCalls: 0 },
      }),
      code: "inconsistent",
      path: "telemetry",
    },
    {
      name: "more repairs than attempts",
      corrupt: (document) => ({
        ...document,
        telemetry: { ...copyOf(VALID_SAMPLE["telemetry"]), attempts: 2, repairs: 2 },
      }),
      code: "inconsistent",
      path: "telemetry.repairs",
    },
    {
      name: "a deterministic control sample reporting model cost",
      corrupt: (document) => ({ ...document, mode: "deterministic-control" }),
      code: "inconsistent",
      path: "telemetry",
    },
    {
      name: "an out-of-scope file that was never changed",
      corrupt: (document) => ({
        ...document,
        workspace: {
          ...copyOf(VALID_SAMPLE["workspace"]),
          outOfScopeFiles: ["src/never-touched.ts"],
        },
      }),
      code: "inconsistent",
      path: "workspace.outOfScopeFiles",
    },
    {
      name: "a rejection carrying no reason",
      corrupt: (document) => ({
        ...document,
        acceptance: { verdict: "rejected", reasons: [], agentClaimedDone: true },
      }),
      code: "empty",
      path: "acceptance.reasons",
    },
    {
      name: "an inconclusive verdict carrying no reason",
      corrupt: (document) => ({
        ...document,
        acceptance: { verdict: "inconclusive", reasons: [], agentClaimedDone: false },
      }),
      code: "empty",
      path: "acceptance.reasons",
    },
    {
      name: "a reason written as prose instead of a code",
      corrupt: (document) => ({
        ...document,
        acceptance: {
          verdict: "rejected",
          reasons: ["The agent gave up halfway."],
          agentClaimedDone: false,
        },
      }),
      code: "malformed",
      path: "acceptance.reasons[0]",
    },
    {
      name: "duplicate check results",
      corrupt: (document) => ({
        ...document,
        checks: [
          { id: "unit", kind: "test", status: "passed", durationMs: 10 },
          { id: "unit", kind: "test", status: "failed", durationMs: 10 },
        ],
      }),
      code: "duplicate",
      path: "checks",
    },
    {
      name: "a field this schema version does not define",
      corrupt: (document) => ({ ...document, costUsd: 1.23 }),
      code: "unknown-field",
      path: "costUsd",
    },
    {
      name: "telemetry given as a non-object",
      corrupt: (document) => ({ ...document, telemetry: null }),
      code: "wrong-type",
      path: "telemetry",
    },
  ],
  VALID_SAMPLE,
  validateBenchmarkSample,
);

test("a version-2 sample carries its usage and compression blocks through JSON unchanged", () => {
  const measured = { ...VALID_SAMPLE, usage: VALID_USAGE, compression: validCompression() };
  assert.deepStrictEqual(assertOk(validateBenchmarkSample(roundTrip(measured))), measured);
});

test("a sample that reports no compression and no usage is still a valid version-2 sample", () => {
  const validated = assertOk(validateBenchmarkSample(roundTrip(VALID_SAMPLE)));
  assert.ok(!Object.hasOwn(validated, "usage"), "an absent block must not become an empty one");
  assert.ok(!Object.hasOwn(validated, "compression"));
});

test("a version-1 sample stays readable, because a ledger cannot be rewritten", () => {
  const legacy = { ...VALID_SAMPLE, schemaVersion: 1 };
  assert.deepStrictEqual(assertOk(validateBenchmarkSample(roundTrip(legacy))), legacy);
});

test("a record that says accounting failed is valid, and carries no count", () => {
  const uncaptured = {
    ...VALID_SAMPLE,
    usage: { source: "run-log", captured: false } as SampleUsageRecord,
  };
  assert.deepStrictEqual(assertOk(validateBenchmarkSample(roundTrip(uncaptured))), uncaptured);
});

test("a config declaring a compression cohort computes each variant's identity itself", () => {
  const declared = COMPRESSION_COHORT[1] as CompressionVariant;
  const validated = assertOk(
    validateSuiteConfig(
      roundTrip({
        ...VALID_CONFIG,
        compressionCohort: [
          { id: declared.id, features: [...declared.features], hookProfile: declared.hookProfile },
        ],
      }),
    ),
  );
  assert.deepStrictEqual(validated.compressionCohort, [declared]);
});

test("a config declaring the same variant twice is refused", () => {
  const declared = COMPRESSION_COHORT[1] as CompressionVariant;
  const entry = {
    id: declared.id,
    features: [...declared.features],
    hookProfile: declared.hookProfile,
  };
  const result = validateSuiteConfig({ ...VALID_CONFIG, compressionCohort: [entry, entry] });
  assert.equal(result.ok, false);
});

test("a deterministic control sample without model cost is accepted", () => {
  const control = {
    ...VALID_SAMPLE,
    sampleId: "bugfix-null-guard-control-1",
    mode: "deterministic-control",
    telemetry: {
      model: "none",
      inputTokens: 0,
      outputTokens: 0,
      llmCalls: 0,
      attempts: 1,
      repairs: 0,
      humanReviewEvents: 0,
    },
  };
  assert.deepStrictEqual(assertOk(validateBenchmarkSample(roundTrip(control))), control);
});

test("every problem names both a location and a machine-readable code", () => {
  const result = validateBenchmarkSample({ ...VALID_SAMPLE, mode: "vibes", durationMs: -1 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.length >= 2, "each independent problem is reported, not just the first");
  for (const problem of result.problems) {
    assert.ok(problem.code.length > 0);
    assert.ok(problem.path.length > 0);
    assert.ok(problem.message.length > 0);
  }
});
