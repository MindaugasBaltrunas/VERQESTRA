// `execution-result.json` įrašo statyba (etalonas: interfaces/cli/claude-dispatch/
// dispatch-execution-record.ts 1:1; task 1117a). Vienintelė vieta, kurioje lieka atsakymas
// „ką ir kaip šis bandymas paleido". PROMPT TEKSTAS Į ARTEFAKTĄ NEPATENKA NIEKADA — tik
// `prompt_sha256` + `prompt_chars` (kanoninės kopijos guli tame pačiame attempt kataloge).
// Gryna funkcija be IO — platform parity testas gali palyginti abiejų platformų įrašus.

import { contextArtifactSha256 } from "../context-pack/execution-context-fingerprint.js";
import type { WorkerPromptMode } from "../context-pack/worker-prompt-compilation.js";
import type { CompactWorkerDslStats } from "../context-pack/compact-dsl/model.js";
import type { DispatchUsageView } from "./stop-bridge-wait.js";

export type DispatchExecutionStatus = "started" | "finished" | "refused";

export const DISPATCH_EXECUTION_RECORD_SCHEMA = 1;

export type DispatchExecutionRecordInput = {
  status: DispatchExecutionStatus;
  /** `implementation` | `repair` — ta pati fazė, kuria autorizuojamas biudžetas. */
  phase: string;
  taskFile: string;
  sourceChange: boolean;
  /** RAW `decision.selected_model` su esamu `?? "sonnet"` default'u (kaip log'uose). */
  selectedModel: string;
  failedAttempts: number;
  attempt: number;
  startedAt: string;
  /** `kind` = `attach` | `skip` | `refuse`; `executionContext` tekstas čia niekada nepatenka. */
  contextGate: { kind: string; reason?: string };
  /** Žinomas tik po `routeModel` — atsisakymo šakose maršruto dar nėra. */
  routing?: { baseTier: string; tier: string; reason: string; policyHash: string; model: string };
  /** Kanoninis worker prompt'as. Įraše lieka tik jo ilgis ir sha256. */
  prompt?: string;
  /**
   * Task 0025: kuria forma task'as pateko į prompt'ą ir, jei grįžta atgal, kodėl.
   * KOMPILIUOTAS TEKSTAS ČIA NEPATENKA — `task_sha256` + `prompt_sha256` įrodo grandinę.
   */
  workerPrompt?: {
    mode: WorkerPromptMode;
    /** RAW task baitų sha256 — įrodymo grandinė iki attempt `task.md`. */
    taskSha256: string;
    compressionFallback?: string;
    fallbackReason?: string;
    compiledChars?: number;
    irChars?: number;
    rawChars?: number;
    /** Task 0007: compact-DSL statistika — tik `compact_dsl` režime, laukai jau snake_case. */
    dsl?: CompactWorkerDslStats;
  };
  maxTurns?: number;
  dispatchTimeoutMs?: number;
  delivery?: { platform: string; transport: string };
  /** Task 0028: `candidates` lieka net kai transport'as nepritaikė — A/B įrodymui. */
  toolSchema?: { mode: string; candidates: string[]; applied: string[]; reason: string };
  /** Atsisakymo priežastis (`status: "refused"`). */
  reason?: string;
  exitCode?: number;
  usage?: DispatchUsageView;
  usageLimitHit?: boolean;
  zeroUsageSuccess?: boolean;
  stopBridgeDone?: boolean;
  /** Task 1203: laukas atsiranda TIK mid-stream biudžeto nutraukimo atveju. */
  midDispatchBudget?: { billable_tokens: number; raw_tokens: number; limit: number; limitSource: string };
  finishedAt?: string;
};

export type DispatchExecutionRecord = {
  schema: number;
  status: DispatchExecutionStatus;
  phase: string;
  task_file: string;
  source_change: boolean;
  selected_model: string;
  failed_attempts: number;
  attempt: number;
  started_at: string;
  context_gate: { kind: string; reason?: string };
  base_tier?: string;
  routing_tier?: string;
  routing_reason?: string;
  routing_policy_hash?: string;
  model?: string;
  max_turns?: number;
  dispatch_timeout_ms?: number;
  delivery?: { platform: string; transport: string };
  tool_schema?: { mode: string; candidates: string[]; applied: string[]; reason: string };
  prompt_chars?: number;
  prompt_sha256?: string;
  worker_prompt_mode?: WorkerPromptMode;
  task_sha256?: string;
  compression_fallback?: string;
  compression_fallback_reason?: string;
  compiled_task_chars?: number;
  worker_task_ir_chars?: number;
  raw_task_chars?: number;
  /** Task 0007: compact-DSL statistika. Tik `compact_dsl` režime. */
  dsl_stats?: CompactWorkerDslStats;
  reason?: string;
  exit_code?: number;
  usage?: DispatchUsageView;
  usage_limit_hit?: boolean;
  zero_usage_success?: boolean;
  stop_bridge_done?: boolean;
  mid_dispatch_budget?: { billable_tokens: number; raw_tokens: number; limit: number; limitSource: string };
  finished_at?: string;
};

export function buildDispatchExecutionRecord(input: DispatchExecutionRecordInput): DispatchExecutionRecord {
  return {
    schema: DISPATCH_EXECUTION_RECORD_SCHEMA,
    status: input.status,
    phase: input.phase,
    task_file: input.taskFile,
    source_change: input.sourceChange,
    selected_model: input.selectedModel,
    failed_attempts: input.failedAttempts,
    attempt: input.attempt,
    started_at: input.startedAt,
    // Laukai perkeliami PO VIENĄ, ne spread'u: `contextGate` gali būti `attach` variantas su
    // visu execution context tekstu — tik eksplicitus kopijavimas garantuoja, kad jis į
    // artefaktą nepatenka.
    context_gate: {
      kind: input.contextGate.kind,
      ...(input.contextGate.reason === undefined ? {} : { reason: input.contextGate.reason }),
    },
    ...(input.routing === undefined
      ? {}
      : {
          base_tier: input.routing.baseTier,
          routing_tier: input.routing.tier,
          routing_reason: input.routing.reason,
          routing_policy_hash: input.routing.policyHash,
          model: input.routing.model,
        }),
    ...(input.maxTurns === undefined ? {} : { max_turns: input.maxTurns }),
    ...(input.dispatchTimeoutMs === undefined ? {} : { dispatch_timeout_ms: input.dispatchTimeoutMs }),
    ...(input.delivery === undefined
      ? {}
      : { delivery: { platform: input.delivery.platform, transport: input.delivery.transport } }),
    // `off` režimo įraše nėra: išjungtas flag'as nepalieka nė vieno naujo lauko.
    ...(input.toolSchema === undefined || input.toolSchema.mode === "off"
      ? {}
      : {
          tool_schema: {
            mode: input.toolSchema.mode,
            candidates: [...input.toolSchema.candidates],
            applied: [...input.toolSchema.applied],
            reason: input.toolSchema.reason,
          },
        }),
    ...(input.prompt === undefined
      ? {}
      : { prompt_chars: input.prompt.length, prompt_sha256: contextArtifactSha256(input.prompt) }),
    ...(input.workerPrompt === undefined
      ? {}
      : {
          worker_prompt_mode: input.workerPrompt.mode,
          task_sha256: input.workerPrompt.taskSha256,
          ...(input.workerPrompt.compressionFallback === undefined
            ? {}
            : { compression_fallback: input.workerPrompt.compressionFallback }),
          ...(input.workerPrompt.fallbackReason === undefined
            ? {}
            : { compression_fallback_reason: input.workerPrompt.fallbackReason }),
          ...(input.workerPrompt.compiledChars === undefined
            ? {}
            : { compiled_task_chars: input.workerPrompt.compiledChars }),
          ...(input.workerPrompt.irChars === undefined ? {} : { worker_task_ir_chars: input.workerPrompt.irChars }),
          ...(input.workerPrompt.rawChars === undefined ? {} : { raw_task_chars: input.workerPrompt.rawChars }),
          ...(input.workerPrompt.dsl === undefined ? {} : { dsl_stats: { ...input.workerPrompt.dsl } }),
        }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.exitCode === undefined ? {} : { exit_code: input.exitCode }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.usageLimitHit === undefined ? {} : { usage_limit_hit: input.usageLimitHit }),
    ...(input.zeroUsageSuccess === undefined ? {} : { zero_usage_success: input.zeroUsageSuccess }),
    ...(input.stopBridgeDone === undefined ? {} : { stop_bridge_done: input.stopBridgeDone }),
    ...(input.midDispatchBudget === undefined
      ? {}
      : {
          mid_dispatch_budget: {
            billable_tokens: input.midDispatchBudget.billable_tokens,
            raw_tokens: input.midDispatchBudget.raw_tokens,
            limit: input.midDispatchBudget.limit,
            limitSource: input.midDispatchBudget.limitSource,
          },
        }),
    ...(input.finishedAt === undefined ? {} : { finished_at: input.finishedAt }),
  };
}
