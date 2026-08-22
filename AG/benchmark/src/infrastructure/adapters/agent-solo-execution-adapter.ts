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
 * The `agent-solo` mode: the same execution agent, the same model and the same
 * task text, with no loop above it (BENCH-3).
 *
 * This is the comparison the whole benchmark turns on, so the adapter is
 * deliberately the same code as the loop adapter with one thing removed. Anything
 * else the two adapters did differently — a different prompt normalization, a
 * different limit, a different way of reading cost — would show up in the results
 * as an effect of the loop.
 */

/** Bumped to `/2` with the loop adapter: both read the version-2 telemetry envelope (task 0029). */
export const AGENT_SOLO_ADAPTER_VERSION = "agent-solo/2";

export interface AgentSoloExecutionAdapterOptions {
  readonly settings: ExecutionPlanSettings;
  readonly processes: AgentProcessPort;
  /** Builds the command line that runs the agent once over the scenario's checkout. */
  readonly invocation: (plan: NormalizedExecutionPlan) => AgentInvocation;
  readonly monotonicMs?: () => number;
}

/**
 * The mode declares it has no retry, repair or review layer, and that claim is
 * what its zeros mean in every ratio the report computes. A cost record
 * contradicting it is rejected rather than recorded: if the tool being measured
 * does have a retry layer, `agent-solo` is not the mode it should be measured
 * under, and silently accepting the numbers would credit the loop with a
 * difference that was never there.
 */
function verifySoloTelemetry(telemetry: SampleTelemetry): string {
  const contradictions: string[] = [];
  if (telemetry.attempts !== 1) contradictions.push(`${telemetry.attempts} attempts`);
  if (telemetry.repairs !== 0) contradictions.push(`${telemetry.repairs} repairs`);
  if (telemetry.humanReviewEvents !== 0) {
    contradictions.push(`${telemetry.humanReviewEvents} human-review events`);
  }
  if (contradictions.length === 0) return "";
  return `the solo mode has no retry, repair or review layer, but the agent reported ${contradictions.join(", ")}`;
}

export function createAgentSoloExecutionAdapter(
  options: AgentSoloExecutionAdapterOptions,
): AgentExecutionPort {
  return new ProcessExecutionAdapter({
    mode: "agent-solo",
    adapterVersion: AGENT_SOLO_ADAPTER_VERSION,
    settings: options.settings,
    processes: options.processes,
    invocation: options.invocation,
    verifyTelemetry: verifySoloTelemetry,
    ...(options.monotonicMs === undefined ? {} : { monotonicMs: options.monotonicMs }),
  });
}
