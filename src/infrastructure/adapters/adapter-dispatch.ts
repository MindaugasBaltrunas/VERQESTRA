// CTX-2 adapterio kelio dispatch (etalonas: interfaces/cli/claude-dispatch/
// adapter-dispatch.ts 1:1). Kontraktas: `ExecutionRequest.prompt`, kurį mato bet kuris
// execution adapteris, yra tas pats kanoninis prompt'as, kurį CLI dispatch'as siunčia
// workeriui — ta pati gate politika ir ta pati buildWorkerPrompt kompozicija
// (application/task-execution/execution-context-gate), todėl paviršiai negali išsiskirti.

import { USAGE_ERROR_EXIT_CODE } from "../../shared/exit-codes.js";
import { defaultContextCompressionConfig, type ContextCompressionConfig } from "../../domain/policies/compression/features.js";
import {
  compileWorkerPromptTaskForDispatch,
  type WorkerPromptCompilation,
} from "../../application/context-pack/worker-prompt-compilation.js";
import {
  isRepairDispatchPrompt,
  isSourceChangeDispatch,
  resolveCanonicalWorkerPrompt,
  resolveExecutionContextMode,
  type AttachedOrSkippedGate,
  type ExecutionContextMode,
} from "../../application/task-execution/execution-context-gate.js";
import type { ExecutionAdapterKind, ExecutionRequest, ExecutionResult } from "../../domain/agents/execution-port.js";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "./claude-adapter.js";
import { createExecutionAdapter } from "./execution-adapter-factory.js";

export type ClaudeAdapterDispatchOptions = ExecutionRequest & {
  adapter?: ExecutionAdapterKind;
  /**
   * CTX-2: neapdorotas task failo tekstas. Nurodžius jį, adapteriui perduodamas `prompt`
   * gimsta TOJE PAČIOJE vietoje kaip CLI dispatch'o prompt'as; nenurodžius —
   * `options.prompt` lieka nepaliestas (senų kvietėjų backward compatibility).
   */
  taskText?: string;
  /** `vq/supervisor/execution-context.md` turinys (dar nevaliduotas — gate patikrina). */
  executionContext?: string;
  /** `vq/supervisor/context-pack.json` NEAPDOROTAS tekstas fingerprint patikrai. */
  contextPackText?: string;
  /** Rollout režimas; nenurodžius imamas iš aplinkos (`AG_EXECUTION_CONTEXT_MODE`). */
  executionContextMode?: ExecutionContextMode;
  /**
   * Task 0025: compression flag'ai. Nenurodžius adapteris siunčia raw task'ą — senas
   * kvietėjas negali netyčia gauti kompiliuoto prompt'o.
   */
  compression?: ContextCompressionConfig;
};

export type AdapterExecutionRequestResult =
  | {
      kind: "request";
      request: ExecutionRequest;
      gate: AttachedOrSkippedGate;
      /** Kuria task reprezentacija baigėsi šis kelias (`disabled` = raw, be bandymo). */
      compilation: WorkerPromptCompilation;
    }
  | { kind: "refuse"; reason: string };

/**
 * Gryna funkcija (jokio IO), kad ją būtų galima diff'inti su
 * `resolveDispatchPromptDelivery` rezultatu regresijos teste.
 */
export function buildAdapterExecutionRequest(options: ClaudeAdapterDispatchOptions): AdapterExecutionRequestResult {
  const {
    adapter: _adapter,
    taskText,
    executionContext,
    contextPackText,
    executionContextMode,
    compression,
    ...request
  } = options;
  if (taskText === undefined) {
    return {
      kind: "request",
      request,
      gate: { kind: "skip", reason: "adapter request carries no task text" },
      compilation: { kind: "disabled" },
    };
  }
  // Ta pati kompiliavimo politika kaip CLI kelyje: flag'ai sprendžia, fallback yra raw
  // task'as; dydžio sargas (task 0001) toje pačioje funkcijoje — adapteris negali išsiųsti
  // už raw didesnio kūno.
  const compilation = compileWorkerPromptTaskForDispatch({
    config: compression ?? defaultContextCompressionConfig(),
    taskId: options.taskId,
    taskText,
  });
  const canonical = resolveCanonicalWorkerPrompt({
    mode: executionContextMode ?? resolveExecutionContextMode(),
    sourceChange: isSourceChangeDispatch(taskText),
    taskId: options.taskId,
    taskText,
    ...(compilation.kind === "compiled" ? { compiledTask: compilation.task.text } : {}),
    ...(executionContext === undefined ? {} : { executionContext }),
    ...(contextPackText === undefined ? {} : { contextPackText }),
    isRepair: isRepairDispatchPrompt(taskText),
  });
  if (canonical.kind === "refuse") {
    return { kind: "refuse", reason: canonical.reason };
  }
  return { kind: "request", request: { ...request, prompt: canonical.prompt }, gate: canonical.gate, compilation };
}

export async function claudeAdapterDispatch(
  options: ClaudeAdapterDispatchOptions,
  adapterOptions: ClaudeAdapterOptions = {},
): Promise<ExecutionResult> {
  const kind = options.adapter ?? "claude";
  const built = buildAdapterExecutionRequest(options);
  if (built.kind === "refuse") {
    // Fail-fast prieš bet kokį išorinį darbą — kaip CLI kelias su trūkstamu/pasenusiu
    // execution context'u.
    return {
      adapter: kind,
      status: "failed",
      exitCode: USAGE_ERROR_EXIT_CODE,
      stdout: "",
      stderr: `Execution context gate refused dispatch: ${built.reason}`,
      reason: "execution_context_refused",
    };
  }
  if (options.adapter === "claude") {
    return await new ClaudeAdapter({ ...adapterOptions, enabled: true }).execute(built.request);
  }
  return await createExecutionAdapter(kind).execute(built.request);
}
