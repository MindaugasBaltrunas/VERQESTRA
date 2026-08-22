import type { ModeMetrics } from "./metrics.js";
import type { BenchmarkSample, ExecutionMode } from "./result.js";
// Type-only, and deliberately so: `baseline/manifest.ts` reaches back here for
// the identity and environment contracts, and a value import in this direction
// would make the two modules a runtime cycle.
import type { BaselineManifest } from "./baseline/manifest.js";

export type { BaselineManifest, BaselineToolVersion } from "./baseline/manifest.js";

/**
 * Baseline and comparability contract (BENCH-8).
 */

/**
 * The environment fields a comparison is allowed to look at. They are reported
 * beside the verdict rather than folded into the config hash: a different OS
 * makes a comparison weaker, not impossible, and the reader decides.
 */
export interface BenchmarkEnvironment {
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly cpuCount: number;
}

export interface ModelSettings {
  readonly model: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

/**
 * The hashes that decide whether two runs measured the same thing. A mismatch in
 * any of them makes the comparison `inconclusive` — the harness refuses it
 * rather than reporting a difference it cannot attribute.
 */
export interface BenchmarkIdentity {
  readonly suiteHash: string;
  readonly configHash: string;
  readonly policyHash: string;
  readonly agCommit: string;
  /** Adapter version per mode: an adapter change alone can move every number. */
  readonly modeAdapterVersions: Readonly<Record<ExecutionMode, string>>;
}

export interface BenchmarkBaseline {
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly identity: BenchmarkIdentity;
  readonly modelSettings: ModelSettings;
  readonly environment: BenchmarkEnvironment;
  readonly samples: readonly BenchmarkSample[];
  readonly aggregates: readonly ModeMetrics[];
  /**
   * The whole methodology statement the numbers were produced under.
   *
   * The fields above are its published projection and stay where consumers
   * already read them; this is the authoritative record, and it is here because
   * the comparability gate needs fields the projection does not carry — the
   * suite version, the verifier version, the OS release and the tool versions.
   * A baseline that could not state them would have to be compared on the
   * fields it happened to keep, which is a gate that passes for the wrong
   * reason (BENCH-8).
   */
  readonly manifest: BaselineManifest;
}
