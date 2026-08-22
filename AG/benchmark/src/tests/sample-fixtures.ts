import type { BenchmarkSample } from "../domain/result.js";
import { BENCHMARK_SAMPLE_SCHEMA_VERSION } from "../domain/result.js";

/**
 * One schema-valid sample, as the runner would hand it to the store. Tests state
 * only the field they are about; everything else stays at a value the validator
 * accepts, so a failure names the rule under test rather than an unrelated field
 * a test forgot to fill in.
 */
export function validSample(overrides: Partial<BenchmarkSample> = {}): BenchmarkSample {
  return {
    schemaVersion: BENCHMARK_SAMPLE_SCHEMA_VERSION,
    sampleId: "sample-0001",
    scenarioId: "bugfix-session-token-expiry",
    mode: "ag-loop",
    repetition: 1,
    startedAt: "2026-08-06T09:00:00.000Z",
    durationMs: 41_000,
    telemetry: {
      model: "claude-opus-5",
      inputTokens: 18_400,
      outputTokens: 2_100,
      llmCalls: 7,
      attempts: 1,
      repairs: 0,
      humanReviewEvents: 0,
    },
    checks: [{ id: "unit-tests", kind: "test", status: "passed", durationMs: 5_200 }],
    workspace: {
      startCommit: "a".repeat(40),
      endCommit: "b".repeat(40),
      changedFiles: ["src/session-token.mjs"],
      outOfScopeFiles: [],
      cleanup: "removed",
    },
    acceptance: { verdict: "verified-accepted", reasons: [], agentClaimedDone: true },
    ...overrides,
  };
}
