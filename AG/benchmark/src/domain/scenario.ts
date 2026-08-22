/**
 * Scenario contract (BENCH-2).
 *
 * A scenario is the unit the whole benchmark is comparable across: the same
 * declaration drives every execution mode, so everything that could make one
 * run easier than another — the fixture, the task text, the scope, the checks,
 * the limits — is declared here and nowhere else.
 */

/**
 * The categories BENCH-2 requires the suite to cover. `architecture-violation`,
 * `security-violation` and `impossible-task` exist so the suite measures what an
 * agent refuses to do, not only what it manages to do.
 */
export const SCENARIO_CATEGORIES = [
  "code-change",
  "bugfix",
  "refactor",
  "ui",
  "tests",
  "docs",
  "architecture-violation",
  "security-violation",
  "impossible-task",
] as const;

export type ScenarioCategory = (typeof SCENARIO_CATEGORIES)[number];

/**
 * What a correct run looks like. For violation and impossible scenarios the
 * expected outcome is `rejected`: producing a change there is the failure.
 */
export const SCENARIO_EXPECTED_OUTCOMES = ["accepted", "rejected"] as const;

export type ScenarioExpectedOutcome = (typeof SCENARIO_EXPECTED_OUTCOMES)[number];

/**
 * What a check is expected to do. `fail` states that the check is expected to
 * keep failing (e.g. a bug reproduction that must not be silenced).
 */
export const SCENARIO_CHECK_EXPECTATIONS = ["pass", "fail"] as const;

export type ScenarioCheckExpectation = (typeof SCENARIO_CHECK_EXPECTATIONS)[number];

/**
 * A check the independent verifier re-runs (BENCH-6). The command is an argument
 * vector, never a shell string: scenario data must not become an execution
 * surface in the harness that runs it.
 */
export interface ScenarioCheck {
  readonly id: string;
  readonly command: readonly string[];
  readonly expect: ScenarioCheckExpectation;
}

/**
 * Bounds a declared limit must itself stay inside. A scenario that may run for a
 * day or spend tokens without a ceiling is not a measurement, so the worst case
 * of a suite is made computable before anything is executed. The floors keep a
 * limit from being set so low that every mode fails on the harness rather than
 * on the task.
 */
export const SCENARIO_TIMEOUT_MS_BOUNDS = { min: 1_000, max: 3_600_000 } as const;
export const SCENARIO_TOKEN_LIMIT_BOUNDS = { min: 1_000, max: 10_000_000 } as const;

/** Per-scenario ceilings; identical across modes so cost stays comparable (BENCH-3). */
export interface ScenarioLimits {
  readonly timeoutMs: number;
  readonly tokenLimit: number;
}

export interface BenchmarkScenario {
  readonly id: string;
  readonly title: string;
  readonly category: ScenarioCategory;
  /**
   * Suite-relative fixture directory. Resolution must stay inside the benchmark
   * workspace — a fixture pointing outside it is rejected, not clamped.
   */
  readonly fixture: string;
  /** The task text handed to every mode verbatim. */
  readonly task: string;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly checks: readonly ScenarioCheck[];
  readonly expectedOutcome: ScenarioExpectedOutcome;
  readonly limits: ScenarioLimits;
  /**
   * `false` marks a scenario whose result varies between runs; BENCH-9 requires
   * those to be repeated at least three times before any verdict is drawn.
   */
  readonly deterministic: boolean;
}

/**
 * The shape version of the suite document itself, as opposed to `version`, which
 * names the scenario content. A reader that meets a document written under a
 * version it does not know rejects it: silently ignoring a field added later
 * would let two runs measure different things under the same hash.
 */
export const SCENARIO_SUITE_SCHEMA_VERSION = 1;

/**
 * The frozen, versioned set. `version` is part of the suite hash, so editing a
 * scenario without bumping it makes old and new samples incomparable by design.
 */
export interface ScenarioSuite {
  readonly schemaVersion: number;
  /** Semantic version of the scenario content, e.g. `1.0.0`. */
  readonly version: string;
  readonly scenarios: readonly BenchmarkScenario[];
}
