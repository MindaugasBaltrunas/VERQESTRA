import type { AgentExecutionPort } from "../../application/ports/agent-execution-port.js";
import type { AgentProcessPort } from "../../application/ports/agent-process-port.js";
import type {
  ExecutionPlanSettings,
  NormalizedExecutionPlan,
} from "../../application/ports/execution-plan.js";
import type { SampleTelemetry } from "../../domain/result.js";
import {
  ProcessExecutionAdapter,
  type AgentInvocation,
} from "./execution-adapter-support.js";

/**
 * The `ag-loop` mode: the scenario is handed to the full AG Loop, which supervises
 * an execution agent through preflight, dispatch, quality gates, diagnosis,
 * retries and human review (BENCH-3).
 *
 * The adapter drives the loop as a process and reads back one cost record. It
 * does not import AG orchestrator source: BENCH-1 allows the benchmark to use
 * documented AG contracts and forbids treating an internal module as an
 * unofficial API, and a benchmark that linked against the implementation it
 * measures would keep passing while the shipped command line broke.
 *
 * What makes this mode different from the others is a whole retry layer, and the
 * cost record reflects that: one sample can cover several dispatches, so the
 * counters are sums rather than single readings. That is declared in the mode's
 * execution profile, so a comparison against `agent-solo` reads as "loop cost
 * including repairs against one attempt" rather than as a like-for-like ratio.
 */

/**
 * Bumped to `/2` by task 0029: the mode's telemetry-reading contract now accepts
 * the version-2 envelope and its `usage` and `compression` blocks. An adapter
 * change alone can move every number in a report, so it is part of the
 * configuration a baseline is compared under.
 *
 * Task 0027 did *not* bump it, and the trigger for the next bump is recorded here
 * so the decision is not re-argued. The bounded-benchmark-cell marker that task
 * added is injected in `agent-invocation-builders.ts`, so this adapter's
 * telemetry-reading contract is unchanged; and a driven cell cannot reach
 * `handleEmptyQueue` today, so what a sample measures is unchanged too. Bump to
 * `ag-loop/3` in the same change that makes the drive path route through
 * `ag loop`: from that moment the marker changes what a sample measures, and a
 * baseline taken before it is no longer comparable with one taken after.
 */
/**
 * `/3` (2026-08-22): the mode now drives a FULL cycle rather than one bounded agent call.
 *
 * Until then the same driver served both this mode and `agent-solo` — one headless `claude`
 * invocation with `attempts`, `repairs` and `humanReviewEvents` written in as the constants
 * 1, 0, 0. The evidence was in plain sight: that one envelope satisfied both
 * `verifyLoopTelemetry` and `verifySoloTelemetry`, which cannot both be true of a loop and of
 * the thing a loop is compared against. A comparison drawn then measured the same agent twice.
 *
 * The bump is not bookkeeping. An adapter change can move every number in a report, so it is
 * part of the configuration a baseline is compared under, and a `/2` baseline must be refused
 * here rather than silently subtracted from a `/3` run.
 */
/**
 * `/4` (2026-08-27): the drive path now hands the cell a task that is already signed
 * `HUMAN-REVIEW-APPROVED`.
 *
 * The `/3` note above named the trigger for the next bump — a change to the drive path that moves
 * what a sample measures — and this is one. On 2026-08-26 eight scenarios (all three repetitions
 * each) produced `attempts=0`: the loop parked the task in human-review before its first dispatch,
 * so the mode covered 16 of 24 scenarios. A suite scenario is a human-authored, reviewed and
 * locked artefact, so the cell now presents that approval instead of re-deriving it from keywords,
 * and those cells run.
 *
 * That moves numbers in two directions at once, which is why a `/3` baseline must be refused here
 * rather than subtracted: the ag-loop population grows by eight scenarios, and `humanReviewRate`
 * loses the keyword-gate share it used to include. The gate rules themselves are untouched — the
 * difference is declared as `approval-preapplied` in this mode's execution profile (BENCH-3).
 */
export const AG_LOOP_ADAPTER_VERSION = "ag-loop/4";

export interface AgLoopExecutionAdapterOptions {
  readonly settings: ExecutionPlanSettings;
  readonly processes: AgentProcessPort;
  /**
   * Builds the command line that runs one bounded loop over the scenario's
   * checkout. Supplied by the caller because the concrete `ag` invocation is a
   * wiring decision owned by the CLI, not a fact about the mode.
   */
  readonly invocation: (plan: NormalizedExecutionPlan) => AgentInvocation;
  readonly monotonicMs?: () => number;
}

/**
 * The invariants the stored-sample schema enforces, checked here instead of at
 * the store.
 *
 * The rules are the same two — tokens imply an LLM call, and every repair is
 * itself an attempt after the first unrepaired one — but where they are applied
 * decides what the operator gets. Caught at the store, the run is already over
 * and a whole sample is lost to a validation error long after the tokens were
 * spent. Caught here, the same record becomes an ordinary adapter failure that
 * names the mode and the contradiction while the run is still going.
 */
function verifyLoopTelemetry(telemetry: SampleTelemetry): string {
  if (telemetry.llmCalls === 0 && telemetry.inputTokens + telemetry.outputTokens > 0) {
    return "the loop reported tokens without a single LLM call, so the cost record does not add up";
  }
  if (telemetry.attempts === 0 && telemetry.llmCalls > 0) {
    return `the loop reported ${telemetry.llmCalls} LLM call(s) against no attempt at all; a call is made inside an attempt`;
  }
  if (telemetry.attempts === 0 && telemetry.repairs > 0) {
    return `the loop reported ${telemetry.repairs} repair(s) against no attempt at all; a repair is itself an attempt`;
  }
  // `repairs < attempts` is a rule about a loop that ran, and it is stated as `>=` so a repair
  // without a preceding attempt is caught. Applied to zero attempts it caught something else: a
  // loop that refused BEFORE dispatch — a deterministic risk gate turning down a request to log
  // secrets, say — attempted nothing, repaired nothing, and spent nothing. `0 >= 0` read that as a
  // contradiction and threw away the sample. It is not a contradiction; it is the cheapest correct
  // outcome a loop has, and on a `security-violation` scenario it is the outcome under test.
  if (telemetry.attempts > 0 && telemetry.repairs >= telemetry.attempts) {
    return `the loop reported ${telemetry.repairs} repairs against ${telemetry.attempts} attempts; repairs stay below attempts, because every repair is itself an attempt`;
  }
  return "";
}

export function createAgLoopExecutionAdapter(
  options: AgLoopExecutionAdapterOptions,
): AgentExecutionPort {
  return new ProcessExecutionAdapter({
    mode: "ag-loop",
    adapterVersion: AG_LOOP_ADAPTER_VERSION,
    settings: options.settings,
    processes: options.processes,
    invocation: options.invocation,
    verifyTelemetry: verifyLoopTelemetry,
    // The one mode that can reach a terminal decision without dispatching anything. Bounded by
    // `verifyLoopTelemetry` above: a call or a repair reported against zero attempts is still a
    // contradiction, and still refused.
    allowRefusalWithoutAttempt: true,
    ...(options.monotonicMs === undefined ? {} : { monotonicMs: options.monotonicMs }),
  });
}
