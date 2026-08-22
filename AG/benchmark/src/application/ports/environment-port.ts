import type { BenchmarkEnvironment } from "../../domain/baseline.js";

/** Captures the host facts a comparison is allowed to weigh (BENCH-8). */
export interface EnvironmentPort {
  capture(): Promise<BenchmarkEnvironment>;
}

/**
 * Time source. Samples carry timestamps, so a real clock in the runner would
 * make every runner test nondeterministic.
 */
export interface ClockPort {
  nowIso(): string;
}
