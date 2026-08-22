import type { ExecutionMode } from "./result.js";

/**
 * Statistics and regression contract (BENCH-9).
 */
export const COMPARISON_VERDICTS = ["improved", "stable", "regressed", "inconclusive"] as const;

export type ComparisonVerdict = (typeof COMPARISON_VERDICTS)[number];

/**
 * The full shape of a repeated measurement. Median and spread are reported next
 * to the mean because three runs of a nondeterministic scenario can average to a
 * number no single run ever produced.
 */
export interface DistributionStatistics {
  readonly count: number;
  readonly median: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly standardDeviation: number;
  /** How many of `count` runs reached `verified-accepted`. */
  readonly successCount: number;
}

export interface ScenarioComparison {
  readonly scenarioId: string;
  readonly mode: ExecutionMode;
  readonly baseline: DistributionStatistics;
  readonly current: DistributionStatistics;
  readonly verdict: ComparisonVerdict;
  readonly reasons: readonly string[];
}

export interface BenchmarkComparison {
  /**
   * The overall verdict. A new security or out-of-scope violation is a
   * regression regardless of how the cost metrics moved (BENCH-9).
   */
  readonly verdict: ComparisonVerdict;
  readonly reasons: readonly string[];
  readonly scenarios: readonly ScenarioComparison[];
  /**
   * What this comparison cannot claim — thin denominators, missing baseline
   * counterparts, environment differences. Reports must show these (BENCH-10).
   */
  readonly limitations: readonly string[];
}
