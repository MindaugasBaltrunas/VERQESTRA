import type { BaselineCreationRequest } from "../application/baseline/create-baseline.js";
import { buildBaselineManifest } from "../application/baseline/create-baseline.js";
import type { RunEnvironmentRecord } from "../application/run-environment.js";
import type { BaselineManifest } from "../domain/baseline/manifest.js";
import { SUITE_CONFIG_SCHEMA_VERSION, type BenchmarkSuiteConfig } from "../domain/suite-config.js";
import { validSample } from "./sample-fixtures.js";

/**
 * A baseline the validator accepts, as the runner would seal it. Tests state
 * only the field they are about, so a failure names the rule under test rather
 * than an unrelated field a test forgot to fill in.
 */

export const VALID_SUITE_CONFIG: BenchmarkSuiteConfig = {
  schemaVersion: SUITE_CONFIG_SCHEMA_VERSION,
  suiteVersion: "1.0.0",
  modes: ["ag-loop", "agent-solo"],
  repetitions: 3,
  modelSettings: { model: "claude-opus-5", temperature: 0, maxOutputTokens: 32_000 },
  limits: { timeoutMs: 900_000, tokenLimit: 1_000_000 },
  modeAdapterVersions: {
    "ag-loop": "ag-loop/1",
    "agent-solo": "agent-solo/1",
    "deterministic-control": "deterministic-control/1",
  },
  allowNetworkModels: false,
};

export const VALID_RUN_ENVIRONMENT: RunEnvironmentRecord = {
  environment: { platform: "win32", arch: "x64", nodeVersion: "v22.15.0", cpuCount: 16 },
  osRelease: "Windows_NT 10.0.26200",
  agCommit: "c".repeat(40),
  toolVersions: [
    { tool: "git", version: "git version 2.49.0" },
    { tool: "node", version: "v22.15.0" },
    { tool: "pnpm", version: "9.15.9" },
  ],
};

export function validCreationRequest(
  overrides: Partial<BaselineCreationRequest> = {},
): BaselineCreationRequest {
  return {
    baselineId: "2026-08-07-opus-5",
    createdAt: "2026-08-07T09:00:00.000Z",
    suiteHash: `sha256:${"a".repeat(64)}`,
    suiteVersion: "1.0.0",
    policyHash: `sha256:${"b".repeat(64)}`,
    config: VALID_SUITE_CONFIG,
    environment: VALID_RUN_ENVIRONMENT,
    samples: [validSample()],
    ...overrides,
  };
}

export function validManifest(overrides: Partial<BaselineCreationRequest> = {}): BaselineManifest {
  return buildBaselineManifest(validCreationRequest(overrides));
}

/**
 * A manifest with one field replaced, for the cases a well-formed request
 * cannot express — a hand-edited stored record, or a run whose environment
 * differs from the baseline's.
 */
export function manifestWith(
  overrides: Partial<BaselineManifest>,
  base: BaselineManifest = validManifest(),
): BaselineManifest {
  return { ...base, ...overrides };
}
