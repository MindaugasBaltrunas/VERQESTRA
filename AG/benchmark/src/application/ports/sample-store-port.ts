import type { ExecutionMode, BenchmarkSample } from "../../domain/result.js";

/**
 * A cell that ran but produced no storable sample — most commonly a timeout —
 * kept as a durable trace so it is never only a console warning (task 0028).
 *
 * It is deliberately not a {@link BenchmarkSample}: that schema's `telemetry` is
 * required because a sample without a cost record would be read as a
 * zero-cost measurement, which a cell that never printed one is not (BENCH-5).
 * This record exists precisely for the case a sample cannot represent.
 */
export interface UnmeasuredCellRecord {
  readonly runId: string;
  readonly scenarioId: string;
  readonly mode: ExecutionMode;
  readonly repetition: number;
  /** ISO-8601 UTC, supplied by the caller: this layer reads no clock. */
  readonly recordedAt: string;
  /** `<code>: <detail>`, the same shape a stored sample's failure would carry. */
  readonly reason: string;
  /** Coarse category read off `reason`; `"timeout"` when the scenario's time limit ended the attempt. */
  readonly status: string;
}

/**
 * Append-only sample storage (BENCH-5).
 *
 * `append` must be atomic: a crash mid-write may leave the previous samples
 * intact, never a half-written record that later reads as a real measurement.
 * `readAll` surfaces corrupt records instead of skipping them.
 */
export interface SampleStorePort {
  append(sample: BenchmarkSample): Promise<void>;
  readAll(): Promise<{
    readonly samples: readonly BenchmarkSample[];
    /** One entry per record that failed schema validation, with its position. */
    readonly corruptRecords: readonly string[];
  }>;
  /**
   * Records a cell that produced no storable sample. Optional: an implementation
   * with no durable side channel for this may omit it, and the cell remains
   * visible only through the run's own `unmeasured` list.
   */
  appendUnmeasured?(record: UnmeasuredCellRecord): Promise<void>;
}
