import {
  sealBaselineDocument,
  serializeBaselineDocument,
  validateBaselineDocument,
  type BaselineDocument,
} from "../../domain/baseline/document.js";
import {
  ACCEPTANCE_VERIFIER_VERSION,
  BASELINE_MANIFEST_SCHEMA_VERSION,
  computeSuiteConfigHash,
  freezeDeep,
  type BaselineManifest,
} from "../../domain/baseline/manifest.js";
import { MODE_COST_KPI_VERSION } from "../../domain/metrics/aggregate.js";
import type { BenchmarkSample } from "../../domain/result.js";
import type { BenchmarkSuiteConfig } from "../../domain/suite-config.js";
import type { ValidationResult } from "../../domain/validation.js";
import type { RunEnvironmentRecord } from "../run-environment.js";

/**
 * Baseline creation (BENCH-8).
 *
 * The one place a manifest is assembled. Both sides of a comparison are built
 * here — the stored baseline and the run being judged against it — because a
 * gate that compares two records assembled by different code compares the two
 * assemblers as much as the two runs.
 *
 * The config hash is computed rather than accepted: a caller that could hand in
 * its own could hand in the baseline's, and the comparability gate would then
 * approve a comparison between two different configurations. The suite hash is
 * accepted, because it is produced by the suite validator, which is the only
 * component that has seen the scenario files.
 */

export interface BaselineCreationRequest {
  /** Lowercase kebab-case label the report and the file name refer to, e.g. `2026-08-07-opus-5`. */
  readonly baselineId: string;
  /** ISO-8601 UTC. Supplied by the caller: this module reads no clock, so its output is reproducible. */
  readonly createdAt: string;
  /** `computeScenarioSuiteHash` of the validated suite the samples were taken from. */
  readonly suiteHash: string;
  readonly suiteVersion: string;
  /** Identity of the AG policy set the run executed under, in canonical digest form. */
  readonly policyHash: string;
  readonly config: BenchmarkSuiteConfig;
  readonly environment: RunEnvironmentRecord;
  /** Defaults to {@link ACCEPTANCE_VERIFIER_VERSION}; stated only when replaying older samples. */
  readonly verifierVersion?: string;
  readonly samples: readonly BenchmarkSample[];
}

/**
 * The immutable manifest for one run. Sealed on the way out: a manifest a
 * consumer can edit is a methodology statement that cannot be relied on.
 */
export function buildBaselineManifest(request: BaselineCreationRequest): BaselineManifest {
  return freezeDeep({
    schemaVersion: BASELINE_MANIFEST_SCHEMA_VERSION,
    baselineId: request.baselineId,
    createdAt: request.createdAt,
    identity: {
      suiteHash: request.suiteHash,
      configHash: computeSuiteConfigHash(request.config),
      policyHash: request.policyHash,
      agCommit: request.environment.agCommit,
      modeAdapterVersions: request.config.modeAdapterVersions,
    },
    suiteVersion: request.suiteVersion,
    modelSettings: request.config.modelSettings,
    verifierVersion: request.verifierVersion ?? ACCEPTANCE_VERIFIER_VERSION,
    metricsVersion: String(MODE_COST_KPI_VERSION),
    environment: request.environment.environment,
    osRelease: request.environment.osRelease,
    toolVersions: request.environment.toolVersions,
  });
}

/**
 * The document a baseline is stored as, or the reasons it may not be stored.
 *
 * The sealed document is written to its own serialized form and read back
 * through the validator before it is returned, so a baseline exists only if it
 * can be read: an unattributable AG commit, a `baselineId` no file name can
 * carry, a sample the schema refuses or a timestamp in local time are all
 * reported here rather than at the next comparison, months later, when the run
 * that produced them can no longer be repeated.
 */
export function createBaselineDocument(
  request: BaselineCreationRequest,
): ValidationResult<BaselineDocument> {
  const sealed = sealBaselineDocument(buildBaselineManifest(request), request.samples);
  return validateBaselineDocument(JSON.parse(serializeBaselineDocument(sealed)));
}
