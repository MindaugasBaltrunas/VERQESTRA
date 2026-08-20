// Token usage žurnalo (`token-usage.jsonl`) GRYNOSIOS taisyklės: fazių taksonomija,
// įrašų klasifikacija ir whole-task ledger'io statyba (etalono core/schema.ts usage blokas,
// WBR VQ-305). Žurnalo skaitymas/rašymas — E4; čia tik tekstas → struktūra.

/**
 * Kanoninė task fazių taksonomija. Tvarka yra reikšminga — ji apibrėžia
 * deterministinę ledger'io fazių eiliškumo tvarką ataskaitose.
 */
export const TASK_PHASES = [
  "planning",
  "preflight",
  "implementation",
  "diagnosis",
  "repair",
  "integration-review",
  "other",
] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

const TASK_PHASE_INDEX = new Map<TaskPhase, number>(TASK_PHASES.map((phase, index) => [phase, index]));

/**
 * Neapdorotą telemetrijos `phase` reikšmę susieja su kanonine faze.
 *
 * `token-usage.jsonl` yra append-only per visas formato kartas, tad mapping'as privalo
 * suprasti istorinius vardus (`dispatch`, `diagnose-fastpath`, `preflight-miss`,
 * `bootstrap-*`) — jų perrašyti negalima ir nereikia.
 */
export function canonicalTaskPhase(phase: string): TaskPhase {
  const normalized = phase.trim().toLowerCase();
  if (!normalized) return "other";
  if (TASK_PHASE_INDEX.has(normalized as TaskPhase)) return normalized as TaskPhase;
  if (normalized.startsWith("preflight")) return "preflight";
  if (normalized.startsWith("dispatch") || normalized.startsWith("implementation")) return "implementation";
  if (normalized.startsWith("diagnos")) return "diagnosis";
  if (normalized.startsWith("repair")) return "repair";
  if (normalized.startsWith("integration")) return "integration-review";
  if (normalized.startsWith("plan") || normalized.startsWith("bootstrap")) return "planning";
  if (normalized === "task-generate" || normalized === "context-pack") return "planning";
  return "other";
}

const CANONICAL_MODEL_TIERS = ["haiku", "sonnet", "opus", "fable"] as const;

/**
 * Ataskaitinė konkretaus Claude modelio ID tapatybė (etalonas: runtime/token-usage.ts).
 * Vykdymas gali įrašyti pilną provider ID, o policy keliai — trumpą tier vardą; analitika
 * abu privalo laikyti tuo pačiu modeliu. Ne-Claude adapteriai ir `none` lieka atskiri.
 */
export function canonicalTokenUsageModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  for (const tier of CANONICAL_MODEL_TIERS) {
    if (normalized === tier || normalized === `claude-${tier}` || normalized.startsWith(`claude-${tier}-`)) {
      return tier;
    }
  }
  return normalized || "unknown";
}

/**
 * Struktūrinis vienos `token-usage.jsonl` eilutės atitikmuo. Visi laukai yra `unknown`,
 * nes žurnalas kaupiamas per kelias formato kartas ir jo eilutės negali būti laikomos
 * schema-validžiomis.
 */
export type TaskUsageEntry = {
  task_id?: unknown;
  phase?: unknown;
  /** Naujesnių įrašų aiški kanoninė fazė; senuose įrašuose jos nėra ir ji išvedama. */
  task_phase?: unknown;
  model?: unknown;
  ts?: unknown;
  attempt?: unknown;
  outcome?: unknown;
  retry_reason?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  total_cost_usd?: unknown;
};

/**
 * TOK-4: realus modelio kvietimas atskiriamas nuo infra įvykio.
 *
 * - `model-call` — modelis grąžino realią usage; TIK šis skaičiuojamas kaip LLM kvietimas.
 * - `zero-usage` — kvietimas bandytas, bet usage nulinė arba jos nėra (429/usage-limit,
 *   spawn abort). Nedega biudžeto ir nėra nesėkmingas bandymas, bet lieka audit trail.
 * - `deterministic` — fast-path/local sprendimas be modelio; jį žymi TIK aiškus `model: "none"`.
 *
 * Trūkstamas `model` laukas NĖRA laikomas deterministiniu: reali usage yra pakankamas
 * įrodymas, kad kvietimas įvyko, o senesnio formato eilutės modelio vardo neturi.
 */
export type TaskUsageCallKind = "model-call" | "zero-usage" | "deterministic";

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function taskUsageTokenTotal(entry: TaskUsageEntry): number {
  return (
    usageNumber(entry.input_tokens) +
    usageNumber(entry.output_tokens) +
    usageNumber(entry.cache_read_input_tokens) +
    usageNumber(entry.cache_creation_input_tokens)
  );
}

export function classifyTaskUsageCall(entry: TaskUsageEntry): TaskUsageCallKind {
  const model = typeof entry.model === "string" ? entry.model.trim().toLowerCase() : "";
  if (model === "none") return "deterministic";
  return taskUsageTokenTotal(entry) > 0 ? "model-call" : "zero-usage";
}

/**
 * Įrašo kanoninė fazė.
 *
 * Aiškus `task_phase` laukas laimi. Jo neturintys istoriniai įrašai išvedami iš `phase`,
 * o repair dispatch'ai atpažįstami iš retry metaduomenų: jie loginami po tuo pačiu
 * `phase: "dispatch"` vardu su `retry_reason`/`attempt > 1`, tad be šio žingsnio visa
 * repair usage pasislėptų implementacijos fazėje.
 */
export function taskPhaseOfEntry(entry: TaskUsageEntry): TaskPhase {
  if (typeof entry.task_phase === "string" && entry.task_phase.trim()) {
    return canonicalTaskPhase(entry.task_phase);
  }

  const phase = canonicalTaskPhase(typeof entry.phase === "string" ? entry.phase : "");
  if (phase !== "implementation") return phase;

  const attempt = usageNumber(entry.attempt);
  const retryReason = typeof entry.retry_reason === "string" ? entry.retry_reason.trim() : "";
  return retryReason.length > 0 || attempt > 1 ? "repair" : "implementation";
}

export type TaskUsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** RAW bazė: apima ir cache read, kad konteksto pernaudojimas būtų matomas. */
  total_tokens: number;
  /** Be cache read — kietų lubų ir kaštų bazė. */
  billable_tokens: number;
  total_cost_usd: number;
};

export function emptyTaskUsageTotals(): TaskUsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    billable_tokens: 0,
    total_cost_usd: 0,
  };
}

export function addTaskUsageTotals(a: TaskUsageTotals, b: TaskUsageTotals): TaskUsageTotals {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    billable_tokens: a.billable_tokens + b.billable_tokens,
    total_cost_usd: a.total_cost_usd + b.total_cost_usd,
  };
}

export function taskUsageTotalsFromEntry(entry: TaskUsageEntry): TaskUsageTotals {
  const input = usageNumber(entry.input_tokens);
  const output = usageNumber(entry.output_tokens);
  const cacheRead = usageNumber(entry.cache_read_input_tokens);
  const cacheCreation = usageNumber(entry.cache_creation_input_tokens);
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    total_tokens: input + output + cacheRead + cacheCreation,
    billable_tokens: input + output + cacheCreation,
    total_cost_usd: usageNumber(entry.total_cost_usd),
  };
}

export type TaskUsagePhaseLedger = {
  phase: TaskPhase;
  /** Neapdoroti telemetrijos fazių vardai, sudėti į šią kanoninę fazę (rūšiuoti). */
  raw_phases: string[];
  records: number;
  llm_calls: number;
  zero_usage_events: number;
  deterministic_events: number;
  usage: TaskUsageTotals;
};

export type TaskUsageLedger = {
  task_id: string;
  records: number;
  llm_calls: number;
  zero_usage_events: number;
  deterministic_events: number;
  usage: TaskUsageTotals;
  /** Tik stebėtos fazės, kanonine `TASK_PHASES` tvarka. */
  phases: TaskUsagePhaseLedger[];
  first_ts: string | null;
  last_ts: string | null;
};

export function emptyTaskUsageLedger(taskId: string): TaskUsageLedger {
  return {
    task_id: taskId,
    records: 0,
    llm_calls: 0,
    zero_usage_events: 0,
    deterministic_events: 0,
    usage: emptyTaskUsageTotals(),
    phases: [],
    first_ts: null,
    last_ts: null,
  };
}

/**
 * Vieno task'o ledger iš telemetrijos įrašų.
 *
 * Determinizmas: fazės rūšiuojamos kanonine `TASK_PHASES` tvarka, o bendros sumos
 * skaičiuojamos iš fazių įrašų, todėl invariantas „visuma = fazių suma" yra struktūrinis,
 * o ne tik testuojamas.
 *
 * `options.since` atkartoja requeue biudžeto reset semantiką: skaičiuojami tik įrašai,
 * kurių `ts` griežtai vėlesnis už žymą. Įrašas be `ts` (senas formatas) po reset'o pagal
 * apibrėžimą yra ankstesnis ir praleidžiamas.
 */
export function buildTaskUsageLedger(
  taskId: string,
  entries: TaskUsageEntry[],
  options: { since?: string } = {},
): TaskUsageLedger {
  const buckets = new Map<TaskPhase, TaskUsagePhaseLedger & { rawPhases: Set<string> }>();
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const entry of entries) {
    if (typeof entry.task_id !== "string" || entry.task_id !== taskId) continue;

    const ts = typeof entry.ts === "string" ? entry.ts : "";
    if (options.since !== undefined && !(ts > options.since)) continue;

    const phase = taskPhaseOfEntry(entry);
    let bucket = buckets.get(phase);
    if (!bucket) {
      bucket = {
        phase,
        raw_phases: [],
        rawPhases: new Set<string>(),
        records: 0,
        llm_calls: 0,
        zero_usage_events: 0,
        deterministic_events: 0,
        usage: emptyTaskUsageTotals(),
      };
      buckets.set(phase, bucket);
    }

    bucket.records += 1;
    bucket.rawPhases.add(typeof entry.phase === "string" && entry.phase.trim() ? entry.phase.trim() : "unknown");
    const kind = classifyTaskUsageCall(entry);
    if (kind === "model-call") bucket.llm_calls += 1;
    else if (kind === "zero-usage") bucket.zero_usage_events += 1;
    else bucket.deterministic_events += 1;
    bucket.usage = addTaskUsageTotals(bucket.usage, taskUsageTotalsFromEntry(entry));

    if (ts) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
  }

  const phases: TaskUsagePhaseLedger[] = [...buckets.values()]
    .sort((a, b) => (TASK_PHASE_INDEX.get(a.phase) ?? 0) - (TASK_PHASE_INDEX.get(b.phase) ?? 0))
    .map(({ rawPhases, ...phase }) => ({ ...phase, raw_phases: [...rawPhases].sort() }));

  const ledger = emptyTaskUsageLedger(taskId);
  for (const phase of phases) {
    ledger.records += phase.records;
    ledger.llm_calls += phase.llm_calls;
    ledger.zero_usage_events += phase.zero_usage_events;
    ledger.deterministic_events += phase.deterministic_events;
    ledger.usage = addTaskUsageTotals(ledger.usage, phase.usage);
  }
  ledger.phases = phases;
  ledger.first_ts = firstTs;
  ledger.last_ts = lastTs;
  return ledger;
}

/** JSONL → įrašai. Telemetrija best-effort: sugadinta eilutė nestabdo biudžeto vartų. */
export function parseTaskUsageEntries(raw: string): TaskUsageEntry[] {
  const entries: TaskUsageEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Telemetrija yra best-effort; sugadinta eilutė nestabdo biudžeto vartų.
    }
  }
  return entries;
}
