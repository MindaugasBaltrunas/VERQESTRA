// Autoritetinga dispatch tapatybė iš CLI argumentų, task failo ir attempt manifesto
// (etalonas: interfaces/cli/claude-dispatch/dispatch-invocation.ts 1:1). Jokių globalių
// process/console mutacijų — atsisakymą ir įspėjimus apdoroja CLI sluoksnis.

import path from "node:path";
import { isRepairDispatchPrompt } from "../../../../application/task-execution/execution-context-gate.js";
import type { ClaudeDispatchPorts, DispatchAttemptView, DispatchDecision } from "./dispatch-ports.js";

export type PrepareDispatchInvocationResult =
  | { kind: "refuse"; message: string; logLine?: string }
  | {
      kind: "ready";
      taskFile: string;
      rawTaskText: string;
      dispatchPhase: "repair" | "implementation";
      taskId: string;
      decision: DispatchDecision;
      selected: string;
      active?: DispatchAttemptView;
      warnings: string[];
    };

export async function prepareDispatchInvocation(
  args: string[],
  ports: Pick<
    ClaudeDispatchPorts,
    "resolveExistingTaskFile" | "readOptionalFile" | "readCurrentTaskId" | "resolveAttempt"
  >,
): Promise<PrepareDispatchInvocationResult> {
  const taskFileArg = args[0];
  if (!taskFileArg) {
    return { kind: "refuse", message: "Usage: verqestra claude-dispatch <task-file>" };
  }

  let taskFile: string;
  try {
    taskFile = await ports.resolveExistingTaskFile(taskFileArg);
  } catch (error) {
    return { kind: "refuse", message: error instanceof Error ? error.message : String(error) };
  }

  const taskIdArgIndex = args.indexOf("--task-id");
  const taskIdArg = taskIdArgIndex >= 0 ? args[taskIdArgIndex + 1]?.trim() || undefined : undefined;
  let decision: DispatchDecision = {};
  const rawTaskText = await ports.readOptionalFile(taskFile);
  const dispatchPhase: "repair" | "implementation" = isRepairDispatchPrompt(rawTaskText) ? "repair" : "implementation";
  const taskFileId = path.basename(taskFile, path.extname(taskFile));
  const decisionTaskId = taskIdArg ?? decision.task_id?.trim();
  const resolved = await ports.resolveAttempt({
    taskId: decisionTaskId || taskFileId,
    phase: dispatchPhase,
    taskFile,
  });
  const active = resolved.attempt;
  const warnings = [...resolved.warnings];

  let taskId: string;
  if (active) {
    taskId = active.taskId;
  } else {
    const currentTaskId = await ports.readCurrentTaskId();
    taskId = decisionTaskId || currentTaskId.trim() || taskFileId;
  }

  if (active) {
    const attemptDecision = await active.readDecision();
    if (attemptDecision.kind === "ok") {
      decision = attemptDecision.decision;
    } else if (attemptDecision.kind === "invalid") {
      const detail = attemptDecision.errors.join("; ");
      return {
        kind: "refuse",
        message: `Invalid attempt decision.json — refusing to dispatch: ${detail}`,
        logLine: `DISPATCH REFUSED: invalid attempt decision task=${taskId} reason=${attemptDecision.reason}: ${detail}`,
      };
    }
  }

  return {
    kind: "ready",
    taskFile,
    rawTaskText,
    dispatchPhase,
    taskId,
    decision,
    selected: decision.selected_model ?? "sonnet",
    ...(active === undefined ? {} : { active }),
    warnings,
  };
}
