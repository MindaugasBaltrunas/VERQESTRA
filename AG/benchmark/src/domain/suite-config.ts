import type { ModelSettings } from "./baseline.js";
import type { CompressionVariant } from "./compression/variant.js";
import type { ExecutionMode } from "./result.js";
import type { ScenarioLimits } from "./scenario.js";

/**
 * Run configuration contract (BENCH-3, BENCH-8).
 *
 * Everything that decides what a run costs and what it is comparable to lives
 * here, in one document that is hashed as a whole. The split from `ScenarioSuite`
 * is deliberate: the suite says what is measured and the config says under which
 * conditions, so re-running the same scenarios with a different model is visibly
 * a different configuration rather than a silently different number.
 */

export const SUITE_CONFIG_SCHEMA_VERSION = 1;

/**
 * How many times each scenario is executed per mode. BENCH-9 requires at least
 * three for nondeterministic scenarios; the ceiling exists because repetitions
 * multiply every scenario's token limit into the run's worst case.
 */
export const SUITE_CONFIG_REPETITION_BOUNDS = { min: 1, max: 25 } as const;

/** Sampling temperature accepted from a config; outside this the value is not a temperature. */
export const MODEL_TEMPERATURE_BOUNDS = { min: 0, max: 2 } as const;

export interface BenchmarkSuiteConfig {
  readonly schemaVersion: number;
  /**
   * The `ScenarioSuite.version` this config was written for. A config carried
   * over to a re-versioned suite describes conditions for scenarios that no
   * longer exist, which is why the pair is checked rather than assumed.
   */
  readonly suiteVersion: string;
  /** The modes to execute, in the order the report presents them. Non-empty and without repeats. */
  readonly modes: readonly ExecutionMode[];
  readonly repetitions: number;
  readonly modelSettings: ModelSettings;
  /**
   * The run-wide ceiling. A scenario declares its own, usually smaller, limits;
   * this bounds what any single scenario is allowed to ask for.
   */
  readonly limits: ScenarioLimits;
  /**
   * Adapter version per mode — all modes, not only the executed ones, so the
   * config hash does not shift merely because a run selected a subset. An
   * adapter change alone can move every number, so it is configuration.
   */
  readonly modeAdapterVersions: Readonly<Record<ExecutionMode, string>>;
  /** Paid model and network execution stay off unless the config says otherwise. */
  readonly allowNetworkModels: boolean;
  /**
   * The compression variants this run executes, when it executes any (task 0029).
   *
   * Optional, and its absence is a meaning-preserving state rather than a
   * missing value: a run that declares no cohort measures the compression
   * configuration the repository is checked out with. `computeSuiteConfigHash`
   * therefore projects it only when it is present, so a config without a cohort
   * still hashes to exactly what it hashed to before this field existed and
   * every baseline taken under it stays comparable — while a run that *does*
   * execute a cohort is visibly a different configuration, which is what BENCH-8
   * requires.
   */
  readonly compressionCohort?: readonly CompressionVariant[];
}
