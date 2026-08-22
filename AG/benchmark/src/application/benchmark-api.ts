import type { BenchmarkBaseline, BenchmarkIdentity, BenchmarkEnvironment } from "../domain/baseline.js";
import type { ModeMetrics } from "../domain/metrics.js";
import type { BenchmarkSample, ExecutionMode } from "../domain/result.js";
import type { BenchmarkComparison } from "../domain/verdict.js";

// Delivery sluoksniai (CLI/HTTP) kalba TIK su šiuo API moduliu (BENCH-1, BENCH-11), todėl
// domeno kontraktai, kurių jiems reikia parsingui ir atvaizdavimui, re-eksportuojami čia —
// interfaces -> domain importas yra draudžiama priklausomybės kryptis.
export { EXECUTION_MODES } from "../domain/result.js";
// Import + re-export (ne vien `export ... from`): tipas naudojamas ir šio modulio
// deklaracijose (BenchmarkRunSummary.unmeasured), o grynas re-eksportas vardo į
// modulio scope neįveda.
import type { UnmeasuredCell } from "./run/execute-benchmark-run.js";
export type { UnmeasuredCell };
export { MINIMUM_NONDETERMINISTIC_OBSERVATIONS } from "../domain/statistics/scenario-observations.js";
export type {
  BaselineManifest,
  BaselineToolVersion,
  BenchmarkBaseline,
  BenchmarkIdentity,
  BenchmarkEnvironment,
} from "../domain/baseline.js";
export type { BenchmarkSample, ExecutionMode } from "../domain/result.js";
export type { BenchmarkComparison } from "../domain/verdict.js";
export type { BenchmarkScenario, ScenarioSuite } from "../domain/scenario.js";

/**
 * The single public entry point of this package.
 *
 * The AG orchestrator's CLI and HTTP layers call this API and nothing else —
 * they never reach into `infrastructure` or recompute an authoritative number of
 * their own (BENCH-1, BENCH-11).
 */

export interface SuiteValidationReport {
  readonly suiteHash: string;
  readonly scenarioCount: number;
  /** Empty means valid. Validation is fail-closed: an unreadable suite is a problem, not an empty suite. */
  readonly problems: readonly string[];
}

export interface BenchmarkRunRequest {
  readonly modes: readonly ExecutionMode[];
  /** Omitted means the whole suite. */
  readonly scenarioIds?: readonly string[];
  /** BENCH-9 requires at least 3 for nondeterministic scenarios. */
  readonly repetitions: number;
  /** Paid model and network execution stay off unless the caller says otherwise. */
  readonly allowNetworkModels: boolean;
}

export interface BenchmarkRunSummary {
  readonly identity: BenchmarkIdentity;
  readonly environment: BenchmarkEnvironment;
  readonly samples: readonly BenchmarkSample[];
  readonly aggregates: readonly ModeMetrics[];
  /**
   * Cells of the plan that produced no measurement — a checkout that could not
   * be made, an adapter that threw, an execution with no cost record.
   *
   * Present on the summary a `run` returns and absent on one read back from a
   * ledger, because a ledger records what happened rather than what did not.
   * They are carried rather than counted so a caller can say *which* cells are
   * missing: a suite that scored badly and a harness that did not run produce
   * the same sample count, and only this list tells them apart (BENCH-5).
   */
  readonly unmeasured?: readonly UnmeasuredCell[];
}

/**
 * What a run would do, resolved against the frozen suite but not executed
 * (BENCH-10 `--dry-run`).
 *
 * The plan exists so the delivery layer can stay thin. A CLI that computed
 * "twenty scenarios times three modes times three repetitions" itself would hold
 * a second copy of the suite rules — one that keeps working after the real rules
 * change, and answers with a plan the runner would never carry out.
 */
export interface BenchmarkRunPlan {
  /** Empty exactly when the suite was refused; a plan against an invalid suite names nothing. */
  readonly suiteHash: string;
  readonly scenarioIds: readonly string[];
  readonly modes: readonly ExecutionMode[];
  readonly repetitions: number;
  readonly allowNetworkModels: boolean;
  /** Scenarios times modes times repetitions: what this run would cost in samples. */
  readonly sampleCount: number;
  /**
   * Why the run cannot proceed as asked: an unknown scenario id, a network mode
   * without permission, too few repetitions for a nondeterministic scenario.
   * Non-empty means `run` would refuse, so a dry run reports it before anything
   * is spent.
   */
  readonly problems: readonly string[];
}

export interface BenchmarkCompareRequest {
  readonly baseline: BenchmarkBaseline;
  readonly current: BenchmarkRunSummary;
}

export const BENCHMARK_REPORT_FORMATS = ["json", "markdown"] as const;

export type BenchmarkReportFormat = (typeof BENCHMARK_REPORT_FORMATS)[number];

export interface BenchmarkReportRequest {
  readonly format: BenchmarkReportFormat;
  readonly summary: BenchmarkRunSummary;
  readonly comparison?: BenchmarkComparison;
}

export interface BenchmarkReportDocument {
  readonly format: BenchmarkReportFormat;
  /** Deterministic for identical inputs (BENCH-10): no timestamps or ordering the inputs did not fix. */
  readonly content: string;
  readonly generatedFrom: BenchmarkIdentity;
}

/**
 * Raised when a command needs an executed run and no run has been executed.
 *
 * `baseline create`, `compare` and `report` all describe the current run, and
 * there is no honest answer to any of them before one exists. An empty summary
 * would be the dishonest one: it is indistinguishable from a run that measured
 * nothing, and BENCH-5 exists to keep an absent measurement from reading as a
 * real one. The message names the command that produces what is missing, so the
 * refusal points at the next step rather than at a dead end.
 */
export class BenchmarkRunNotExecutedError extends Error {
  constructor(readonly action: string) {
    super(
      `no executed run to ${action}: this benchmark package holds no run ledger. ` +
        "Execute `ag benchmark run` first; nothing was read and nothing was written.",
    );
    this.name = "BenchmarkRunNotExecutedError";
  }
}

/**
 * Raised when a run was asked for that the resolved plan refuses.
 *
 * The plan is consulted before anything is spent, so a refusal here means
 * nothing was executed, nothing was stored and nothing was paid for — the
 * difference between a rejected request and a half-spent one.
 */
export class BenchmarkRunRefusedError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `the run was refused before anything was executed: ${problems.join("; ")}`,
    );
    this.name = "BenchmarkRunRefusedError";
  }
}

export interface BenchmarkApplicationApi {
  validate(): Promise<SuiteValidationReport>;
  /** Resolves a request against the suite without executing it (BENCH-10 `--dry-run`). */
  plan(request: BenchmarkRunRequest): Promise<BenchmarkRunPlan>;
  run(request: BenchmarkRunRequest): Promise<BenchmarkRunSummary>;
  createBaseline(summary: BenchmarkRunSummary): Promise<BenchmarkBaseline>;
  compare(request: BenchmarkCompareRequest): Promise<BenchmarkComparison>;
  report(request: BenchmarkReportRequest): Promise<BenchmarkReportDocument>;
  /** Re-derives acceptance for already stored samples, without executing an agent. */
  verify(samples: readonly BenchmarkSample[]): Promise<BenchmarkRunSummary>;
}
