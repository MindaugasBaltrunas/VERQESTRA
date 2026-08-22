import { CANONICAL_DIGEST_PATTERN } from "./baseline/canonical-json.js";
import {
  COMPRESSION_FEATURES,
  COMPRESSION_HOOK_PROFILES,
  type CompressionFeature,
} from "./compression/features.js";
import {
  defineCompressionVariant,
  type CompressionVariant,
} from "./compression/variant.js";
import {
  ACCEPTANCE_VERDICTS,
  BENCHMARK_SAMPLE_SCHEMA_VERSION,
  CHECK_KINDS,
  CHECK_STATUSES,
  EXECUTION_MODES,
  SUPPORTED_BENCHMARK_SAMPLE_SCHEMA_VERSIONS,
  TURNS_SOURCES,
  USAGE_SOURCES,
  WORKTREE_CLEANUP_RESULTS,
  type AcceptanceDecision,
  type BenchmarkSample,
  type CheckResult,
  type ExecutionMode,
  type SampleCompressionDiagnostics,
  type SampleCompressionRecord,
  type SampleTelemetry,
  type SampleUsageRecord,
  type SampleWorkspaceRecord,
} from "./result.js";
import {
  SCENARIO_CATEGORIES,
  SCENARIO_CHECK_EXPECTATIONS,
  SCENARIO_EXPECTED_OUTCOMES,
  SCENARIO_SUITE_SCHEMA_VERSION,
  SCENARIO_TIMEOUT_MS_BOUNDS,
  SCENARIO_TOKEN_LIMIT_BOUNDS,
  type BenchmarkScenario,
  type ScenarioCheck,
  type ScenarioLimits,
  type ScenarioSuite,
} from "./scenario.js";
import {
  MODEL_TEMPERATURE_BOUNDS,
  SUITE_CONFIG_REPETITION_BOUNDS,
  SUITE_CONFIG_SCHEMA_VERSION,
  type BenchmarkSuiteConfig,
} from "./suite-config.js";
import type { ModelSettings } from "./baseline.js";
import {
  ValidationProblems,
  findDuplicates,
  joinPath,
  readBoolean,
  readEnum,
  readInteger,
  readList,
  readMatching,
  readNumber,
  readRecord,
  readSafePath,
  readSafePathList,
  readSchemaVersion,
  readSchemaVersionIn,
  readString,
  readStringList,
  toValidationResult,
  IDENTIFIER_PATTERN,
  type ValidationResult,
} from "./validation.js";

/**
 * Schema validation for the three documents the benchmark reads from outside
 * itself: the scenario suite it measures, the configuration it measures under,
 * and the run results it later computes metrics from (BENCH-2, BENCH-5).
 *
 * Each validator is total over `unknown` and fail-closed — see `validation.ts`
 * for why nothing is repaired or ignored. Beyond per-field checks, each document
 * is also checked for the contradictions a per-field pass cannot see: a scenario
 * whose scope is both allowed and forbidden, a config whose modes have no
 * adapter, a sample reporting tokens no model call could have produced. Those
 * records are not merely unusual; they are evidence that whatever wrote them was
 * wrong, and a metric drawn from them would be wrong in the same way.
 */

/** Lowercase kebab-case. Ids key stored samples and report rows, so case and spacing cannot be free. */
const IDENTIFIER = IDENTIFIER_PATTERN;

const SEMANTIC_VERSION = /^\d+\.\d+\.\d+$/;

/** A full Git object id, SHA-1 or SHA-256. Abbreviations are refused: they are not stable identifiers. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** ISO-8601 in UTC. A local-time stamp cannot be ordered against one from another machine. */
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const KEBAB_CASE = { test: IDENTIFIER, expectation: "a lowercase kebab-case identifier" } as const;

/** Counts and durations: never negative, never beyond exact integer arithmetic. */
const COUNT_BOUNDS = { min: 0, max: Number.MAX_SAFE_INTEGER } as const;
const ATTEMPT_BOUNDS = { min: 1, max: Number.MAX_SAFE_INTEGER } as const;

/**
 * Reads a required nested object and its allowed keys in one step, returning the
 * path so problems inside it are reported at their real location.
 */
function readNested(
  source: Record<string, unknown>,
  key: string,
  at: string,
  allowedKeys: readonly string[],
  problems: ValidationProblems,
): { readonly record: Record<string, unknown>; readonly path: string } | undefined {
  const path = joinPath(at, key);
  if (!Object.hasOwn(source, key)) {
    problems.add(path, "missing", "required field is missing");
    return undefined;
  }
  const record = readRecord(source[key], path, allowedKeys, problems);
  return record === undefined ? undefined : { record, path };
}

function readTimestamp(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
): string | undefined {
  const value = readMatching(
    source,
    key,
    at,
    problems,
    UTC_TIMESTAMP,
    "an ISO-8601 UTC timestamp like 2026-08-06T09:00:00.000Z",
  );
  if (value === undefined) return undefined;
  // The pattern admits `2026-13-45T99:00:00Z`; only parsing rejects it.
  if (Number.isNaN(Date.parse(value))) {
    problems.add(joinPath(at, key), "malformed", `"${value}" is not a real date and time`);
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Scenario suite (BENCH-2)
// ---------------------------------------------------------------------------

const SCENARIO_CHECK_KEYS = ["id", "command", "expect"] as const;
const SCENARIO_LIMITS_KEYS = ["timeoutMs", "tokenLimit"] as const;
const SCENARIO_KEYS = [
  "id",
  "title",
  "category",
  "fixture",
  "task",
  "allowedPaths",
  "forbiddenPaths",
  "checks",
  "expectedOutcome",
  "limits",
  "deterministic",
] as const;
const SCENARIO_SUITE_KEYS = ["schemaVersion", "version", "scenarios"] as const;

function readScenarioCheck(
  value: unknown,
  at: string,
  problems: ValidationProblems,
): ScenarioCheck | undefined {
  const record = readRecord(value, at, SCENARIO_CHECK_KEYS, problems);
  if (record === undefined) return undefined;
  const id = readMatching(record, "id", at, problems, IDENTIFIER, KEBAB_CASE.expectation);
  const command = readStringList(record, "command", at, problems, 1);
  const expect = readEnum(record, "expect", at, problems, SCENARIO_CHECK_EXPECTATIONS);
  if (id === undefined || command === undefined || expect === undefined) return undefined;
  return { id, command, expect };
}

function readScenarioLimits(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): ScenarioLimits | undefined {
  const nested = readNested(source, "limits", at, SCENARIO_LIMITS_KEYS, problems);
  if (nested === undefined) return undefined;
  const timeoutMs = readInteger(
    nested.record,
    "timeoutMs",
    nested.path,
    problems,
    SCENARIO_TIMEOUT_MS_BOUNDS,
  );
  const tokenLimit = readInteger(
    nested.record,
    "tokenLimit",
    nested.path,
    problems,
    SCENARIO_TOKEN_LIMIT_BOUNDS,
  );
  if (timeoutMs === undefined || tokenLimit === undefined) return undefined;
  return { timeoutMs, tokenLimit };
}

function readScenario(
  value: unknown,
  at: string,
  problems: ValidationProblems,
): BenchmarkScenario | undefined {
  const record = readRecord(value, at, SCENARIO_KEYS, problems);
  if (record === undefined) return undefined;

  const id = readMatching(record, "id", at, problems, IDENTIFIER, KEBAB_CASE.expectation);
  const title = readString(record, "title", at, problems);
  const category = readEnum(record, "category", at, problems, SCENARIO_CATEGORIES);
  const fixture = readSafePath(record, "fixture", at, problems);
  const task = readString(record, "task", at, problems);
  const allowedPaths = readSafePathList(record, "allowedPaths", at, problems, 1);
  const forbiddenPaths = readSafePathList(record, "forbiddenPaths", at, problems, 0);
  const checks = readList(record, "checks", at, problems, 1, (element, elementPath) =>
    readScenarioCheck(element, elementPath, problems),
  );
  const expectedOutcome = readEnum(
    record,
    "expectedOutcome",
    at,
    problems,
    SCENARIO_EXPECTED_OUTCOMES,
  );
  const limits = readScenarioLimits(record, at, problems);
  const deterministic = readBoolean(record, "deterministic", at, problems);

  if (checks !== undefined) {
    for (const duplicate of findDuplicates(checks.map((check) => check.id))) {
      problems.add(
        joinPath(at, "checks"),
        "duplicate",
        `check id "${duplicate}" is declared more than once; results are keyed by it`,
      );
    }
  }
  if (allowedPaths !== undefined && forbiddenPaths !== undefined) {
    for (const contradictory of allowedPaths.filter((path) => forbiddenPaths.includes(path))) {
      problems.add(
        joinPath(at, "forbiddenPaths"),
        "inconsistent",
        `"${contradictory}" is declared both allowed and forbidden, leaving scope undecidable`,
      );
    }
  }

  if (
    id === undefined ||
    title === undefined ||
    category === undefined ||
    fixture === undefined ||
    task === undefined ||
    allowedPaths === undefined ||
    forbiddenPaths === undefined ||
    checks === undefined ||
    expectedOutcome === undefined ||
    limits === undefined ||
    deterministic === undefined
  ) {
    return undefined;
  }

  return {
    id,
    title,
    category,
    fixture,
    task,
    allowedPaths,
    forbiddenPaths,
    checks,
    expectedOutcome,
    limits,
    deterministic,
  };
}

export function validateScenario(input: unknown): ValidationResult<BenchmarkScenario> {
  const problems = new ValidationProblems();
  return toValidationResult(readScenario(input, "", problems), problems);
}

export function validateScenarioSuite(input: unknown): ValidationResult<ScenarioSuite> {
  const problems = new ValidationProblems();
  const record = readRecord(input, "", SCENARIO_SUITE_KEYS, problems);
  if (record === undefined) return toValidationResult<ScenarioSuite>(undefined, problems);

  const schemaVersion = readSchemaVersion(record, "", problems, SCENARIO_SUITE_SCHEMA_VERSION);
  const version = readMatching(
    record,
    "version",
    "",
    problems,
    SEMANTIC_VERSION,
    "a semantic version like 1.0.0",
  );
  const scenarios = readList(record, "scenarios", "", problems, 1, (element, elementPath) =>
    readScenario(element, elementPath, problems),
  );

  if (scenarios !== undefined) {
    for (const duplicate of findDuplicates(scenarios.map((scenario) => scenario.id))) {
      problems.add(
        "scenarios",
        "duplicate",
        `scenario id "${duplicate}" is declared more than once; every stored sample is keyed by it`,
      );
    }
  }

  if (schemaVersion === undefined || version === undefined || scenarios === undefined) {
    return toValidationResult<ScenarioSuite>(undefined, problems);
  }
  return toValidationResult({ schemaVersion, version, scenarios }, problems);
}

// ---------------------------------------------------------------------------
// Suite configuration (BENCH-3, BENCH-8)
// ---------------------------------------------------------------------------

const MODEL_SETTINGS_KEYS = ["model", "temperature", "maxOutputTokens"] as const;
/** A declared variant states its intent; the identity is computed from it, never read. */
const COMPRESSION_VARIANT_KEYS = ["id", "features", "hookProfile"] as const;
const SUITE_CONFIG_KEYS = [
  "schemaVersion",
  "suiteVersion",
  "modes",
  "repetitions",
  "modelSettings",
  "limits",
  "modeAdapterVersions",
  "allowNetworkModels",
  "compressionCohort",
] as const;

function readModelSettings(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): ModelSettings | undefined {
  const nested = readNested(source, "modelSettings", at, MODEL_SETTINGS_KEYS, problems);
  if (nested === undefined) return undefined;
  const model = readString(nested.record, "model", nested.path, problems);
  // Optional fields are read only when present: absent and invalid are different
  // answers, and an absent setting means "the provider default", not "zero".
  const temperature = Object.hasOwn(nested.record, "temperature")
    ? readNumber(nested.record, "temperature", nested.path, problems, MODEL_TEMPERATURE_BOUNDS)
    : undefined;
  const maxOutputTokens = Object.hasOwn(nested.record, "maxOutputTokens")
    ? readInteger(nested.record, "maxOutputTokens", nested.path, problems, {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      })
    : undefined;
  if (model === undefined) return undefined;
  return {
    model,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

function readModeAdapterVersions(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): Readonly<Record<ExecutionMode, string>> | undefined {
  const nested = readNested(source, "modeAdapterVersions", at, EXECUTION_MODES, problems);
  if (nested === undefined) return undefined;
  const entries: Array<readonly [ExecutionMode, string]> = [];
  for (const mode of EXECUTION_MODES) {
    const version = readString(nested.record, mode, nested.path, problems);
    if (version !== undefined) entries.push([mode, version]);
  }
  if (entries.length !== EXECUTION_MODES.length) return undefined;
  // Total by construction: the loop above visited every declared mode.
  return Object.fromEntries(entries) as Readonly<Record<ExecutionMode, string>>;
}

/**
 * Reads a declared compression cohort, if the config declares one.
 *
 * The document states an id, a flag set and a hook profile; the identity is
 * computed here by the domain rather than read from the file. An authored
 * document cannot be expected to carry a correct sixty-four character digest,
 * and one that carried a wrong digest would attribute a run's samples to a
 * variant it never executed.
 */
function readCompressionCohort(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): readonly CompressionVariant[] | undefined {
  if (!Object.hasOwn(source, "compressionCohort")) return undefined;
  const variants = readList(source, "compressionCohort", at, problems, 1, (element, elementPath) => {
    const record = readRecord(element, elementPath, COMPRESSION_VARIANT_KEYS, problems);
    if (record === undefined) return undefined;
    const id = readMatching(record, "id", elementPath, problems, IDENTIFIER, KEBAB_CASE.expectation);
    const features = readStringList(record, "features", elementPath, problems, 0, {
      test: new RegExp(`^(?:${COMPRESSION_FEATURES.join("|")})$`),
      expectation: `one of ${COMPRESSION_FEATURES.join(", ")}`,
    });
    const hookProfile = readEnum(
      record,
      "hookProfile",
      elementPath,
      problems,
      COMPRESSION_HOOK_PROFILES,
    );
    if (id === undefined || features === undefined || hookProfile === undefined) return undefined;
    return defineCompressionVariant({
      id,
      features: features as readonly CompressionFeature[],
      hookProfile,
    });
  });
  if (variants === undefined) return undefined;

  // Two entries with one identity would split a population by label while
  // measuring one thing; two with one id would key the same samples twice.
  for (const key of ["id", "identity"] as const) {
    for (const duplicate of findDuplicates(variants.map((variant) => variant[key]))) {
      problems.add(
        joinPath(at, "compressionCohort"),
        "duplicate",
        `two cohort entries share the ${key} "${duplicate}"; a variant is declared once`,
      );
    }
  }
  return variants;
}

export function validateSuiteConfig(input: unknown): ValidationResult<BenchmarkSuiteConfig> {
  const problems = new ValidationProblems();
  const record = readRecord(input, "", SUITE_CONFIG_KEYS, problems);
  if (record === undefined) return toValidationResult<BenchmarkSuiteConfig>(undefined, problems);

  const schemaVersion = readSchemaVersion(record, "", problems, SUITE_CONFIG_SCHEMA_VERSION);
  const suiteVersion = readMatching(
    record,
    "suiteVersion",
    "",
    problems,
    SEMANTIC_VERSION,
    "a semantic version like 1.0.0",
  );
  const modes = readList(record, "modes", "", problems, 1, (element, elementPath) => {
    if (typeof element !== "string" || !(EXECUTION_MODES as readonly string[]).includes(element)) {
      problems.add(
        elementPath,
        "unknown-enum-value",
        `expected one of ${EXECUTION_MODES.join(" | ")}, received ${JSON.stringify(element)}`,
      );
      return undefined;
    }
    return element as ExecutionMode;
  });
  const repetitions = readInteger(
    record,
    "repetitions",
    "",
    problems,
    SUITE_CONFIG_REPETITION_BOUNDS,
  );
  const modelSettings = readModelSettings(record, "", problems);
  // The run-wide ceiling has the same shape as a scenario's own limits.
  const limits = readScenarioLimits(record, "", problems);
  const modeAdapterVersions = readModeAdapterVersions(record, "", problems);
  const allowNetworkModels = readBoolean(record, "allowNetworkModels", "", problems);
  const compressionCohort = readCompressionCohort(record, "", problems);

  if (modes !== undefined) {
    for (const duplicate of findDuplicates(modes)) {
      problems.add(
        "modes",
        "duplicate",
        `mode "${duplicate}" is declared more than once; a mode is executed once per repetition`,
      );
    }
  }

  if (
    schemaVersion === undefined ||
    suiteVersion === undefined ||
    modes === undefined ||
    repetitions === undefined ||
    modelSettings === undefined ||
    limits === undefined ||
    modeAdapterVersions === undefined ||
    allowNetworkModels === undefined
  ) {
    return toValidationResult<BenchmarkSuiteConfig>(undefined, problems);
  }

  return toValidationResult(
    {
      schemaVersion,
      suiteVersion,
      modes,
      repetitions,
      modelSettings,
      limits,
      modeAdapterVersions,
      allowNetworkModels,
      ...(compressionCohort === undefined ? {} : { compressionCohort }),
    },
    problems,
  );
}

// ---------------------------------------------------------------------------
// Run result (BENCH-4, BENCH-5, BENCH-6)
// ---------------------------------------------------------------------------

const CHECK_RESULT_KEYS = ["id", "kind", "status", "durationMs"] as const;
const TELEMETRY_KEYS = [
  "model",
  "inputTokens",
  "outputTokens",
  "llmCalls",
  "attempts",
  "repairs",
  "humanReviewEvents",
] as const;
const WORKSPACE_KEYS = [
  "startCommit",
  "endCommit",
  "changedFiles",
  "outOfScopeFiles",
  "cleanup",
] as const;
const ACCEPTANCE_KEYS = ["verdict", "reasons", "agentClaimedDone"] as const;
const USAGE_KEYS = [
  "source",
  "captured",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "numTurns",
  "turnsSource",
] as const;
/** The counts a usage record only carries when accounting succeeded. */
const USAGE_COUNT_KEYS = [
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "numTurns",
] as const;
const COMPRESSION_DIAGNOSTIC_KEYS = [
  "rawTaskChars",
  "compiledTaskChars",
  "workerPromptChars",
  "symbolSourceChars",
  "symbolSignatureChars",
  "toolRawChars",
  "toolDigestChars",
] as const;
const COMPRESSION_KEYS = [
  "variantId",
  "variantIdentity",
  "features",
  "hookProfile",
  "diagnostics",
] as const;
/** Blocks version 1 did not define; their presence contradicts a `schemaVersion: 1` claim. */
const SAMPLE_V2_KEYS = ["usage", "compression"] as const;
const SAMPLE_KEYS = [
  "schemaVersion",
  "sampleId",
  "scenarioId",
  "mode",
  "repetition",
  "startedAt",
  "durationMs",
  "telemetry",
  "checks",
  "workspace",
  "acceptance",
  ...SAMPLE_V2_KEYS,
] as const;

function readCheckResult(
  value: unknown,
  at: string,
  problems: ValidationProblems,
): CheckResult | undefined {
  const record = readRecord(value, at, CHECK_RESULT_KEYS, problems);
  if (record === undefined) return undefined;
  const id = readMatching(record, "id", at, problems, IDENTIFIER, KEBAB_CASE.expectation);
  const kind = readEnum(record, "kind", at, problems, CHECK_KINDS);
  const status = readEnum(record, "status", at, problems, CHECK_STATUSES);
  const durationMs = readInteger(record, "durationMs", at, problems, COUNT_BOUNDS);
  if (id === undefined || kind === undefined || status === undefined || durationMs === undefined) {
    return undefined;
  }
  return { id, kind, status, durationMs };
}

function readTelemetry(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): SampleTelemetry | undefined {
  const nested = readNested(source, "telemetry", at, TELEMETRY_KEYS, problems);
  if (nested === undefined) return undefined;
  const model = readString(nested.record, "model", nested.path, problems);
  const inputTokens = readInteger(nested.record, "inputTokens", nested.path, problems, COUNT_BOUNDS);
  const outputTokens = readInteger(
    nested.record,
    "outputTokens",
    nested.path,
    problems,
    COUNT_BOUNDS,
  );
  const llmCalls = readInteger(nested.record, "llmCalls", nested.path, problems, COUNT_BOUNDS);
  // At least one attempt: a sample exists because something was executed.
  const attempts = readInteger(nested.record, "attempts", nested.path, problems, ATTEMPT_BOUNDS);
  const repairs = readInteger(nested.record, "repairs", nested.path, problems, COUNT_BOUNDS);
  const humanReviewEvents = readInteger(
    nested.record,
    "humanReviewEvents",
    nested.path,
    problems,
    COUNT_BOUNDS,
  );
  if (
    model === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    llmCalls === undefined ||
    attempts === undefined ||
    repairs === undefined ||
    humanReviewEvents === undefined
  ) {
    return undefined;
  }
  return { model, inputTokens, outputTokens, llmCalls, attempts, repairs, humanReviewEvents };
}

function readWorkspaceRecord(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): SampleWorkspaceRecord | undefined {
  const nested = readNested(source, "workspace", at, WORKSPACE_KEYS, problems);
  if (nested === undefined) return undefined;
  const startCommit = readMatching(
    nested.record,
    "startCommit",
    nested.path,
    problems,
    COMMIT_ID,
    "a full Git object id",
  );
  const endCommit = readMatching(
    nested.record,
    "endCommit",
    nested.path,
    problems,
    COMMIT_ID,
    "a full Git object id",
  );
  const changedFiles = readSafePathList(nested.record, "changedFiles", nested.path, problems, 0);
  const outOfScopeFiles = readSafePathList(
    nested.record,
    "outOfScopeFiles",
    nested.path,
    problems,
    0,
  );
  const cleanup = readEnum(
    nested.record,
    "cleanup",
    nested.path,
    problems,
    WORKTREE_CLEANUP_RESULTS,
  );
  if (
    startCommit === undefined ||
    endCommit === undefined ||
    changedFiles === undefined ||
    outOfScopeFiles === undefined ||
    cleanup === undefined
  ) {
    return undefined;
  }
  return { startCommit, endCommit, changedFiles, outOfScopeFiles, cleanup };
}

function readAcceptance(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): AcceptanceDecision | undefined {
  const nested = readNested(source, "acceptance", at, ACCEPTANCE_KEYS, problems);
  if (nested === undefined) return undefined;
  const verdict = readEnum(nested.record, "verdict", nested.path, problems, ACCEPTANCE_VERDICTS);
  const reasons = readStringList(nested.record, "reasons", nested.path, problems, 0, KEBAB_CASE);
  const agentClaimedDone = readBoolean(nested.record, "agentClaimedDone", nested.path, problems);
  if (verdict === undefined || reasons === undefined || agentClaimedDone === undefined) {
    return undefined;
  }
  return { verdict, reasons, agentClaimedDone };
}

/**
 * Reads an optional nested object, or reports that it is not one.
 *
 * The distinction this preserves is the same one the whole package rests on: a
 * block that is absent was never recorded, and a block that is present and
 * unreadable is a defect in whatever wrote it. Returning `undefined` for both
 * would let a malformed usage record read as "this run reported no usage".
 */
function readOptionalNested(
  source: Record<string, unknown>,
  key: string,
  at: string,
  allowedKeys: readonly string[],
  problems: ValidationProblems,
): { readonly record: Record<string, unknown>; readonly path: string } | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const path = joinPath(at, key);
  const record = readRecord(source[key], path, allowedKeys, problems);
  return record === undefined ? undefined : { record, path };
}

/** An optional count: absent stays absent, present must be a non-negative safe integer. */
function readOptionalCount(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
): number | undefined {
  return Object.hasOwn(source, key) ? readInteger(source, key, at, problems, COUNT_BOUNDS) : undefined;
}

/**
 * Reads the usage block a v2 sample may carry.
 *
 * `captured` is required and the counts are not: a record that says accounting
 * failed is a usable record, and one that says it succeeded while omitting a
 * count is simply a producer that does not report that count. What is refused is
 * the contradiction — counts standing beside `captured: false` — because the
 * whole point of the flag is that those numbers were not observed.
 */
function readUsageRecord(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): SampleUsageRecord | undefined {
  const nested = readOptionalNested(source, "usage", at, USAGE_KEYS, problems);
  if (nested === undefined) return undefined;

  const usageSource = readEnum(nested.record, "source", nested.path, problems, USAGE_SOURCES);
  const captured = readBoolean(nested.record, "captured", nested.path, problems);
  const cacheReadInputTokens = readOptionalCount(
    nested.record,
    "cacheReadInputTokens",
    nested.path,
    problems,
  );
  const cacheCreationInputTokens = readOptionalCount(
    nested.record,
    "cacheCreationInputTokens",
    nested.path,
    problems,
  );
  const numTurns = readOptionalCount(nested.record, "numTurns", nested.path, problems);
  const turnsSource = Object.hasOwn(nested.record, "turnsSource")
    ? readEnum(nested.record, "turnsSource", nested.path, problems, TURNS_SOURCES)
    : undefined;

  if (captured === false) {
    for (const key of USAGE_COUNT_KEYS.filter((name) => Object.hasOwn(nested.record, name))) {
      problems.add(
        joinPath(nested.path, key),
        "inconsistent",
        "the record says usage was not captured, so it cannot also report a count that capture would have produced",
      );
    }
  }
  // A turn count without its source cannot be compared against another run's,
  // and a source without a count describes a number that is not there.
  if (Object.hasOwn(nested.record, "numTurns") !== Object.hasOwn(nested.record, "turnsSource")) {
    problems.add(
      joinPath(nested.path, "turnsSource"),
      "inconsistent",
      "a turn count and the source it was derived from are recorded together or not at all",
    );
  }

  if (usageSource === undefined || captured === undefined) return undefined;
  return {
    source: usageSource,
    captured,
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(numTurns === undefined ? {} : { numTurns }),
    ...(turnsSource === undefined ? {} : { turnsSource }),
  };
}

function readCompressionDiagnostics(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): SampleCompressionDiagnostics | undefined {
  const nested = readOptionalNested(source, "diagnostics", at, COMPRESSION_DIAGNOSTIC_KEYS, problems);
  if (nested === undefined) return undefined;
  const entries = COMPRESSION_DIAGNOSTIC_KEYS.map(
    (key) => [key, readOptionalCount(nested.record, key, nested.path, problems)] as const,
  ).filter((entry): entry is readonly [(typeof COMPRESSION_DIAGNOSTIC_KEYS)[number], number] =>
    entry[1] !== undefined,
  );
  return Object.fromEntries(entries) as SampleCompressionDiagnostics;
}

/**
 * Reads the compression block a v2 sample may carry.
 *
 * The stored identity is checked for shape and not recomputed from the stored
 * features. It is a digest over a *registry version*, and a reader whose
 * registry has moved on cannot re-derive an identity recorded under the previous
 * one — refusing such a sample would delete the history a comparison is drawn
 * from. Whether two identities describe the same thing is a comparability
 * question the report answers by variant, not a schema error.
 */
function readCompressionRecord(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): SampleCompressionRecord | undefined {
  const nested = readOptionalNested(source, "compression", at, COMPRESSION_KEYS, problems);
  if (nested === undefined) return undefined;

  const variantId = readMatching(
    nested.record,
    "variantId",
    nested.path,
    problems,
    IDENTIFIER,
    KEBAB_CASE.expectation,
  );
  const variantIdentity = readMatching(
    nested.record,
    "variantIdentity",
    nested.path,
    problems,
    CANONICAL_DIGEST_PATTERN,
    "a canonical digest like sha256:<64 hex characters>",
  );
  // Zero features is the baseline variant, which is a variant like any other.
  const features = readStringList(nested.record, "features", nested.path, problems, 0, {
    test: new RegExp(`^(?:${COMPRESSION_FEATURES.join("|")})$`),
    expectation: `one of ${COMPRESSION_FEATURES.join(", ")}`,
  });
  const hookProfile = readEnum(
    nested.record,
    "hookProfile",
    nested.path,
    problems,
    COMPRESSION_HOOK_PROFILES,
  );
  const diagnostics = readCompressionDiagnostics(nested.record, nested.path, problems);

  if (features !== undefined) {
    for (const duplicate of findDuplicates([...features])) {
      problems.add(
        joinPath(nested.path, "features"),
        "duplicate",
        `feature "${duplicate}" is enabled twice; a variant is a set of flags, not a list`,
      );
    }
  }

  if (variantId === undefined || variantIdentity === undefined || features === undefined) {
    return undefined;
  }
  if (hookProfile === undefined) return undefined;
  return {
    variantId,
    variantIdentity,
    features: features as readonly CompressionFeature[],
    hookProfile,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

/**
 * The usage block on its own, for a producer that has to judge one before a
 * sample exists to put it in.
 *
 * An adapter reading a telemetry envelope validates the block it just read with
 * exactly the rules the store will apply later. Checking it there turns what
 * would otherwise be a whole sample lost to a validation error — long after the
 * tokens were spent — into an ordinary adapter failure naming the contradiction
 * while the run is still going.
 */
export function validateSampleUsageRecord(input: unknown): ValidationResult<SampleUsageRecord> {
  const problems = new ValidationProblems();
  return toValidationResult(readUsageRecord({ usage: input }, "", problems), problems);
}

/** The compression block on its own, for the same reason as {@link validateSampleUsageRecord}. */
export function validateSampleCompressionRecord(
  input: unknown,
): ValidationResult<SampleCompressionRecord> {
  const problems = new ValidationProblems();
  return toValidationResult(readCompressionRecord({ compression: input }, "", problems), problems);
}

/**
 * Validates one stored run result. Beyond the field checks, the cross-field
 * rules below distinguish a record that merely reports a bad run from one that
 * cannot be true — the case BENCH-5 requires to surface as an error rather than
 * as a sample quietly folded into an average.
 */
export function validateBenchmarkSample(input: unknown): ValidationResult<BenchmarkSample> {
  const problems = new ValidationProblems();
  const record = readRecord(input, "", SAMPLE_KEYS, problems);
  if (record === undefined) return toValidationResult<BenchmarkSample>(undefined, problems);

  const schemaVersion = readSchemaVersionIn(
    record,
    "",
    problems,
    SUPPORTED_BENCHMARK_SAMPLE_SCHEMA_VERSIONS,
  );
  const sampleId = readMatching(record, "sampleId", "", problems, IDENTIFIER, KEBAB_CASE.expectation);
  const scenarioId = readMatching(
    record,
    "scenarioId",
    "",
    problems,
    IDENTIFIER,
    KEBAB_CASE.expectation,
  );
  const mode = readEnum(record, "mode", "", problems, EXECUTION_MODES);
  const repetition = readInteger(record, "repetition", "", problems, {
    min: 1,
    max: SUITE_CONFIG_REPETITION_BOUNDS.max,
  });
  const startedAt = readTimestamp(record, "startedAt", "", problems);
  const durationMs = readInteger(record, "durationMs", "", problems, COUNT_BOUNDS);
  const telemetry = readTelemetry(record, "", problems);
  const checks = readList(record, "checks", "", problems, 0, (element, elementPath) =>
    readCheckResult(element, elementPath, problems),
  );
  const workspace = readWorkspaceRecord(record, "", problems);
  const acceptance = readAcceptance(record, "", problems);
  const usage = readUsageRecord(record, "", problems);
  const compression = readCompressionRecord(record, "", problems);

  // A version-1 line carrying a version-2 block is not an old record with extra
  // detail; it is a record whose own version claim is false, and the fields the
  // claim covers can no longer be trusted to mean what this reader thinks.
  if (schemaVersion === 1) {
    for (const key of SAMPLE_V2_KEYS.filter((name) => Object.hasOwn(record, name))) {
      problems.add(
        key,
        "inconsistent",
        `"${key}" was introduced by sample schema version ${BENCHMARK_SAMPLE_SCHEMA_VERSION}, so a record declaring version 1 cannot carry it`,
      );
    }
  }

  if (checks !== undefined) {
    for (const duplicate of findDuplicates(checks.map((check) => check.id))) {
      problems.add("checks", "duplicate", `check id "${duplicate}" is reported more than once`);
    }
  }
  if (telemetry !== undefined) {
    if (telemetry.llmCalls === 0 && telemetry.inputTokens + telemetry.outputTokens > 0) {
      problems.add(
        "telemetry",
        "inconsistent",
        "tokens are reported without a single LLM call; one of the two numbers is wrong",
      );
    }
    // Every repair is itself an attempt, so a record with as many repairs as
    // attempts has lost the first, unrepaired one.
    if (telemetry.repairs >= telemetry.attempts) {
      problems.add(
        "telemetry.repairs",
        "inconsistent",
        `${telemetry.repairs} repair(s) against ${telemetry.attempts} attempt(s); repairs stay below attempts`,
      );
    }
    if (
      mode === "deterministic-control" &&
      telemetry.llmCalls + telemetry.inputTokens + telemetry.outputTokens > 0
    ) {
      problems.add(
        "telemetry",
        "inconsistent",
        "the deterministic control calls no model, so a sample reporting model cost under it is not a control sample",
      );
    }
  }
  if (workspace !== undefined) {
    const changed = new Set(workspace.changedFiles);
    for (const file of workspace.outOfScopeFiles.filter((path) => !changed.has(path))) {
      problems.add(
        "workspace.outOfScopeFiles",
        "inconsistent",
        `"${file}" is reported out of scope but is not among the changed files`,
      );
    }
  }
  if (acceptance !== undefined && acceptance.verdict !== "verified-accepted") {
    if (acceptance.reasons.length === 0) {
      problems.add(
        "acceptance.reasons",
        "empty",
        `a "${acceptance.verdict}" verdict carries at least one machine-readable reason code`,
      );
    }
  }

  if (
    schemaVersion === undefined ||
    sampleId === undefined ||
    scenarioId === undefined ||
    mode === undefined ||
    repetition === undefined ||
    startedAt === undefined ||
    durationMs === undefined ||
    telemetry === undefined ||
    checks === undefined ||
    workspace === undefined ||
    acceptance === undefined
  ) {
    return toValidationResult<BenchmarkSample>(undefined, problems);
  }

  return toValidationResult(
    {
      schemaVersion,
      sampleId,
      scenarioId,
      mode,
      repetition,
      startedAt,
      durationMs,
      telemetry,
      checks,
      workspace,
      acceptance,
      ...(usage === undefined ? {} : { usage }),
      ...(compression === undefined ? {} : { compression }),
    },
    problems,
  );
}
