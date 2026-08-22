import type { ExecutionMode } from "./result.js";

/**
 * Aggregate contract (BENCH-7).
 *
 * Every metric is a ratio over samples that qualify for its denominator. A zero
 * denominator is `undefined` — reporting `0` there would read as "measured and
 * bad" when the truth is "not measured".
 */
export type Ratio = number | undefined;

/** Cost per change. `undefined` when no change of that class was produced at all. */
export type CostPerChange = number | undefined;

export interface CostMetrics {
  readonly tokens: CostPerChange;
  readonly durationMs: CostPerChange;
  readonly llmCalls: CostPerChange;
}

export interface BenchmarkMetrics {
  readonly sampleCount: number;
  /** Samples whose evidence was incomplete or corrupt; they never enter a rate's numerator. */
  readonly inconclusiveCount: number;
  readonly acceptedRate: Ratio;
  /** Accepted on the first attempt, with no repair dispatch. */
  readonly firstPassRate: Ratio;
  readonly repairRate: Ratio;
  readonly humanReviewRate: Ratio;
  readonly outOfScopeRate: Ratio;
  readonly testFailureRate: Ratio;
  readonly architectureFailureRate: Ratio;
  readonly securityFailureRate: Ratio;
  /** Cost per accepted change — the agent's own success claim as the denominator. */
  readonly perAcceptedChange: CostMetrics;
  /** Cost per independently verified accepted change — the authoritative headline number. */
  readonly perVerifiedAcceptedChange: CostMetrics;
}

/** Aggregates are always reported per mode; a mode-blind average would hide the comparison. */
export interface ModeMetrics {
  readonly mode: ExecutionMode;
  readonly metrics: BenchmarkMetrics;
}
