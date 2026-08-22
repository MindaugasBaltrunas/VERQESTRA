import type { BaselineManifest } from "../../domain/baseline/manifest.js";
import { compareBenchmark } from "../../domain/comparison/benchmark-comparison.js";
import type { BenchmarkSample } from "../../domain/result.js";
import type { BenchmarkScenario } from "../../domain/scenario.js";
import type { BenchmarkComparison } from "../../domain/verdict.js";
import { guardComparison } from "../baseline/comparability-gate.js";

/**
 * The whole of "compare this run against that baseline" (BENCH-8, BENCH-9).
 *
 * Two steps, in an order that is the point rather than a detail: the
 * comparability gate first, the arithmetic second. Nothing may read a baseline's
 * metrics beside a current run's until the two are established to have measured
 * the same thing, and a refusal is not an error — it is a `BenchmarkComparison`
 * whose verdict is `inconclusive`, so the CLI, the report and the UI publish the
 * same authoritative object whether the comparison happened or not (BENCH-10,
 * BENCH-11).
 *
 * It lives here, above the delivery layer, so that no caller can assemble the
 * second step without the first.
 */

export interface CompareRunsInput {
  /** The suite being compared under; sole authority on which scenarios exist and on their order. */
  readonly scenarios: readonly BenchmarkScenario[];
  readonly baselineManifest: BaselineManifest;
  readonly currentManifest: BaselineManifest;
  readonly baselineSamples: readonly BenchmarkSample[];
  readonly currentSamples: readonly BenchmarkSample[];
}

export function compareRuns(input: CompareRunsInput): BenchmarkComparison {
  const gate = guardComparison(input.baselineManifest, input.currentManifest);
  if (!gate.ok) return gate.comparison;
  return compareBenchmark({
    scenarios: input.scenarios,
    baselineSamples: input.baselineSamples,
    currentSamples: input.currentSamples,
    // The gate's advisory differences stay in front of the comparison's own, so
    // a reader meets "these two hosts differ" before "this scenario got slower".
    limitations: gate.limitations,
  });
}
