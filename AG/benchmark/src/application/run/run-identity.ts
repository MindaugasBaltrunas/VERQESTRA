import type {
  BenchmarkEnvironment,
  BenchmarkIdentity,
  ModelSettings,
} from "../../domain/baseline.js";
import {
  ACCEPTANCE_VERIFIER_VERSION,
  BASELINE_MANIFEST_SCHEMA_VERSION,
  computeSuiteConfigHash,
  freezeDeep,
  type BaselineManifest,
} from "../../domain/baseline/manifest.js";
import {
  MODE_COST_KPI_VERSION,
  aggregateSamplesByMode,
  toModeMetrics,
} from "../../domain/metrics/aggregate.js";
import type { BenchmarkSample, ExecutionMode } from "../../domain/result.js";
import {
  SCENARIO_TIMEOUT_MS_BOUNDS,
  SCENARIO_TOKEN_LIMIT_BOUNDS,
  type ScenarioLimits,
} from "../../domain/scenario.js";
import { SUITE_CONFIG_SCHEMA_VERSION, type BenchmarkSuiteConfig } from "../../domain/suite-config.js";
import type { BenchmarkRunSummary } from "../benchmark-api.js";
import type { RecordedCompressionConfig } from "../ports/compression-config-port.js";
import {
  RUN_IDENTITY_RECORD_SCHEMA_VERSION,
  type RunIdentityRecord,
} from "../ports/run-identity-store-port.js";
import type { RunEnvironmentRecord } from "../run-environment.js";

/**
 * What a run records about itself (BENCH-8).
 *
 * A measurement is only comparable against another measurement taken the same
 * way, so before a run stores a single number it has to be able to say what it
 * measured, under which configuration and under which policy. This module builds
 * exactly those three statements — the suite configuration, the identity hashes
 * and the manifest — from the run request and the host capture, and nothing else.
 *
 * It is deliberately separate from the composition root. The composition root
 * decides which adapter, which store and which directory; the values here decide
 * whether two baselines may be put side by side, and a wiring change must not be
 * able to move them by accident.
 */

/**
 * The model the networked modes are configured for.
 *
 * It enters the configuration hash, so it is a declared constant rather than a
 * value read from the environment: a run whose model came from an environment
 * variable would produce baselines that compare equal while having been measured
 * against different models. `deterministic-control` calls no model and records
 * `CONTROL_MODEL_ID` regardless of this setting.
 */
export const DEFAULT_RUN_MODEL_SETTINGS: ModelSettings = Object.freeze({
  model: "claude-opus-5",
});

/**
 * The run-wide ceiling, set at the largest limit a scenario is allowed to
 * declare.
 *
 * The effective limit of an execution is the smaller of the scenario's own and
 * this one, so a ceiling at the maximum means every scenario runs under exactly
 * the limits it declared — the suite decides what a task is worth, and the run
 * configuration does not silently tighten it.
 */
export const RUN_LIMIT_CEILING: ScenarioLimits = Object.freeze({
  timeoutMs: SCENARIO_TIMEOUT_MS_BOUNDS.max,
  tokenLimit: SCENARIO_TOKEN_LIMIT_BOUNDS.max,
});

export interface RunConfigurationInput {
  /** `ScenarioSuite.version` of the suite the run executes. */
  readonly suiteVersion: string;
  /** The modes this run executes, in the order the report presents them. */
  readonly modes: readonly ExecutionMode[];
  readonly repetitions: number;
  readonly allowNetworkModels: boolean;
  /**
   * Adapter version per mode — all of them, not only the executed ones, so the
   * hash does not shift merely because a run selected a subset. Supplied by the
   * composition root, because the adapters are infrastructure and this layer
   * does not import them.
   */
  readonly modeAdapterVersions: Readonly<Record<ExecutionMode, string>>;
}

/** The configuration one run executed under, as the hash covers it. */
export function buildRunConfiguration(input: RunConfigurationInput): BenchmarkSuiteConfig {
  return freezeDeep({
    schemaVersion: SUITE_CONFIG_SCHEMA_VERSION,
    suiteVersion: input.suiteVersion,
    modes: [...input.modes],
    repetitions: input.repetitions,
    modelSettings: DEFAULT_RUN_MODEL_SETTINGS,
    limits: RUN_LIMIT_CEILING,
    modeAdapterVersions: input.modeAdapterVersions,
    allowNetworkModels: input.allowNetworkModels,
  });
}

export interface RunIdentityInput {
  readonly config: BenchmarkSuiteConfig;
  /** `computeScenarioSuiteHash` of the validated suite; empty exactly when the suite was refused. */
  readonly suiteHash: string;
  readonly policyHash: string;
  /** The Git object id of the tree under measurement, or `""` when the host could not name it. */
  readonly agCommit: string;
}

/**
 * The hashes a comparison is gated on.
 *
 * The config hash is computed here rather than accepted from a caller, for the
 * same reason `create-baseline.ts` computes it: a caller who could supply one
 * could supply the baseline's, and the comparability gate would then approve a
 * comparison between two different configurations.
 */
export function buildRunIdentity(input: RunIdentityInput): BenchmarkIdentity {
  return freezeDeep({
    suiteHash: input.suiteHash,
    configHash: computeSuiteConfigHash(input.config),
    policyHash: input.policyHash,
    agCommit: input.agCommit,
    modeAdapterVersions: input.config.modeAdapterVersions,
  });
}

export interface RunIdentityRecordInput {
  /** The run whose ledger the record is stored beside, as `createRunId` formed it. */
  readonly runId: string;
  /** ISO-8601 UTC. Supplied by the caller: this module reads no clock. */
  readonly recordedAt: string;
  readonly identity: BenchmarkIdentity;
  /** The document {@link RunIdentityRecordInput.identity}'s `configHash` was taken over. */
  readonly config: BenchmarkSuiteConfig;
  readonly environment: RunEnvironmentRecord;
  readonly compressionConfig: RecordedCompressionConfig;
}

/**
 * The statement a run stores about itself before it measures anything (task
 * 1205).
 *
 * The identity is accepted here rather than rebuilt, because the run is already
 * executing under the one this module produced for it: rebuilding it would let a
 * record describe a methodology the samples beside it were not taken under. What
 * this function adds is the schema version and the seal — a provenance record a
 * consumer can edit is a provenance record nothing may be attributed to.
 */
export function buildRunIdentityRecord(input: RunIdentityRecordInput): RunIdentityRecord {
  return freezeDeep({
    schemaVersion: RUN_IDENTITY_RECORD_SCHEMA_VERSION,
    runId: input.runId,
    recordedAt: input.recordedAt,
    identity: input.identity,
    config: input.config,
    environment: input.environment,
    compressionConfig: input.compressionConfig,
  });
}

export interface RunManifestInput extends RunIdentityInput {
  /** Lowercase kebab-case label; the current run's manifest is never stored under it. */
  readonly baselineId: string;
  /** ISO-8601 UTC. Supplied by the caller: this module reads no clock. */
  readonly createdAt: string;
  readonly environment: RunEnvironmentRecord;
}

/**
 * The current run as a {@link BaselineManifest}.
 *
 * The comparability gate compares two manifests, and building the current run's
 * side with the same function that builds a stored baseline's is what makes the
 * gate a comparison of two runs rather than of two assemblers
 * (`create-baseline.ts` states the same rule for the stored side).
 */
export function buildRunManifest(input: RunManifestInput): BaselineManifest {
  return freezeDeep({
    schemaVersion: BASELINE_MANIFEST_SCHEMA_VERSION,
    baselineId: input.baselineId,
    createdAt: input.createdAt,
    identity: buildRunIdentity(input),
    suiteVersion: input.config.suiteVersion,
    modelSettings: input.config.modelSettings,
    verifierVersion: ACCEPTANCE_VERIFIER_VERSION,
    metricsVersion: String(MODE_COST_KPI_VERSION),
    environment: input.environment.environment,
    osRelease: input.environment.osRelease,
    toolVersions: input.environment.toolVersions,
  });
}

/**
 * The published summary of a set of stored samples.
 *
 * The aggregates are folded here rather than carried from the run, so the
 * summary of a ledger read back from disk and the summary of the run that wrote
 * it are computed by the same code (BENCH-7, BENCH-11).
 */
export function summarizeSamples(
  samples: readonly BenchmarkSample[],
  identity: BenchmarkIdentity,
  environment: BenchmarkEnvironment,
): BenchmarkRunSummary {
  return {
    identity,
    environment,
    samples,
    aggregates: toModeMetrics(aggregateSamplesByMode(samples)),
  };
}
