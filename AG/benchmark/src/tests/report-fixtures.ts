import type { BenchmarkRunSummary } from "../application/benchmark-api.js";
import { summarizeStoredSamples } from "../application/report/benchmark-report-model.js";
import type { BenchmarkBaseline, BenchmarkIdentity } from "../domain/baseline.js";
import type { BenchmarkSample } from "../domain/result.js";
import { manifestWith, validManifest } from "./baseline-fixtures.js";
import { validSample } from "./sample-fixtures.js";

/**
 * Report inputs a test can state one field of.
 *
 * Everything the report layer reads is present and plausible, so a failing
 * assertion names the rule under test rather than a field the test forgot.
 */

export const REPORT_SUITE_HASH = `sha256:${"1".repeat(64)}`;
export const REPORT_CONFIG_HASH = `sha256:${"2".repeat(64)}`;
export const REPORT_POLICY_HASH = `sha256:${"3".repeat(64)}`;

export function reportIdentity(overrides: Partial<BenchmarkIdentity> = {}): BenchmarkIdentity {
  return {
    suiteHash: REPORT_SUITE_HASH,
    configHash: REPORT_CONFIG_HASH,
    policyHash: REPORT_POLICY_HASH,
    agCommit: "d".repeat(40),
    modeAdapterVersions: {
      "ag-loop": "ag-loop/1",
      "agent-solo": "agent-solo/1",
      "deterministic-control": "deterministic-control/1",
    },
    ...overrides,
  };
}

export const REPORT_ENVIRONMENT = {
  platform: "linux",
  arch: "x64",
  nodeVersion: "v22.15.0",
  cpuCount: 8,
} as const;

/**
 * Three repetitions of one scenario in one mode, so a nondeterministic scenario
 * meets BENCH-9's floor and the distribution has a median that is not its mean.
 */
export function tokenSamples(
  tokens: readonly number[],
  overrides: Partial<BenchmarkSample> = {},
): readonly BenchmarkSample[] {
  return tokens.map((total, index) =>
    validSample({
      sampleId: `sample-${String(index + 1).padStart(4, "0")}`,
      repetition: index + 1,
      telemetry: { ...validSample().telemetry, inputTokens: total, outputTokens: 0 },
      ...overrides,
    }),
  );
}

export function runSummary(
  samples: readonly BenchmarkSample[],
  identity: BenchmarkIdentity = reportIdentity(),
): BenchmarkRunSummary {
  return summarizeStoredSamples({ identity, environment: REPORT_ENVIRONMENT, samples });
}

export function baselineDocument(
  samples: readonly BenchmarkSample[],
  identity: BenchmarkIdentity = reportIdentity(),
): BenchmarkBaseline {
  const summary = runSummary(samples, identity);
  const modelSettings = { model: "claude-opus-5", temperature: 0, maxOutputTokens: 32_000 };
  return {
    schemaVersion: 1,
    createdAt: "2026-08-07T09:00:00.000Z",
    identity: summary.identity,
    modelSettings,
    environment: summary.environment,
    samples: summary.samples,
    aggregates: summary.aggregates,
    // The projection above and the manifest state the same methodology; the
    // fixture keeps them consistent so a report test never sees a baseline whose
    // two halves disagree.
    manifest: manifestWith(
      {
        createdAt: "2026-08-07T09:00:00.000Z",
        identity: summary.identity,
        modelSettings,
        environment: summary.environment,
      },
      validManifest(),
    ),
  };
}
