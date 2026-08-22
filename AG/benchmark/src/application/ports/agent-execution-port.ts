import type { BenchmarkScenario } from "../../domain/scenario.js";
import type {
  ExecutionMode,
  SampleCompressionRecord,
  SampleTelemetry,
  SampleUsageRecord,
} from "../../domain/result.js";
import type { NormalizedExecutionPlan } from "./execution-plan.js";
import type { IsolatedWorktree } from "./worktree-port.js";

export interface AgentExecutionRequest {
  readonly scenario: BenchmarkScenario;
  readonly mode: ExecutionMode;
  readonly worktree: IsolatedWorktree;
  /**
   * Explicit opt-in for paid model and network execution. Adapters that would
   * call a model must refuse when this is `false` — a benchmark must not spend
   * money because a default was left on.
   */
  readonly allowNetworkModels: boolean;
}

export interface AgentExecutionOutcome {
  /**
   * Absent exactly when no execution happened, or happened without producing a
   * trustworthy cost record. BENCH-5 would rather have a sample that says its
   * cost is unknown than one carrying a plausible number nobody measured, so a
   * refused, mis-routed or unparsable execution reports nothing here rather than
   * zeros — zeros would average in as a free run.
   */
  readonly telemetry?: SampleTelemetry;
  /**
   * Cost detail `telemetry` does not carry — cache tokens, turns, and whether
   * accounting succeeded at all. Absent when the adapter observed none, which is
   * a different statement from a captured record reporting zeros.
   */
  readonly usage?: SampleUsageRecord;
  /**
   * The compression variant this execution ran under, when it ran under a
   * declared one. Absent means the run belongs to no variant and enters no
   * compression aggregate — it is never folded into the baseline.
   */
  readonly compression?: SampleCompressionRecord;
  readonly durationMs: number;
  /** What the agent said about itself. Recorded as evidence, never as a verdict. */
  readonly agentClaimedDone: boolean;
  /**
   * Set when the adapter did not deliver a clean execution: a refusal, a timeout,
   * a spawn error, a limit exceeded, an unusable telemetry envelope. Formatted as
   * `<code>: <detail>` with `code` drawn from `EXECUTION_FAILURE_CODES`, so a
   * reader downstream can tell a measured failure from the absence of a
   * measurement without parsing prose.
   */
  readonly failure?: string;
  /**
   * What the adapter actually executed, including every way its mode departs from
   * the common plan (BENCH-3). Present whenever a plan could be computed — which
   * is every case except a request the adapter refused before normalizing it.
   */
  readonly plan?: NormalizedExecutionPlan;
}

/**
 * One adapter per execution mode (BENCH-3). Every adapter receives the same
 * scenario, the same limits and the same starting commit; whatever it cannot
 * hold equal is reported, not hidden.
 */
export interface AgentExecutionPort {
  readonly mode: ExecutionMode;
  readonly adapterVersion: string;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionOutcome>;
}
