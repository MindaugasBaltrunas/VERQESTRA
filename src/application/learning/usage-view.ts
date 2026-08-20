// Learning klasterio telemetrijos skaitymo vaizdas: tolerantiški `token-usage.jsonl` ir
// `task-events.jsonl` parseriai. Elgesio etalonas: AG_loop runtime/token-usage.ts
// `readTokenUsageRecordsTolerant` (sugadinta eilutė praleidžiama, o ne nuverčia UI
// atsakymą į 500 — 2026-08-06 auditas) ir core/fs `readJsonl({tolerant:true})`.
// Griežtas skaitymas (benchmark integrity kelias) čia NEgyvena — žr.
// application/benchmark/capture-baseline.ts.

/**
 * Learning/analytics pusės token-usage įrašas. Struktūriškai tenkina
 * `CohortTokenUsageRecord` (analytics/cohort-model), tad tas pats masyvas eina ir į
 * compression cohort join'ą be kopijų.
 */
export type LearningUsageRecord = {
  ts: string;
  task_id: string;
  phase: string;
  model: string;
  attempt?: number;
  retry_reason?: string;
  task_phase?: string;
  num_turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  run_id?: string;
  worker_id?: string;
  runtime_attempt_id?: string;
};

/** Task perėjimo eilutė, kokią mato learning analitika (žurnalo `ts` čia privalomas darbui su laiku). */
export type LearningTaskEventRecord = {
  ts: string;
  task_id: string;
  to_state: string;
  reason?: string;
  phase?: string;
  verdict?: string;
  exit_code?: number;
  detail?: string;
};

export function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageRecordTotalTokens(record: LearningUsageRecord): number {
  return (
    numericUsage(record.input_tokens) +
    numericUsage(record.output_tokens) +
    numericUsage(record.cache_read_input_tokens) +
    numericUsage(record.cache_creation_input_tokens)
  );
}

export function usageRecordCacheTokens(record: LearningUsageRecord): number {
  return numericUsage(record.cache_read_input_tokens) + numericUsage(record.cache_creation_input_tokens);
}

/** Tolerantiškas JSONL: neparsinama arba ne-objekto eilutė kainuoja tik save pačią. */
export function parseJsonlObjects(raw: string | undefined): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch {
      // tolerant: sugadinti duomenys degraduoja skaičius, o ne nuverčia atsakymą
    }
  }
  return rows;
}

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Tolerantiškas usage skaitymas: eilutė be phase/task_id/model eilučių — praleidžiama. */
export function parseTolerantUsageRecords(raw: string | undefined): LearningUsageRecord[] {
  return parseJsonlObjects(raw).flatMap((row) => {
    const phase = row["phase"];
    const taskId = row["task_id"];
    const model = row["model"];
    if (typeof phase !== "string" || typeof model !== "string" || typeof taskId !== "string") return [];

    const attempt = optionalNumber(row["attempt"]);
    const retryReason = optionalString(row["retry_reason"]);
    const taskPhase = optionalString(row["task_phase"]);
    const numTurns = optionalNumber(row["num_turns"]);
    const inputTokens = optionalNumber(row["input_tokens"]);
    const outputTokens = optionalNumber(row["output_tokens"]);
    const cacheRead = optionalNumber(row["cache_read_input_tokens"]);
    const cacheCreation = optionalNumber(row["cache_creation_input_tokens"]);
    const runId = optionalString(row["run_id"]);
    const workerId = optionalString(row["worker_id"]);
    const runtimeAttemptId = optionalString(row["runtime_attempt_id"]);
    return [
      {
        ts: typeof row["ts"] === "string" ? row["ts"] : "",
        task_id: taskId,
        phase,
        model,
        ...(attempt === undefined ? {} : { attempt }),
        ...(retryReason === undefined ? {} : { retry_reason: retryReason }),
        ...(taskPhase === undefined ? {} : { task_phase: taskPhase }),
        ...(numTurns === undefined ? {} : { num_turns: numTurns }),
        ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
        ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
        ...(cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead }),
        ...(cacheCreation === undefined ? {} : { cache_creation_input_tokens: cacheCreation }),
        ...(runId === undefined ? {} : { run_id: runId }),
        ...(workerId === undefined ? {} : { worker_id: workerId }),
        ...(runtimeAttemptId === undefined ? {} : { runtime_attempt_id: runtimeAttemptId }),
      },
    ];
  });
}

/** Tolerantiškas task-events skaitymas: eilutė be ts/task_id/to_state — praleidžiama. */
export function parseTolerantTaskEvents(raw: string | undefined): LearningTaskEventRecord[] {
  return selectLearningTaskEvents(parseJsonlObjects(raw));
}

/** Ta pati atranka virš jau parsintų eilučių — kvietėjui, kuris žurnalą skaito vieną kartą. */
export function selectLearningTaskEvents(rows: readonly Record<string, unknown>[]): LearningTaskEventRecord[] {
  return rows.flatMap((row) => {
    const ts = row["ts"];
    const taskId = row["task_id"];
    const toState = row["to_state"];
    if (typeof ts !== "string" || typeof taskId !== "string" || typeof toState !== "string") return [];

    const reason = optionalString(row["reason"]);
    const phase = optionalString(row["phase"]);
    const verdict = optionalString(row["verdict"]);
    const exitCode = optionalNumber(row["exit_code"]);
    const detail = optionalString(row["detail"]);
    return [
      {
        ts,
        task_id: taskId,
        to_state: toState,
        ...(reason === undefined ? {} : { reason }),
        ...(phase === undefined ? {} : { phase }),
        ...(verdict === undefined ? {} : { verdict }),
        ...(exitCode === undefined ? {} : { exit_code: exitCode }),
        ...(detail === undefined ? {} : { detail }),
      },
    ];
  });
}
