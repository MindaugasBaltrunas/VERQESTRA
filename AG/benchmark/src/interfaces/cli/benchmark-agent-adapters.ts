// Which execution adapters this installation can actually drive.
//
// One decision, stated once: the deterministic control is always available because it needs
// nothing, and each networked mode appears only when a caller supplied the command line that
// drives it. That is what makes a paid run something someone asked for rather than something a
// default arranged, and it is why an installation with no invocations still runs the whole offline
// cycle.

import type { AgentExecutionPort } from "../../application/ports/agent-execution-port.js";
import type { ExecutionPlanSettings } from "../../application/ports/execution-plan.js";
import type { ExecutionMode } from "../../domain/result.js";
import { createAgLoopExecutionAdapter } from "../../infrastructure/adapters/ag-loop-execution-adapter.js";
import { createAgentSoloExecutionAdapter } from "../../infrastructure/adapters/agent-solo-execution-adapter.js";
import { DeterministicControlAdapter } from "../../infrastructure/adapters/deterministic-control-adapter.js";
import type { AgentInvocation } from "../../infrastructure/adapters/execution-adapter-support.js";
import { NodeAgentProcessRunner } from "../../infrastructure/adapters/node-agent-process-runner.js";
import { NodeWorkspaceFileWriter } from "../../infrastructure/adapters/node-workspace-file-writer.js";
import type { NormalizedExecutionPlan } from "../../application/ports/execution-plan.js";

/** See `AgentInvocationBuilder` on the composition; repeated as a type only, not as a decision. */
type InvocationBuilder = (plan: NormalizedExecutionPlan) => AgentInvocation;

export function createAgentAdapters(
  settings: ExecutionPlanSettings,
  invocations: Partial<Record<ExecutionMode, InvocationBuilder>> | undefined,
): readonly AgentExecutionPort[] {
  const processes = new NodeAgentProcessRunner();
  const adapters: AgentExecutionPort[] = [
    new DeterministicControlAdapter({ settings, files: new NodeWorkspaceFileWriter() }),
  ];
  const agLoop = invocations?.["ag-loop"];
  if (agLoop !== undefined) {
    adapters.push(createAgLoopExecutionAdapter({ settings, processes, invocation: agLoop }));
  }
  const agentSolo = invocations?.["agent-solo"];
  if (agentSolo !== undefined) {
    adapters.push(createAgentSoloExecutionAdapter({ settings, processes, invocation: agentSolo }));
  }
  return adapters;
}
