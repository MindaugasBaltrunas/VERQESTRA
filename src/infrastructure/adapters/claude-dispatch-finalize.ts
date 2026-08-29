// Terminaliniai dispatch artefaktai ir matavimai vienoje vietoje (etalonas:
// interfaces/cli/claude-dispatch/dispatch-finalization.ts 1:1): execution-result su
// baigtimi, exit failas, resume checkpoint (per portą — checkpoint store E5), CLAUDE
// FINISHED + tool usage log eilutės ir token-usage įrašas su 0028 A/B žymėmis.

import {
  BUDGET_EXCEEDED_EXIT_CODE,
  DISPATCH_TIMEOUT_EXIT_CODE,
  USAGE_LIMIT_EXIT_CODE,
} from "../../shared/exit-codes.js";
import {
  buildDispatchExecutionRecord,
  type DispatchExecutionRecord,
  type DispatchExecutionRecordInput,
} from "../../application/task-execution/dispatch-execution-record.js";
import { appendContextSizeMetrics, buildContextSizeMetrics } from "../../application/context-pack/metrics.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { noRuntimeAttemptResolution, type AttemptResolutionPort } from "../state/attempt-resolution.js";
import { logTokenUsage } from "../state/token-usage-log.js";
import { extractDispatchToolUsage } from "./claude-tool-schema.js";
import type { DispatchToolSchemaProfile } from "./claude-dispatch-delivery.js";
import type { DispatchOutcome } from "./claude-dispatch-outcome.js";

/** Resume checkpoint įrašo forma (checkpoint store — E5 kompozicija). */
export type DispatchCheckpointEntry = {
  actor: string;
  phase: string;
  status: "started" | "finished" | "failed";
  task_id: string;
  task_file: string;
  log_file: string;
  exit_code?: number;
  next_action: string;
};

export type FinalizeDispatchInput = {
  /** VERQESTRA runtime šaknis (`<root>/vq`) — token-usage žurnalui. */
  runtimeRoot: string;
  taskId: string;
  taskFile: string;
  dispatchPhase: "implementation" | "repair";
  attempt: number;
  /** Apskaitos pakopa (etalono effectiveTier) — eina į token-usage `model` lauką. */
  effectiveTier: string;
  routingReasonCodes: readonly string[];
  claudeExitFile: string;
  claudeLog: string;
  attemptClaudeLog?: string;
  claudeLogText: string;
  toolSchema: DispatchToolSchemaProfile;
  launchRecord: Omit<DispatchExecutionRecordInput, "status">;
  outcome: DispatchOutcome;
  recordExecutionResult(record: DispatchExecutionRecord): Promise<void>;
  recordResumeCheckpoint(entry: DispatchCheckpointEntry): Promise<void>;
  /** Usage attempt koreliacija; nenurodžius — be attempt tapatybės. */
  resolution?: AttemptResolutionPort;
  logDispatch(line: string): Promise<void>;
};

/** Užrašo visus terminalinius dispatch artefaktus ir matavimus vienoje vietoje. */
export async function finalizeDispatch(input: FinalizeDispatchInput): Promise<void> {
  const budgetVerdict = input.outcome.budgetVerdict;
  await input.recordExecutionResult(
    buildDispatchExecutionRecord({
      ...input.launchRecord,
      status: "finished",
      toolSchema: input.toolSchema,
      exitCode: input.outcome.exitCode,
      ...(input.outcome.usage === undefined ? {} : { usage: input.outcome.usage }),
      usageLimitHit: input.outcome.usageLimitHit,
      zeroUsageSuccess: input.outcome.zeroUsageSuccess,
      stopBridgeDone: input.outcome.stopBridgeDone,
      ...(budgetVerdict === undefined
        ? {}
        : {
            midDispatchBudget: {
              billable_tokens: budgetVerdict.billableTokens,
              raw_tokens: budgetVerdict.rawTokens,
              limit: budgetVerdict.limit,
              limitSource: budgetVerdict.limitSource,
            },
          }),
      finishedAt: new Date().toISOString(),
    }),
  );

  await nodeFsAdapter.writeTextFile(input.claudeExitFile, `${input.outcome.exitCode}\n`);
  await input.recordResumeCheckpoint({
    actor: "claude",
    phase: "dispatch",
    status: input.outcome.exitCode === 0 ? "finished" : "failed",
    task_id: input.taskId,
    task_file: input.taskFile,
    log_file: input.attemptClaudeLog ?? input.claudeLog,
    exit_code: input.outcome.exitCode,
    next_action:
      input.outcome.exitCode === 0
        ? "Return to supervisor diagnosis"
        : input.outcome.exitCode === USAGE_LIMIT_EXIT_CODE
          ? "Usage limit — task requeued, loop waits for the cooldown and resumes"
          : input.outcome.exitCode === DISPATCH_TIMEOUT_EXIT_CODE
            ? "Dispatch timeout — loop should halt and requeue the task"
            : input.outcome.exitCode === BUDGET_EXCEEDED_EXIT_CODE
              ? "Mid-dispatch token budget exceeded — task requeued; inspect the burn before re-running"
              : "Supervisor should inspect Claude log and create repair task",
  });
  await input.logDispatch(`CLAUDE FINISHED: exit_code=${input.outcome.exitCode} task=${input.taskFile}`);

  const toolUsage = extractDispatchToolUsage(input.claudeLogText);
  await input.logDispatch(
    `DISPATCH TOOL USAGE: task=${input.taskId} phase=${input.dispatchPhase} ` +
      `tool_schema=${input.toolSchema.mode} parsed=${toolUsage.parsed} events=${toolUsage.events} ` +
      `unknown_events=${toolUsage.unknownEvents} offered=${toolUsage.offered.length} ` +
      `main=${toolUsage.mainUsed.join(",") || "none"} agent=${toolUsage.agentUsed.join(",") || "none"}`,
  );

  await logTokenUsage({
    runtimeRoot: input.runtimeRoot,
    resolution: input.resolution ?? noRuntimeAttemptResolution,
    phase: "dispatch",
    taskId: input.taskId,
    model: input.effectiveTier,
    ...(input.outcome.usage === undefined ? {} : { usage: input.outcome.usage }),
    metadata: {
      dispatch_tool_schema: input.toolSchema.mode,
      disallowed_tools: input.toolSchema.applied.length,
      tools_offered: toolUsage.offered.length,
      tool_usage_parsed: toolUsage.parsed,
      tools_used_main: toolUsage.mainUsed,
      tools_used_agent: toolUsage.agentUsed,
      attempt: input.attempt,
      attempt_id: `${input.taskId}:dispatch:${input.attempt}`,
      ...(input.attempt > 1 ? { parent_attempt_id: `${input.taskId}:dispatch:${input.attempt - 1}` } : {}),
      outcome:
        input.outcome.exitCode === 0
          ? "succeeded"
          : input.outcome.exitCode === USAGE_LIMIT_EXIT_CODE
            ? "infrastructure"
            : "failed",
      ...(input.attempt > 1 ? { retry_reason: `repair:${input.routingReasonCodes.join("+")}` } : {}),
    },
  });

  const shadow = input.toolSchema.shadow;
  if (shadow !== undefined) {
    try {
      const sizeRecord = buildContextSizeMetrics({
        taskId: input.taskId,
        contextChars: 0,
        maxContextChars: 0,
        specFragmentCount: 0,
        codeContextItemCount: 0,
        toolSchemaFullChars: shadow.fullChars,
        toolSchemaReducedChars: shadow.reducedChars,
      });
      await appendContextSizeMetrics(nodeFsAdapter, input.runtimeRoot, sizeRecord);
    } catch {
      // Shadow telemetrija yra best-effort: gedimas negali sulaužyti dispatch finalize.
    }
  }

  // Task 0086: `worker_prompt_chars` neturėjo rašytojo visame `src`, tad `joinPostRunTruth`
  // (task 0042) visada matė jį `undefined`. `input.launchRecord.prompt` yra tas pats string'as,
  // kuris nueina į `resolveDelivery`/launchProcess (CTX-2) — realus siųstas prompt'as, ne jo
  // aproksimacija. Rašoma TIK kai jis žinomas: senesni/testiniai kvietėjai gali jo neduoti, ir
  // tuščia eilutė (be jokio matavimo) nieko neįrodytų.
  const workerPromptChars = input.launchRecord.prompt?.length;
  if (workerPromptChars !== undefined) {
    try {
      const rawTaskChars = input.launchRecord.workerPrompt?.rawChars;
      const sizeRecord = buildContextSizeMetrics({
        taskId: input.taskId,
        attempt: input.attempt,
        attempt_id: `${input.taskId}:dispatch:${input.attempt}`,
        contextChars: 0,
        maxContextChars: 0,
        specFragmentCount: 0,
        codeContextItemCount: 0,
        workerPromptChars,
        ...(rawTaskChars === undefined ? {} : { rawTaskChars }),
      });
      await appendContextSizeMetrics(nodeFsAdapter, input.runtimeRoot, sizeRecord);
    } catch {
      // Best-effort: gedimas negali sulaužyti dispatch finalize.
    }
  }
}
