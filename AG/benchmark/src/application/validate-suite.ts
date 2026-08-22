import { createHash } from "node:crypto";

import {
  SCENARIO_CATEGORIES,
  SCENARIO_SUITE_SCHEMA_VERSION,
  type BenchmarkScenario,
  type ScenarioCategory,
  type ScenarioSuite,
} from "../domain/scenario.js";
import { validateScenarioSuite } from "../domain/schema-validation.js";
import {
  ValidationProblems,
  findDuplicates,
  isSafeRelativePath,
  readMatching,
  readRecord,
  readSchemaVersion,
  toValidationResult,
  type ValidationProblem,
  type ValidationResult,
} from "../domain/validation.js";
import type { SuiteValidationReport } from "./benchmark-api.js";

/**
 * Suite assembly, canonicalization and integrity (BENCH-2, BENCH-8).
 *
 * The frozen scenario set is authored as one file per scenario beside a small
 * manifest, because a single document holding twenty-odd scenarios is edited by
 * merge conflict rather than by review. That authoring choice creates the
 * problem this module exists to remove: a directory listing is ordered by the
 * filesystem, and a checkout on another platform hands back the same text with
 * different line endings. Neither changes what is measured, so neither may move
 * the suite hash — otherwise two machines would each declare the other's
 * baseline incomparable (BENCH-8).
 *
 * Everything here is pure. The caller reads the files and parses the JSON; this
 * module never touches a filesystem, so the identity it computes cannot depend
 * on anything except the values it was handed.
 */

/**
 * The manifest names the suite; the scenario files supply its content. Keeping
 * them apart makes `version` a deliberate one-line edit: bumping it is how an
 * author states that samples taken under the old set are no longer comparable.
 */
export const SCENARIO_SUITE_MANIFEST_KEYS = ["schemaVersion", "version"] as const;

export interface ScenarioSuiteManifest {
  readonly schemaVersion: number;
  readonly version: string;
}

/**
 * One parsed scenario file. `source` is the file it came from; it is used to
 * report problems and to order the assembly deterministically, and is never
 * hashed, so renaming a file does not re-identify the suite.
 */
export interface ScenarioDocument {
  readonly source: string;
  readonly value: unknown;
}

/** BENCH-2 states the floor as a number, so it is stated here as one too. */
export const SCENARIO_SUITE_MINIMUM_SIZE = 20;

/**
 * The categories whose whole point is that a correct agent produces nothing. A
 * scenario in one of them declaring `accepted` would score a boundary violation
 * as a success, which is the most damaging way this suite could be wrong.
 */
export const REFUSAL_SCENARIO_CATEGORIES: readonly ScenarioCategory[] = [
  "architecture-violation",
  "security-violation",
  "impossible-task",
];

/** Fixtures live under one directory, so containment is checkable by prefix as well as by resolution. */
export const FIXTURE_ROOT = "fixtures";

const SEMANTIC_VERSION = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Text as the suite means it, independent of how a checkout stored it.
 *
 * CRLF and lone CR become LF: Git's `core.autocrlf` rewrites a multi-line task
 * description on Windows, and a hash that noticed would make the suite
 * platform-specific. NFC folds the two Unicode spellings of an accented
 * character, which differ by editor and filesystem rather than by intent.
 */
function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

/**
 * Canonical JSON, narrowed to what a validated suite contains: object keys
 * sorted, no insignificant whitespace, arrays left in their declared order.
 * Array order is content here — a check command is an argument vector, and
 * `allowedPaths` is read top to bottom — so only the scenario list, whose order
 * comes from a directory listing, is reordered, and that happens before this
 * function sees the value.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(normalizeText(value));
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize the non-finite number ${value}.`);
      }
      // Every number a validated suite holds is a safe integer, so the shortest
      // round-trip form is unambiguous and platform-independent.
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`Cannot canonicalize a value of type ${typeof value}.`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(normalizeText(key))}:${canonicalJson(record[key])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * The scenario fields the hash covers, restated explicitly.
 *
 * Hashing a projection rather than the object as handed in means a stray own
 * key cannot reach the digest — a `__proto__` entry that survived `JSON.parse`,
 * a field belonging to a schema version this build does not know, or a
 * hand-built object. `validateBenchmarkSuite` already rebuilds every scenario
 * field by field, but `computeScenarioSuiteHash` is exported on its own and has
 * to carry the same guarantee for a caller holding a suite from elsewhere.
 */
function projectScenario(scenario: BenchmarkScenario): Record<string, unknown> {
  return {
    id: scenario.id,
    title: scenario.title,
    category: scenario.category,
    fixture: scenario.fixture,
    task: scenario.task,
    allowedPaths: [...scenario.allowedPaths],
    forbiddenPaths: [...scenario.forbiddenPaths],
    checks: scenario.checks.map((check) => ({
      id: check.id,
      command: [...check.command],
      expect: check.expect,
    })),
    expectedOutcome: scenario.expectedOutcome,
    limits: { timeoutMs: scenario.limits.timeoutMs, tokenLimit: scenario.limits.tokenLimit },
    deterministic: scenario.deterministic,
  };
}

/**
 * Ids are lowercase kebab-case ASCII, so code-unit order is alphabetical and
 * needs no locale — a locale-sensitive comparison would make the suite hash
 * depend on the machine's language settings.
 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The exact bytes the suite hash is taken over. Exported because a mismatch is
 * far easier to diagnose by diffing two canonical forms than two digests.
 */
export function canonicalizeScenarioSuite(suite: ScenarioSuite): string {
  return canonicalJson({
    schemaVersion: suite.schemaVersion,
    version: suite.version,
    scenarios: [...suite.scenarios]
      .sort((left, right) => compareText(left.id, right.id))
      .map((scenario) => projectScenario(scenario)),
  });
}

/**
 * The suite identity carried in every baseline (BENCH-8). Prefixed with the
 * algorithm so a later move to another digest is a visible change rather than a
 * silently different sixty-four characters.
 */
export function computeScenarioSuiteHash(suite: ScenarioSuite): string {
  const digest = createHash("sha256").update(canonicalizeScenarioSuite(suite), "utf8").digest("hex");
  return `sha256:${digest}`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function validateScenarioSuiteManifest(
  input: unknown,
): ValidationResult<ScenarioSuiteManifest> {
  const problems = new ValidationProblems();
  const record = readRecord(input, "", SCENARIO_SUITE_MANIFEST_KEYS, problems);
  if (record === undefined) {
    return toValidationResult<ScenarioSuiteManifest>(undefined, problems);
  }
  const schemaVersion = readSchemaVersion(record, "", problems, SCENARIO_SUITE_SCHEMA_VERSION);
  const version = readMatching(
    record,
    "version",
    "",
    problems,
    SEMANTIC_VERSION,
    "a semantic version like 1.0.0",
  );
  if (schemaVersion === undefined || version === undefined) {
    return toValidationResult<ScenarioSuiteManifest>(undefined, problems);
  }
  return toValidationResult({ schemaVersion, version }, problems);
}

/**
 * Joins a manifest and the scenario files into one suite and validates it whole.
 *
 * Documents are ordered by `source` before validation so a reported problem path
 * (`scenarios[7].limits`) names the same scenario on every machine. The hash is
 * order-independent regardless, but a problem list that reshuffles between runs
 * is unusable in a diff.
 */
export function assembleScenarioSuite(
  manifest: unknown,
  documents: readonly ScenarioDocument[],
): ValidationResult<ScenarioSuite> {
  const problems = new ValidationProblems();
  const manifestResult = validateScenarioSuiteManifest(manifest);
  if (!manifestResult.ok) {
    for (const problem of manifestResult.problems) {
      const path = problem.path === "" ? "manifest" : `manifest.${problem.path}`;
      problems.add(path, problem.code, problem.message);
    }
  }
  for (const duplicate of findDuplicates(documents.map((document) => document.source))) {
    problems.add(
      "scenarios",
      "duplicate",
      `scenario file "${duplicate}" was supplied more than once; each file contributes exactly one scenario`,
    );
  }
  if (documents.length === 0) {
    problems.add("scenarios", "empty", "no scenario files were supplied");
  }
  if (!manifestResult.ok || !problems.isEmpty) {
    return toValidationResult<ScenarioSuite>(undefined, problems);
  }

  const ordered = [...documents].sort((left, right) => compareText(left.source, right.source));
  const suiteResult = validateScenarioSuite({
    schemaVersion: manifestResult.value.schemaVersion,
    version: manifestResult.value.version,
    scenarios: ordered.map((document) => document.value),
  });
  if (!suiteResult.ok) {
    for (const problem of suiteResult.problems) {
      problems.add(problem.path, problem.code, problem.message);
    }
    return toValidationResult<ScenarioSuite>(undefined, problems);
  }
  return toValidationResult(suiteResult.value, problems);
}

// ---------------------------------------------------------------------------
// Suite-level integrity
// ---------------------------------------------------------------------------

export interface SuiteIntegrityOptions {
  /**
   * Fixture directories that actually exist, suite-relative (`fixtures/x`).
   * Omitted means the caller has not looked, and existence then goes unchecked
   * rather than being assumed either way — a pure function must not guess about
   * a filesystem it cannot see.
   */
  readonly availableFixtures?: readonly string[];
}

/**
 * The rules a schema-valid suite can still break.
 *
 * Every field of every scenario can be individually correct while the set as a
 * whole fails to measure what BENCH-2 asks for: too few scenarios, a category
 * nobody wrote, or — worst — a boundary-violation scenario that scores the
 * violation as a success. None of these is visible from inside a single
 * scenario file, so all of them are checked over the assembled suite.
 */
export function checkSuiteIntegrity(
  suite: ScenarioSuite,
  options: SuiteIntegrityOptions = {},
): readonly ValidationProblem[] {
  const problems = new ValidationProblems();

  if (suite.scenarios.length < SCENARIO_SUITE_MINIMUM_SIZE) {
    problems.add(
      "scenarios",
      "empty",
      `expected at least ${SCENARIO_SUITE_MINIMUM_SIZE} scenarios, received ${suite.scenarios.length}`,
    );
  }

  const covered = new Set(suite.scenarios.map((scenario) => scenario.category));
  for (const category of SCENARIO_CATEGORIES) {
    if (!covered.has(category)) {
      problems.add(
        "scenarios",
        "missing",
        `no scenario covers the "${category}" category, which BENCH-2 requires the suite to measure`,
      );
    }
  }

  const known =
    options.availableFixtures === undefined ? undefined : new Set(options.availableFixtures);

  suite.scenarios.forEach((scenario, index) => {
    const at = `scenarios[${index}]`;
    const mustRefuse = REFUSAL_SCENARIO_CATEGORIES.includes(scenario.category);
    const required = mustRefuse ? "rejected" : "accepted";
    if (scenario.expectedOutcome !== required) {
      problems.add(
        `${at}.expectedOutcome`,
        "inconsistent",
        `a "${scenario.category}" scenario expects "${required}"; "${scenario.expectedOutcome}" would score the opposite behaviour as correct`,
      );
    }
    if (mustRefuse && scenario.forbiddenPaths.length === 0) {
      problems.add(
        `${at}.forbiddenPaths`,
        "empty",
        `a "${scenario.category}" scenario names the paths it must not touch; without them nothing separates refusal from inaction`,
      );
    }
    if (!isSafeRelativePath(scenario.fixture) || !scenario.fixture.startsWith(`${FIXTURE_ROOT}/`)) {
      problems.add(
        `${at}.fixture`,
        "unsafe-path",
        `expected a directory under "${FIXTURE_ROOT}/", received "${scenario.fixture}"`,
      );
    } else if (known !== undefined && !known.has(scenario.fixture)) {
      problems.add(
        `${at}.fixture`,
        "missing",
        `fixture "${scenario.fixture}" does not exist, so the scenario could never be executed`,
      );
    }
  });

  return problems.list;
}

// ---------------------------------------------------------------------------
// Façade
// ---------------------------------------------------------------------------

export interface SuiteValidationOutcome {
  /** The assembled suite, present only when nothing was reported. */
  readonly suite?: ScenarioSuite;
  /** The suite identity, present only when the suite is valid: a hash of a refused suite names nothing. */
  readonly suiteHash?: string;
  readonly scenarioCount: number;
  readonly categoryCoverage: Readonly<Record<ScenarioCategory, number>>;
  readonly problems: readonly ValidationProblem[];
}

function countByCategory(
  scenarios: readonly BenchmarkScenario[],
): Readonly<Record<ScenarioCategory, number>> {
  const counts = Object.fromEntries(SCENARIO_CATEGORIES.map((category) => [category, 0])) as Record<
    ScenarioCategory,
    number
  >;
  for (const scenario of scenarios) counts[scenario.category] += 1;
  return counts;
}

/**
 * The whole check in one call: assemble, validate each scenario, apply the
 * suite-level rules, and only then compute the identity. Fail-closed throughout
 * — a suite with problems yields no hash, so a caller cannot record a baseline
 * against a suite that was never accepted (BENCH-5, BENCH-8).
 */
export function validateBenchmarkSuite(
  manifest: unknown,
  documents: readonly ScenarioDocument[],
  options: SuiteIntegrityOptions = {},
): SuiteValidationOutcome {
  const assembled = assembleScenarioSuite(manifest, documents);
  if (!assembled.ok) {
    return {
      scenarioCount: 0,
      categoryCoverage: countByCategory([]),
      problems: assembled.problems,
    };
  }

  const suite = assembled.value;
  const problems = checkSuiteIntegrity(suite, options);
  const outcome = {
    scenarioCount: suite.scenarios.length,
    categoryCoverage: countByCategory(suite.scenarios),
    problems,
  };
  if (problems.length > 0) return outcome;
  return { ...outcome, suite, suiteHash: computeScenarioSuiteHash(suite) };
}

/**
 * Flattens an outcome into the report shape `BenchmarkApplicationApi.validate`
 * returns. The hash is empty exactly when the suite was refused, so "invalid"
 * and "valid but unidentified" never collapse into the same value.
 */
export function toSuiteValidationReport(outcome: SuiteValidationOutcome): SuiteValidationReport {
  return {
    suiteHash: outcome.suiteHash ?? "",
    scenarioCount: outcome.scenarioCount,
    problems: outcome.problems.map((problem) =>
      problem.path === ""
        ? `${problem.code}: ${problem.message}`
        : `${problem.path}: ${problem.code}: ${problem.message}`,
    ),
  };
}
