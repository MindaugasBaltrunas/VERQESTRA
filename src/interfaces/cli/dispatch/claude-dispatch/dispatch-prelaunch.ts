// Operatoriaus preview, checkpoint ir globali būsena iškart prieš proceso paleidimą
// (etalonas: interfaces/cli/claude-dispatch/dispatch-prelaunch.ts 1:1; keliai — vq).

import path from "node:path";
import type { DispatchExecutionRecordInput } from "../../../../application/task-execution/dispatch-execution-record.js";
import type { ClaudeDispatchPorts } from "./dispatch-ports.js";

export type PrepareDispatchLaunchStateInput = {
  ports: Pick<
    ClaudeDispatchPorts,
    "runtimeRoot" | "writeText" | "removeIfExists" | "recordResumeCheckpoint" | "nowIso"
  >;
  taskId: string;
  taskFile: string;
  dispatchLog: string;
  claudeExitFile: string;
  visiblePrompt: string;
  workerPrompt: string;
  promptPreview: string;
  claudeModel: string;
  selectedModel: string;
  effectiveTier: string;
  routing: { tier: string; reason: string; policyHash: string };
  failedAttempts: number;
  sourceChange: boolean;
  executionContextPath: string;
  contextGate: DispatchExecutionRecordInput["contextGate"];
  workerPromptRecord: NonNullable<DispatchExecutionRecordInput["workerPrompt"]>;
  logDispatch(line: string): Promise<void>;
};

/** Įrašo operatoriaus preview, checkpoint ir globalią būseną iškart prieš proceso paleidimą. */
export async function prepareDispatchLaunchState(input: PrepareDispatchLaunchStateInput): Promise<void> {
  const { ports } = input;
  await ports.writeText(
    input.dispatchLog,
    `# Claude dispatch

- date: ${ports.nowIso()}
- model: ${input.claudeModel}
- selected_model: ${input.selectedModel}
- effective_tier: ${input.effectiveTier}
- routing_tier: ${input.routing.tier}
- routing_reason: ${input.routing.reason}
- routing_policy: ${input.routing.policyHash}
- failed_attempts: ${input.failedAttempts}
- task_file: ${input.taskFile}
- source_change: ${input.sourceChange}
- execution_context: ${input.contextGate.kind === "attach" ? input.executionContextPath : `none (${input.contextGate.reason})`}
- worker_prompt_mode: ${input.workerPromptRecord.mode}${
      input.workerPromptRecord.compressionFallback === undefined
        ? ""
        : `\n- compression_fallback: ${input.workerPromptRecord.compressionFallback} (${input.workerPromptRecord.fallbackReason})`
    }
- prompt_chars: ${input.workerPrompt.length}

## Prompt sent to Claude

${input.promptPreview}
`,
  );

  await input.logDispatch(
    `CLAUDE CONNECTED: visible PowerShell task runner --model ${input.claudeModel} < ${path.basename(input.taskFile)}`,
  );
  await ports.recordResumeCheckpoint({
    actor: "claude",
    phase: "dispatch",
    status: "started",
    task_id: input.taskId,
    task_file: input.taskFile,
    log_file: input.dispatchLog,
    next_action: "Claude is running the visible prompt",
  });
  await ports.writeText(input.visiblePrompt, input.workerPrompt);
  await ports.removeIfExists(input.claudeExitFile);
  await ports.removeIfExists(path.join(ports.runtimeRoot, "state", "claude-stop-status.json"));
  await ports.removeIfExists(path.join(ports.runtimeRoot, "logs", "claude-stop.log"));
  await ports.writeText(path.join(ports.runtimeRoot, "state", "current-task-id"), `${input.taskId}\n`);
}
