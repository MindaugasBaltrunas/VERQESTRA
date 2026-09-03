// Context-size telemetry: append-only logs/context-size.jsonl, one record per assembled
// context pack — "measure before optimize". Best-effort: a telemetry write failure never
// blocks context-pack assembly. Behaviour etalon: AG_loop application/context-pack/metrics.ts;
// FS ir attempt tapatybė — per portus (WBR VQ-302); runtime attempt manifestas — E4.

import path from "node:path";
import type { ContextCompressionFeature } from "../../domain/policies/compression/features.js";
import type { ContextPackFileSystemPort } from "./ports.js";

export type ContextSizeMetricsInput = {
  taskId: string;
  // Attempt-scoped join identity (task 0035 convention), threaded through so a context-size
  // record can be joined against a token-usage record for the SAME dispatch attempt.
  attempt?: number;
  attempt_id?: string;
  contextChars: number;
  maxContextChars: number;
  specFragmentCount: number;
  codeContextItemCount: number;
  // Count of spec fragments whose `#heading` ref was not found in the target markdown file.
  headingMissCount?: number;
  // Total items dropped by the unified priority-aware context budgeter (task 921).
  droppedItemCount?: number;
  /**
   * Spec ref'ai, prarasti PRIEŠ tą budgeter'į: neišspręsti (nerasta, už projekto ribų,
   * neperskaitoma, kandidatų lubos) plius numesti fragmentų limito, dublikato ar simbolių
   * biudžeto. Atskiras skaičius nuo `droppedItemCount` SĄMONINGAI: tai dvi skirtingos stadijos,
   * ir sulietas skaičius atimtų vienintelį dalyką, dėl kurio metrika naudinga — priskyrimą.
   * Apkarpyti fragmentai čia NESKAIČIUOJAMI: jie pack'e YRA (žr. `spec_fragment_truncated`).
   */
  specDroppedCount?: number;
  /**
   * Simboliai, VISIŠKAI numesti code-context perpildymo kopėčių (task 0006), kai pack'as
   * netilpo net po visų droppable šaltinių. Pakopos nuleidimas (SRC → SIG → REF) čia
   * NESKAIČIUOJAMAS: simbolis lieka, tik su mažiau detalių. Iki šiol tai buvo matoma tik
   * `reduction.note` eilutėje pack'o pastabose — žmogui skirtame tekste, ne metrikoje.
   */
  codeContextDroppedCount?: number;
  // True when the code index was stale/missing and was deterministically rebuilt before this
  // pack's code_context was gathered — "degraded mode must be visible" (task 975).
  codeContextRebuilt?: boolean;
  // Context cache outcome for this assembly (task 1108, spec RAG-2). Legacy records: "unknown".
  cacheStatus?: ContextCacheStatus;
  // Chars actually selected into the pack, and the token estimate of that selection.
  selectedChars?: number;
  selectedTokenEstimate?: number;
  // Compression features this task got from the CANARY cohort rather than from a config-wide
  // `true` (task 0031). Absent or empty => control arm.
  canaryFeatures?: readonly ContextCompressionFeature[];
  // True when the size guard would refuse this task's compiled body and send the raw task
  // instead. See {@link CANARY_SIZE_FALLBACK_MARKER}.
  canarySizeFallback?: boolean;
} & ContextCompressionMetricsInput;

// ---------------------------------------------------------------------------
// Context Compression v2 A/B measurement fields (task 0020). Every field is OPTIONAL on both
// sides of the log: a value that was never measured is ABSENT, not `0` — a silent `0` would be
// indistinguishable from "compiled to nothing" once a flag is turned on. Absent keys also keep
// the JSONL line byte-identical to today's.
// ---------------------------------------------------------------------------
export type ContextCompressionMetricsInput = {
  /** Raw canonical task Markdown size, before any IR/DSL compilation. */
  rawTaskChars?: number;
  /**
   * DEPRECATED alias of {@link irJsonChars}, kept for existing readers (task 0032: two logs
   * wrote a `compiled_task_chars` measuring two DIFFERENT things; new readers must use
   * {@link irJsonChars} here and `sent_prompt_chars` in the dispatch log).
   */
  compiledTaskChars?: number;
  /** Size of the WorkerTaskIR as JSON (task 0021 shadow compilation). */
  irJsonChars?: number;
  /**
   * Size of the worker prompt actually handed to the dispatch. Assembly-time telemetry cannot
   * measure it (the final prompt is resolved in the interfaces layer). The writer lives outside
   * this module — dispatch finalize (`claude-dispatch-finalize.ts`, task 0086) calls
   * {@link buildContextSizeMetrics} with the real sent-prompt length once the dispatch attempt
   * resolves it.
   */
  workerPromptChars?: number;
  /** Code-context chars rendered as full symbol source slices (`SRC`). */
  symbolSourceChars?: number;
  /** Code-context chars rendered as symbol signatures only (`SIG`). */
  symbolSignatureChars?: number;
  /** Raw Bash/PowerShell tool output chars seen before digesting (hook-side writer; declared
   *  for schema/reader compatibility). */
  toolRawChars?: number;
  /** Digested tool output chars that would replace the raw output. Same writer gap. */
  toolDigestChars?: number;
  /**
   * Full worker prompt WITHOUT compression: the raw task body plus the SAME execution context
   * artifact a real dispatch would attach (task 0032 — `buildWorkerPrompt`, no `compiledTask`).
   * This, not {@link rawTaskChars}, is one half of the pair a compression decision is actually
   * made on: the task body alone is never what the worker receives.
   */
  rawPromptChars?: number;
  /**
   * Full worker prompt WITH compression: the same execution context as {@link rawPromptChars},
   * but with the task body replaced by its shadow-compiled WorkerTaskIR prompt (task 0032 —
   * `buildWorkerPrompt` with `compiledTask` set). Absent when the shadow compilation refused
   * the task, same fail-closed reasoning as {@link irJsonChars}.
   */
  compiledPromptChars?: number;
  /** Full tool schema size sent to the model, before `dispatch_tool_schema` reduction. */
  toolSchemaFullChars?: number;
  /** Reduced tool schema size after `dispatch_tool_schema` shrinks it for this dispatch. */
  toolSchemaReducedChars?: number;
  /** Size of the `compact_dsl` intermediate representation, before DSL compilation. */
  dslIrChars?: number;
  /** Size of the `compact_dsl`-compiled output handed to the dispatch. */
  dslCompiledChars?: number;
};

/** Record-side (snake_case) counterpart of {@link ContextCompressionMetricsInput}. */
export type ContextCompressionMetrics = {
  raw_task_chars?: number;
  compiled_task_chars?: number;
  ir_json_chars?: number;
  worker_prompt_chars?: number;
  symbol_source_chars?: number;
  symbol_signature_chars?: number;
  tool_raw_chars?: number;
  tool_digest_chars?: number;
  raw_prompt_chars?: number;
  compiled_prompt_chars?: number;
  tool_schema_full_chars?: number;
  tool_schema_reduced_chars?: number;
  dsl_ir_chars?: number;
  dsl_compiled_chars?: number;
};

// Single input-key -> record-key table so a new measurement is added in exactly
// one place and build/read paths cannot drift apart.
const COMPRESSION_METRIC_FIELDS: ReadonlyArray<
  readonly [keyof ContextCompressionMetricsInput, keyof ContextCompressionMetrics]
> = [
  ["rawTaskChars", "raw_task_chars"],
  ["compiledTaskChars", "compiled_task_chars"],
  ["irJsonChars", "ir_json_chars"],
  ["workerPromptChars", "worker_prompt_chars"],
  ["symbolSourceChars", "symbol_source_chars"],
  ["symbolSignatureChars", "symbol_signature_chars"],
  ["toolRawChars", "tool_raw_chars"],
  ["toolDigestChars", "tool_digest_chars"],
  ["rawPromptChars", "raw_prompt_chars"],
  ["compiledPromptChars", "compiled_prompt_chars"],
  ["toolSchemaFullChars", "tool_schema_full_chars"],
  ["toolSchemaReducedChars", "tool_schema_reduced_chars"],
  ["dslIrChars", "dsl_ir_chars"],
  ["dslCompiledChars", "dsl_compiled_chars"],
];

/**
 * Copies only the measurements that were actually taken. A present but invalid value
 * (negative, NaN, non-finite) is a programming error in the caller — it fails fast rather
 * than poisoning an A/B comparison with a silently wrong number.
 */
function selectCompressionMetrics(input: ContextCompressionMetricsInput): ContextCompressionMetrics {
  const metrics: ContextCompressionMetrics = {};
  for (const [inputKey, recordKey] of COMPRESSION_METRIC_FIELDS) {
    const value = input[inputKey];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid context compression metric ${inputKey}: expected a non-negative number, got ${value}`);
    }
    metrics[recordKey] = value;
  }
  return metrics;
}

/**
 * Reads the compression fields back from a logged record. Legacy records simply carry none of
 * them; a present-but-corrupted value is rejected.
 */
function readCompressionMetrics(record: Partial<ContextSizeMetricsRecord>): ContextCompressionMetrics {
  const metrics: ContextCompressionMetrics = {};
  for (const [, recordKey] of COMPRESSION_METRIC_FIELDS) {
    const value = record[recordKey];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid context size metrics log record: ${recordKey} must be a non-negative number`);
    }
    metrics[recordKey] = value;
  }
  return metrics;
}

export type ContextCacheStatus = "hit" | "miss" | "bypass" | "unknown";

// Chars per token for the coarse estimate. Deliberately provider-neutral.
const CHARS_PER_TOKEN = 4;

export function estimateTokensFromChars(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN);
}

export type ContextSizeMetricsRecord = {
  ts: string;
  task_id: string;
  attempt?: number;
  attempt_id?: string;
  // Runtime attempt correlation (task 0045): written ONLY when an active attempt manifest
  // resolves for this record's `task_id` — absent, never null/empty, otherwise.
  run_id?: string;
  worker_id?: string;
  runtime_attempt_id?: string;
  context_chars: number;
  max_context_chars: number;
  spec_fragment_count: number;
  code_context_item_count: number;
  heading_miss_count: number;
  dropped_item_count: number;
  spec_dropped_count: number;
  code_context_dropped_count: number;
  code_context_rebuilt: boolean;
  cache_status: ContextCacheStatus;
  selected_chars: number;
  selected_token_estimate: number;
  exceeded: boolean;
  /**
   * Canary-enabled feature names in canonical order. Written ONLY when non-empty, so a
   * repository with no canary configured keeps writing byte-identical JSONL lines.
   */
  canary_features?: string[];
} & ContextCompressionMetrics;

/**
 * True when `record` is a real context-pack assembly row — the row that carries the actual
 * `canary_features` arm and budget — rather than one of the synthetic telemetry rows appended
 * later in the same task's lifecycle by writers outside this module. Three known synthetic
 * writers always set `max_context_chars: 0` and never set `canary_features`, so a "latest wins"
 * reader that does not filter through this predicate silently demotes every canary task to
 * control (compression-audit-2026-09-03.md, section 3: 34/34 completed canary tasks demoted):
 * - dispatch finalize's `worker_prompt_chars` row (claude-dispatch-finalize.ts, task 0086)
 * - dispatch finalize's `dispatch_tool_schema` shadow row (same file, task 0036)
 * - the post-hook bash-digest shadow row (post-hooks.ts, task 036-a-02)
 * None of these three measure a context pack at all — they measure a sent prompt, a tool
 * schema, or a bash digest — so `max_context_chars: 0` on them is not "a pack with zero
 * budget", it is "not a pack". A real assembly (persist.ts) always threads a positive
 * `maxContextChars` sourced from config, so `> 0` cleanly separates the two.
 * Missing entirely (`undefined`) is treated as NOT a pack, on purpose: every real pack row,
 * legacy or current, always carries `max_context_chars` — see {@link readContextSizeMetrics},
 * which rejects a record missing it outright. Absence here means a foreign/corrupted record,
 * not an old pack format worth trusting.
 */
export function describesContextPack(record: Partial<ContextSizeMetricsRecord>): boolean {
  return typeof record.max_context_chars === "number" && record.max_context_chars > 0;
}

export function buildContextSizeMetrics(input: ContextSizeMetricsInput, now: Date = new Date()): ContextSizeMetricsRecord {
  return {
    ts: now.toISOString(),
    task_id: input.taskId,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.attempt_id === undefined ? {} : { attempt_id: input.attempt_id }),
    context_chars: input.contextChars,
    max_context_chars: input.maxContextChars,
    spec_fragment_count: input.specFragmentCount,
    code_context_item_count: input.codeContextItemCount,
    heading_miss_count: input.headingMissCount ?? 0,
    dropped_item_count: input.droppedItemCount ?? 0,
    spec_dropped_count: input.specDroppedCount ?? 0,
    code_context_dropped_count: input.codeContextDroppedCount ?? 0,
    code_context_rebuilt: input.codeContextRebuilt ?? false,
    cache_status: input.cacheStatus ?? "unknown",
    selected_chars: input.selectedChars ?? input.contextChars,
    selected_token_estimate:
      input.selectedTokenEstimate ?? estimateTokensFromChars(input.selectedChars ?? input.contextChars),
    exceeded: input.contextChars > input.maxContextChars,
    ...selectCompressionMetrics(input),
    ...selectCanaryFeatures(input.canaryFeatures, input.canarySizeFallback),
  };
}

/**
 * Literal token appended to `canary_features` (never a real feature name) when the size guard
 * sent a canary-cohort task down the raw path. Living in the SAME array as the real feature
 * names keeps `canary_features`' existing "empty means control" contract intact for every
 * reader that does not know this token.
 */
export const CANARY_SIZE_FALLBACK_MARKER = "size-fallback";

/**
 * Canary marker, or nothing at all. An empty cohort membership must not write an empty array:
 * "not in the canary" and "canary not configured" are the same control arm.
 */
function selectCanaryFeatures(
  features: readonly ContextCompressionFeature[] | undefined,
  sizeFallback: boolean | undefined,
): Pick<ContextSizeMetricsRecord, "canary_features"> {
  if (!features || features.length === 0) return {};
  return {
    canary_features: sizeFallback ? [...features, CANARY_SIZE_FALLBACK_MARKER] : [...features],
  };
}

/** Reads the canary marker back, rejecting a corrupted one rather than guessing the arm. */
function readCanaryFeatures(value: unknown): Pick<ContextSizeMetricsRecord, "canary_features"> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error("Invalid context size metrics log record: canary_features must be an array of feature names");
  }
  return value.length > 0 ? { canary_features: [...(value as string[])] } : {};
}

export function contextSizeMetricsLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "context-size.jsonl");
}

/** Attempt tapatybės portas (task 0045): E4 skaito aktyvų attempt manifestą; testai — stub. */
export type AttemptIdentityPort = {
  identityFields(taskId: string): Promise<Pick<ContextSizeMetricsRecord, "run_id" | "worker_id" | "runtime_attempt_id">>;
};

export async function appendContextSizeMetrics(
  fs: ContextPackFileSystemPort,
  runtimeRoot: string,
  record: ContextSizeMetricsRecord,
  attemptIdentity?: AttemptIdentityPort,
): Promise<void> {
  try {
    // Same identity source as the token-usage log, so a context-size record and a token-usage
    // record from the SAME attempt carry the SAME run_id/worker_id/runtime_attempt_id.
    const identity = attemptIdentity === undefined ? {} : await attemptIdentity.identityFields(record.task_id);
    const enriched: ContextSizeMetricsRecord = { ...record, ...identity };
    await fs.appendTextFile(contextSizeMetricsLogPath(runtimeRoot), `${JSON.stringify(enriched)}\n`);
  } catch {
    // Telemetrija yra best-effort; jos klaida negali sugriauti context-pack assembly.
  }
}

export async function readContextSizeMetrics(
  fs: ContextPackFileSystemPort,
  runtimeRoot: string,
): Promise<ContextSizeMetricsRecord[]> {
  const raw = (await fs.readTextFileIfExists(contextSizeMetricsLogPath(runtimeRoot))) ?? "";
  if (!raw.trim()) {
    return [];
  }

  const records: ContextSizeMetricsRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const record = JSON.parse(line) as Partial<ContextSizeMetricsRecord>;
    if (
      typeof record.task_id !== "string" ||
      typeof record.context_chars !== "number" ||
      typeof record.max_context_chars !== "number"
    ) {
      throw new Error("Invalid context size metrics log record: task_id, context_chars, and max_context_chars are required");
    }

    records.push({
      ts: typeof record.ts === "string" ? record.ts : "",
      task_id: record.task_id,
      ...(typeof record.attempt === "number" ? { attempt: record.attempt } : {}),
      ...(typeof record.attempt_id === "string" ? { attempt_id: record.attempt_id } : {}),
      ...(typeof record.run_id === "string" ? { run_id: record.run_id } : {}),
      ...(typeof record.worker_id === "string" ? { worker_id: record.worker_id } : {}),
      ...(typeof record.runtime_attempt_id === "string" ? { runtime_attempt_id: record.runtime_attempt_id } : {}),
      context_chars: record.context_chars,
      max_context_chars: record.max_context_chars,
      spec_fragment_count: typeof record.spec_fragment_count === "number" ? record.spec_fragment_count : 0,
      code_context_item_count: typeof record.code_context_item_count === "number" ? record.code_context_item_count : 0,
      heading_miss_count: typeof record.heading_miss_count === "number" ? record.heading_miss_count : 0,
      dropped_item_count: typeof record.dropped_item_count === "number" ? record.dropped_item_count : 0,
      // Senuose įrašuose lauko nėra — 0 čia reiškia „nefiksuota", ne „nieko neprarasta".
      spec_dropped_count: typeof record.spec_dropped_count === "number" ? record.spec_dropped_count : 0,
      code_context_dropped_count:
        typeof record.code_context_dropped_count === "number" ? record.code_context_dropped_count : 0,
      code_context_rebuilt: Boolean(record.code_context_rebuilt),
      cache_status: isContextCacheStatus(record.cache_status) ? record.cache_status : "unknown",
      selected_chars: typeof record.selected_chars === "number" ? record.selected_chars : record.context_chars,
      selected_token_estimate:
        typeof record.selected_token_estimate === "number"
          ? record.selected_token_estimate
          : estimateTokensFromChars(typeof record.selected_chars === "number" ? record.selected_chars : record.context_chars),
      exceeded: Boolean(record.exceeded),
      ...readCompressionMetrics(record),
      ...readCanaryFeatures(record.canary_features),
    });
  }

  return records;
}

export function latestContextSizeMetrics(records: ContextSizeMetricsRecord[]): ContextSizeMetricsRecord | undefined {
  return records.at(-1);
}

// `summarizeContextCacheMetrics` (hit/miss agregatas su `hit_ratio`) ištrinta 2026-08-23
// RAG audite: nė vieno kvietėjo nei produkcijoje, nei testuose — ir etalone jos nenaudojo
// niekas, išskyrus jo paties testą. Prireikus cache hit-ratio ataskaitos, ji rašoma iš
// naujo prie realaus vartotojo (report CLI), o ne laikoma čia kaip negyvas svoris.

function isContextCacheStatus(value: unknown): value is ContextCacheStatus {
  return value === "hit" || value === "miss" || value === "bypass" || value === "unknown";
}

// ---------------------------------------------------------------------------
// Task 0042: size-guard "did compression actually shrink what was sent" truth row.
// This is the join TARGET shape, not a new store — declared here so consumers that only need
// the shape do not have to import upward from the join that produces it.
// ---------------------------------------------------------------------------
export type PostRunTruthRow = {
  task_id: string;
  attempt?: number;
  attempt_id?: string;
  raw_chars: number;
  compiled_chars: number;
  input_tokens: number;
  cache_creation: number;
  billable: number;
  // `true`/`false` once the task reaches a terminal lifecycle state, explicit `null` while it
  // has none yet — never omitted, so "not decided yet" cannot be mistaken for "field not
  // measured" the way an absent optional key would read elsewhere in this file.
  accepted: boolean | null;
};
