// Task 0042: size-guard „ar kompresija realiai sumažino tai, kas išsiųsta" truth join'as.
// Elgesio etalonas: AG_loop orchestrator/post-run-truth-join.ts.
//
// Grynas join modulis, be IO ir be naujo žurnalo: sulanksto jau perskaitytus
// `context-size.jsonl` įrašus, `token-usage.jsonl` įrašus ir task gyvavimo ciklo įvykius
// į vieną eilutės formą (`PostRunTruthRow`), per dispatch bandymą atsakančią „koks buvo
// prompt'as, kiek token'ų realiai kainavo ir ar task'as priimtas" — trys faktai, kurių
// size guard'o kompresijos sprendimo teismui reikia ir kurių nė vienas negyvena vienoje
// saugykloje.
//
// VERQESTRA pastaba: etalone modulis gyveno orchestrator/ (kompozicijos) sluoksnyje, nes
// importavo IR context-pack tipą, IR runtime token-usage tipą. Čia token-usage pusės tipas
// deklaruotas STRUKTŪRIŠKAI (be importo iš runtime/E4), tad modulis teisėtai gyvena
// analytics klasteryje; compression-cohorts jo neimportuoja (žr. jo pastabą) — kryptis
// lieka vienpusė.

import type { ContextSizeMetricsRecord, PostRunTruthRow } from "../context-pack/metrics.js";

export type PostRunAcceptanceEvent = { task_id: string; ts?: string; to_state?: string };

type JoinableContextSizeRecord = Pick<
  ContextSizeMetricsRecord,
  "task_id" | "attempt" | "attempt_id" | "raw_task_chars" | "worker_prompt_chars"
>;

/** Struktūrinis token-usage įrašo poaibis — jokio importo iš runtime skaitytojų. */
export type JoinableTokenUsageRecord = {
  task_id: string;
  attempt?: number;
  attempt_id?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** Neigiami terminaliniai gyvavimo ciklo state'ai (`to_state`); visa kita — pending. */
const NEGATIVE_TERMINAL_STATES = new Set(["human-review", "failed", "rolled-back"]);

function numeric(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function taskAttemptKey(taskId: string, attempt: number): string {
  return `${taskId}#${attempt}`;
}

/**
 * Trys lookup žemėlapiai virš TŲ PAČIŲ token-usage įrašų, mažėjančio specifiškumo tvarka.
 * Statomi kartą per kvietimą, o ne ieškomi tiesiškai per kiekvieną context-size įrašą, ir
 * pildomi vienu forward pass'u, tad dublikato raktas išsprendžiamas į PASKUTINĮ
 * (append-only, chronologinio) įvesties masyvo įrašą — ta pati „last write wins" taisyklė,
 * kurią `assignArms` compression-cohorts'e taiko per `ts` palyginimą; čia jos reikia be
 * `ts` lauko ant susiaurinto įrašo.
 */
function indexTokenUsageRecords(records: readonly JoinableTokenUsageRecord[]): {
  byAttemptId: Map<string, JoinableTokenUsageRecord>;
  byTaskAttempt: Map<string, JoinableTokenUsageRecord>;
  byTaskId: Map<string, JoinableTokenUsageRecord>;
} {
  const byAttemptId = new Map<string, JoinableTokenUsageRecord>();
  const byTaskAttempt = new Map<string, JoinableTokenUsageRecord>();
  const byTaskId = new Map<string, JoinableTokenUsageRecord>();

  for (const record of records) {
    const taskId = record.task_id;
    if (!taskId) continue;
    if (record.attempt_id) byAttemptId.set(record.attempt_id, record);
    if (record.attempt !== undefined) byTaskAttempt.set(taskAttemptKey(taskId, record.attempt), record);
    byTaskId.set(taskId, record);
  }

  return { byAttemptId, byTaskAttempt, byTaskId };
}

/**
 * Suranda atitinkantį token-usage įrašą vienam context-size įrašui, specifiškiausias raktas
 * pirmas: `attempt_id` (yra abiejose pusėse), tada `task_id` + `attempt`, tada vien
 * `task_id`. Specifiškesnis raktas, egzistuojantis context-size pusėje be partnerio
 * token-usage indekse, krenta prie kito rakto, o ne pasiduoda — abu žurnalus rašo skirtingi
 * kodo keliai ir jie negarantuoja, kad tam pačiam dispatch'ui užpildė tuos pačius tapatybės
 * laukus.
 */
function resolveTokenUsageMatch(
  contextRecord: JoinableContextSizeRecord,
  index: ReturnType<typeof indexTokenUsageRecords>,
): JoinableTokenUsageRecord | undefined {
  if (contextRecord.attempt_id) {
    const byAttemptId = index.byAttemptId.get(contextRecord.attempt_id);
    if (byAttemptId) return byAttemptId;
  }
  if (contextRecord.attempt !== undefined) {
    const byTaskAttempt = index.byTaskAttempt.get(taskAttemptKey(contextRecord.task_id, contextRecord.attempt));
    if (byTaskAttempt) return byTaskAttempt;
  }
  return index.byTaskId.get(contextRecord.task_id);
}

/**
 * Vėliausias gyvavimo ciklo įvykis per task'ą (veidrodis compression-cohorts
 * `latestEventByTask`): append tvarka laimi tarp lygių/neparsinamų laiko žymų.
 */
function latestAcceptanceByTask(events: readonly PostRunAcceptanceEvent[]): Map<string, string> {
  const byTask = new Map<string, { state: string; at: number }>();
  for (const event of events) {
    const taskId = event.task_id;
    const state = typeof event.to_state === "string" ? event.to_state.trim() : "";
    if (!taskId || !state) continue;
    const parsed = Date.parse(event.ts ?? "");
    const at = Number.isFinite(parsed) ? parsed : 0;
    const current = byTask.get(taskId);
    if (!current || at >= current.at) byTask.set(taskId, { state, at });
  }
  return new Map([...byTask].map(([taskId, value]) => [taskId, value.state]));
}

/** `done` -> accepted, žinomas neigiamas terminalinis state -> rejected, visa kita -> pending. */
function resolveAccepted(state: string | undefined): boolean | null {
  if (state === "done") return true;
  if (state !== undefined && NEGATIVE_TERMINAL_STATES.has(state)) return false;
  return null;
}

/**
 * Sujungia per-attempt context-size, token-usage ir lifecycle telemetriją į eilutes, kurių
 * reikia promotion sprendimui.
 *
 * Context-size įrašas be `worker_prompt_chars` (nėra patikimo compiled_chars matavimo) arba
 * be `raw_task_chars` yra IŠMETAMAS, o ne emituojamas su išgalvotu/nuliniu dydžiu —
 * `workerPromptChars` telemetrijoje dar neturi rašytojo (realus dispatched prompt dydis
 * žinomas tik dispatch'ui išsprendus kanoninį prompt'ą), tad jo nebuvimas čia laukiamas, ne
 * šio join'o klaida. Įrašas be atitinkančio token-usage taip pat išmetamas:
 * `input_tokens`/`cache_creation` yra neprivalomi tik įvestyje — `PostRunTruthRow` juos
 * deklaruoja privalomais, o iš chars išvesta reikšmė būtų būtent ta „chars/4 pateikta kaip
 * apskaita" klaida, kuriai išvengti šis task'as egzistuoja.
 */
export function joinPostRunTruth(
  contextSizeRecords: readonly JoinableContextSizeRecord[],
  tokenUsageRecords: readonly JoinableTokenUsageRecord[],
  taskEvents: readonly PostRunAcceptanceEvent[],
): PostRunTruthRow[] {
  const tokenUsageIndex = indexTokenUsageRecords(tokenUsageRecords);
  const acceptanceByTask = latestAcceptanceByTask(taskEvents);

  const rows: PostRunTruthRow[] = [];
  for (const contextRecord of contextSizeRecords) {
    if (contextRecord.raw_task_chars === undefined || contextRecord.worker_prompt_chars === undefined) continue;

    const usage = resolveTokenUsageMatch(contextRecord, tokenUsageIndex);
    if (!usage) continue;

    const inputTokens = numeric(usage.input_tokens);
    const outputTokens = numeric(usage.output_tokens);
    const cacheCreation = numeric(usage.cache_creation_input_tokens);
    const attempt = contextRecord.attempt ?? usage.attempt;
    const attemptId = contextRecord.attempt_id ?? usage.attempt_id;

    rows.push({
      task_id: contextRecord.task_id,
      ...(attempt === undefined ? {} : { attempt }),
      ...(attemptId === undefined ? {} : { attempt_id: attemptId }),
      raw_chars: contextRecord.raw_task_chars,
      compiled_chars: contextRecord.worker_prompt_chars,
      input_tokens: inputTokens,
      cache_creation: cacheCreation,
      billable: inputTokens + outputTokens + cacheCreation,
      accepted: resolveAccepted(acceptanceByTask.get(contextRecord.task_id)),
    });
  }

  return rows;
}
