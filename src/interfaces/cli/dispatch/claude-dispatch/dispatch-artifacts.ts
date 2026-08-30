// Attempt-first dispatch artefaktų keliai + legacy kopijų promotinimas + CAS
// execution-result rašytojas (etalonas: interfaces/cli/claude-dispatch/
// dispatch-artifacts.ts 1:1; keliai — VERQESTRA vq layout).

import path from "node:path";
import { EXECUTION_CONTEXT_FILENAME } from "../../../../application/context-pack/execution-context-fingerprint.js";
import type { DispatchExecutionRecord } from "../../../../application/task-execution/dispatch-execution-record.js";
import type { ClaudeDispatchPorts, DispatchAttemptView } from "./dispatch-ports.js";

export type DispatchArtifacts = {
  dispatchLog: string;
  claudeLog: string;
  attemptClaudeLog?: string;
  claudeExitFile: string;
  visiblePrompt: string;
  visibleLauncher: string;
  executionContextPath: string;
  executionContextRaw: string;
  contextPackRaw: string;
  recordExecutionResult: (record: DispatchExecutionRecord) => Promise<void>;
};

/**
 * Paruošia attempt-first artefaktų kelius, promotina legacy context kopijas ir sukuria
 * execution-result rašytoją (CAS reviziją seka attempt view kompozicijoje).
 */
export async function prepareDispatchArtifacts(input: {
  ports: Pick<ClaudeDispatchPorts, "runtimeRoot" | "readOptionalFile" | "agLog">;
  taskId: string;
  rawTaskText: string;
  active?: DispatchAttemptView;
  /** `resolveAttempt` grąžintas claude-last kelias, kai `active` view dar nėra. */
  resolvedClaudeLogPath?: string;
}): Promise<DispatchArtifacts> {
  const { ports, active } = input;
  const dispatchLog = path.join(ports.runtimeRoot, "logs", "claude-dispatch-last.md");
  const claudeLog = path.join(ports.runtimeRoot, "logs", "claude-last.log");
  const attemptClaudeLog = active?.claudeLogPath ?? input.resolvedClaudeLogPath;

  if (active) {
    const written = await active.writeTaskOnce(input.rawTaskText);
    if (!written.ok) {
      await ports.agLog(
        `WARNING: dispatch task artifact write failed task=${input.taskId} ` +
          `reason=${written.reason ?? "unknown"}: ${(written.errors ?? []).join("; ")}`,
      );
    }
  }

  const legacyExecutionContextPath = path.join(ports.runtimeRoot, "supervisor", EXECUTION_CONTEXT_FILENAME);
  const attemptExecutionContextRaw = active ? await active.readArtifactText("execution-context") : undefined;
  let executionContextPath = legacyExecutionContextPath;
  let executionContextRaw = attemptExecutionContextRaw ?? "";
  if (executionContextRaw) {
    // Attempt kopija yra pirminė; kelias informacinis (log eilutėms).
    executionContextPath = `attempt:${EXECUTION_CONTEXT_FILENAME}`;
  } else {
    executionContextRaw = await ports.readOptionalFile(legacyExecutionContextPath);
    if (executionContextRaw && active) {
      const promoted = await active.promoteExecutionContext(executionContextRaw);
      if (!promoted.ok) {
        await ports.agLog(
          `WARNING: dispatch execution-context promotion failed task=${input.taskId} ` +
            `reason=${promoted.reason ?? "unknown"}: ${(promoted.errors ?? []).join("; ")}`,
        );
      }
    }
  }

  const attemptContextPackRaw = active ? await active.readArtifactText("context-pack") : undefined;
  let contextPackRaw = attemptContextPackRaw ?? "";
  if (!contextPackRaw) {
    contextPackRaw = await ports.readOptionalFile(path.join(ports.runtimeRoot, "supervisor", "context-pack.json"));
    if (contextPackRaw && active) {
      let parsedPack: unknown;
      try {
        parsedPack = JSON.parse(contextPackRaw);
      } catch {
        parsedPack = undefined;
      }
      if (parsedPack !== undefined) {
        const promoted = await active.promoteContextPack(parsedPack);
        if (!promoted.ok) {
          await ports.agLog(
            `WARNING: dispatch context-pack promotion failed task=${input.taskId} ` +
              `reason=${promoted.reason ?? "unknown"}: ${(promoted.errors ?? []).join("; ")}`,
          );
        }
      }
    }
  }

  const recordExecutionResult = async (record: DispatchExecutionRecord): Promise<void> => {
    if (!active) return;
    const written = await active.writeExecutionResult(record);
    if (!written.ok) {
      await ports.agLog(
        `WARNING: dispatch execution-result write failed task=${input.taskId} status=${record.status} ` +
          `reason=${written.reason ?? "unknown"}: ${(written.errors ?? []).join("; ")}`,
      );
    }
  };

  return {
    dispatchLog,
    claudeLog,
    ...(attemptClaudeLog === undefined ? {} : { attemptClaudeLog }),
    claudeExitFile: path.join(ports.runtimeRoot, "state", "claude-last-exit-code"),
    visiblePrompt: path.join(ports.runtimeRoot, "supervisor", "claude-visible-prompt.md"),
    visibleLauncher: path.join(ports.runtimeRoot, "supervisor", "claude-visible-launch.ps1"),
    executionContextPath,
    executionContextRaw,
    contextPackRaw,
    recordExecutionResult,
  };
}
