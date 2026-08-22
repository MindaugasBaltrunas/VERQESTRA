import type { RecordedCompressionConfig } from "../application/ports/compression-config-port.js";
import type { RunIdentityRecord } from "../application/ports/run-identity-store-port.js";
import {
  buildRunConfiguration,
  buildRunIdentity,
  buildRunIdentityRecord,
  type RunConfigurationInput,
} from "../application/run/run-identity.js";
import type { RunEnvironmentRecord } from "../application/run-environment.js";
import {
  COMPRESSION_CONFIG_SOURCE,
  computeCompressionConfigDigest,
  projectCompressionConfigView,
} from "../domain/compression/config-identity.js";

/**
 * What a run states about itself, as a fixture (BENCH-8, task 1205).
 *
 * Built through {@link buildRunConfiguration} and {@link buildRunIdentityRecord}
 * rather than written out by hand, so the record's self-hash check holds by
 * construction. A fixture carrying a copied digest would pass today and would
 * start failing every reader the moment the configuration projection moved —
 * which is a fact about the fixture, not about the rule under test.
 */

export const RUN_IDENTITY_SUITE_HASH = `sha256:${"a".repeat(64)}`;
export const RUN_IDENTITY_POLICY_HASH = `sha256:${"b".repeat(64)}`;
export const RUN_IDENTITY_COMMIT = "c".repeat(40);

/** A run id of the shape `createRunId` forms, so the fixture and a real run read alike. */
export const RUN_IDENTITY_RUN_ID = "run-20260811t090000000z";

export const RUN_IDENTITY_ENVIRONMENT: RunEnvironmentRecord = {
  environment: { platform: "linux", arch: "x64", nodeVersion: "v22.15.0", cpuCount: 8 },
  osRelease: "Linux 6.8.0",
  agCommit: RUN_IDENTITY_COMMIT,
  toolVersions: [{ tool: "node", version: "v22.15.0" }],
};

/**
 * A compression configuration document of the shape the orchestrator's carries,
 * with one flag in each of the three states a flag may be authored in — the real
 * file may carry a canary rollout, and a fixture that never did would let a
 * projection that flattens one pass every reader test.
 */
export const COMPRESSION_CONFIG_DOCUMENT: Record<string, unknown> = {
  version: 1,
  features: { worker_task_ir: true, compact_dsl: false, symbol_slices: "canary" },
  canary: { percent: 25, salt: "ag-loop-canary" },
};

/**
 * A configuration that was read, digested and projected by the same functions the
 * reader uses — the state a real run records on a host that has the file.
 */
export function readCompressionConfig(
  document: unknown = COMPRESSION_CONFIG_DOCUMENT,
): RecordedCompressionConfig {
  return {
    state: "read",
    source: COMPRESSION_CONFIG_SOURCE,
    digest: computeCompressionConfigDigest(document),
    view: projectCompressionConfigView(document),
  };
}

export function runConfigurationInput(
  overrides: Partial<RunConfigurationInput> = {},
): RunConfigurationInput {
  return {
    suiteVersion: "1.0.0",
    modes: ["deterministic-control"],
    repetitions: 1,
    allowNetworkModels: false,
    modeAdapterVersions: {
      "ag-loop": "ag-loop/1",
      "agent-solo": "agent-solo/1",
      "deterministic-control": "deterministic-control/1",
    },
    ...overrides,
  };
}

export interface RunIdentityRecordOverrides {
  readonly runId?: string;
  readonly recordedAt?: string;
  readonly suiteHash?: string;
  readonly policyHash?: string;
  readonly agCommit?: string;
  /** Fields of the configuration the `configHash` is taken over. */
  readonly configuration?: Partial<RunConfigurationInput>;
  readonly environment?: RunEnvironmentRecord;
  readonly compressionConfig?: RecordedCompressionConfig;
}

/** One valid record; a test states only the field it is about. */
export function runIdentityRecord(overrides: RunIdentityRecordOverrides = {}): RunIdentityRecord {
  const config = buildRunConfiguration(runConfigurationInput(overrides.configuration ?? {}));
  return buildRunIdentityRecord({
    runId: overrides.runId ?? RUN_IDENTITY_RUN_ID,
    recordedAt: overrides.recordedAt ?? "2026-08-11T09:00:00.000Z",
    identity: buildRunIdentity({
      config,
      suiteHash: overrides.suiteHash ?? RUN_IDENTITY_SUITE_HASH,
      policyHash: overrides.policyHash ?? RUN_IDENTITY_POLICY_HASH,
      agCommit: overrides.agCommit ?? RUN_IDENTITY_COMMIT,
    }),
    config,
    environment: overrides.environment ?? RUN_IDENTITY_ENVIRONMENT,
    compressionConfig: overrides.compressionConfig ?? readCompressionConfig(),
  });
}
