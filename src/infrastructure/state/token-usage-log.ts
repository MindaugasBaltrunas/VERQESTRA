// token-usage.jsonl RAŠYMO pusė (etalonas: AG_loop runtime/token-usage.ts write half).
// Skaitymo pusės čia NĖRA: griežtas benchmark skaitymas — application/benchmark,
// tolerantiškas — application/learning/usage-view, ledger — domain/tokens (FQC-12).
// Best-effort kontraktas: telemetrijos klaida niekada nestabdo orkestracijos.

import path from "node:path";
import { taskPhaseOfEntry } from "../../domain/tokens/usage-ledger.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import {
  runtimeAttemptIdentityFields,
  type AttemptResolutionPort,
  type ResolvedRuntimeAttempt,
} from "./attempt-resolution.js";

/** Claude sesijos usage kvitas (etalono claude-headless forma — FQC-12 namas čia, E4). */
export type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number;
  /** Realus sesijos turn'ų skaičius iš `result` envelope (2026-08-06). */
  num_turns?: number;
};

export type TokenUsageRecord = {
  ts: string;
  phase: string;
  task_id: string;
  model: string;
  /** Kanoninė fazė, įrašoma iš karto — ledger'iui nereikia atkurti repair konteksto. */
  task_phase?: string;
  /** Ar usage realiai nuskaityta, kai modelis buvo kviestas. Senos eilutės lauko neturi. */
  usage_captured?: boolean;
  attempt?: number;
  attempt_id?: string;
  parent_attempt_id?: string;
  outcome?: "succeeded" | "failed" | "infrastructure";
  retry_reason?: string;
  run_id?: string;
  worker_id?: string;
  runtime_attempt_id?: string;
  /** Task 0028 A/B žymės — rašomos TIK dispatch kelyje, kai režimas žinomas. */
  dispatch_tool_schema?: string;
  disallowed_tools?: number;
  tools_offered?: number;
  tool_usage_parsed?: boolean;
  tools_used_main?: string[];
  tools_used_agent?: string[];
} & ClaudeUsage;

export type TokenUsageMetadata = Pick<
  TokenUsageRecord,
  | "attempt"
  | "attempt_id"
  | "parent_attempt_id"
  | "outcome"
  | "retry_reason"
  | "dispatch_tool_schema"
  | "disallowed_tools"
  | "tools_offered"
  | "tool_usage_parsed"
  | "tools_used_main"
  | "tools_used_agent"
>;

/** Kanoninis whole-task usage žurnalo kelias. */
export function tokenUsageLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "token-usage.jsonl");
}

export function buildTokenUsageRecord(
  phase: string,
  taskId: string,
  model: string,
  usage: ClaudeUsage | undefined,
  now: Date = new Date(),
  metadata: TokenUsageMetadata = {},
): TokenUsageRecord {
  const base = {
    ts: now.toISOString(),
    phase,
    task_id: taskId,
    model,
    ...metadata,
  };
  const modelWasInvoked = model !== "" && model !== "none";
  return {
    ...base,
    // Fazė įrašoma iš karto, kad ledger'iui nereikėtų atkurti repair konteksto iš retry
    // metaduomenų kiekvieną kartą, kai istorija skaitoma iš naujo.
    task_phase: taskPhaseOfEntry(base),
    // Apskaitos aprėptis fiksuojama tik ten, kur modelis realiai kviestas: fast-path
    // eilutėms (`model === "none"`) klausimas „ar pavyko nuskaityti usage" prasmės neturi.
    ...(modelWasInvoked ? { usage_captured: usage !== undefined } : {}),
    ...(usage ?? {}),
  };
}

export async function appendTokenUsageRecord(logPath: string, record: TokenUsageRecord): Promise<void> {
  await nodeFsAdapter.appendTextFile(logPath, `${JSON.stringify(record)}\n`);
}

/**
 * Append-only token telemetrija — „matuok prieš optimizuok" pagrindas. Vienas attempt
 * rezoliucijos sprendimas maitina ir koreliacijos laukus, ir attempt kopiją.
 *
 * Attempt kopija yra DUAL-WRITE, ne perkėlimas: whole-task biudžeto vartai apima kelis
 * procesus ir kelis bandymus, o per-attempt failai juos apakintų ankstesniems bandymams;
 * `token-usage.jsonl` yra append-only žurnalas, ne kintamas singleton, tad jam netaikoma
 * „bendri kintami failai" problema, kurią attempt namespace'as sprendžia.
 */
export async function logTokenUsage(input: {
  runtimeRoot: string;
  resolution: AttemptResolutionPort;
  phase: string;
  taskId: string;
  model: string;
  usage?: ClaudeUsage;
  metadata?: TokenUsageMetadata;
  now?: Date;
}): Promise<void> {
  try {
    const resolved = await input.resolution.resolveActiveAttempt(input.taskId);
    const attempt: ResolvedRuntimeAttempt | undefined = resolved.ok ? resolved.attempt : undefined;
    const record: TokenUsageRecord = {
      ...buildTokenUsageRecord(input.phase, input.taskId, input.model, input.usage, input.now ?? new Date(), input.metadata ?? {}),
      ...runtimeAttemptIdentityFields(attempt),
    };
    await appendTokenUsageRecord(tokenUsageLogPath(input.runtimeRoot), record);
    if (attempt) {
      await attempt.handle.appendUsage(record);
    }
  } catch {
    // Telemetrija yra best-effort; jos klaida negali sugriauti diagnozės/dispatch'o.
  }
}
