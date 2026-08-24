// Whole-task ir fazių biudžeto vartai (etalono policy/tool-budget.ts vykdymo pusė, WBR VQ-305;
// TOK-1/TOK-2/TOK-4/0000-0a). Konfigo schema + loadToolBudget/selectToolBudget gyvena
// `policy-governance/tool-budget-config.ts`; usage ledger'io grynosios taisyklės —
// `domain/tokens/usage-ledger.ts`; vartų skaičiavimas — `tool-budget-rules.ts` (500 eil.
// gate skaidymas). Čia — IO orkestracija per `TokenBudgetGatePorts` (žurnalo/statuso/resets
// adapteriai — E4).
import path from "node:path";
import {
  buildTaskUsageLedger,
  parseTaskUsageEntries,
  type TaskPhase,
} from "../../domain/tokens/usage-ledger.js";
import { modelAllowed } from "../../domain/policies/model-policy-rules.js";
import {
  loadToolBudget,
  selectToolBudget,
  toolBudgetProfileSchema,
  type ToolBudgetName,
  type ToolBudgetProfile,
} from "../policy-governance/tool-budget-config.js";
import { loadContextBudget } from "../policy-governance/context-budget.js";
import { loadModelPolicy } from "../policy-governance/model-policy.js";
import type { PolicyConfigFileSystemPort } from "../policy-governance/ports.js";
import {
  billableCeiling,
  evaluateLedgerGate,
  type BudgetLedgerView,
  type BudgetPhaseStatus,
} from "./tool-budget-rules.js";

export type BudgetTool = "browser" | "scraper" | "mcp";

export type BudgetEnforcementRequest = {
  model: string;
  profile?: ToolBudgetName;
  contextPack: { allowed_paths?: unknown[]; [key: string]: unknown };
  requestedTools?: BudgetTool[];
  llmCalls?: number;
  /** Aiškus task ID; be jo imamas `contextPack.task_id` (repair pack'as jo gali neturėti). */
  taskId?: string;
  /** Fazė, kurios kvietimas ruošiamas — jai priskiriamas projektuojamas kvietimas. */
  phase?: TaskPhase;
};

export type BudgetEnforcementStatus = {
  ok: boolean;
  model: string;
  profile: ToolBudgetName;
  reasons: string[];
  context_chars: number;
  files: number;
  /** Migracijos kontraktas: implementacijos (dispatch + repair dispatch) kvietimai + 1. */
  llm_calls: number;
  requested_tools: BudgetTool[];
  task_id: string;
  /** Visų fazių LLM kvietimai plius projektuojamas kvietimas. */
  total_llm_calls: number;
  /** Visų fazių RAW tokenai su `cache_read` — DIAGNOSTIKA (0000-0a). */
  total_tokens: number;
  /** Visų fazių BILLABLE tokenai — kietų lubų bazė. */
  billable_tokens: number;
  phase_status: BudgetPhaseStatus[];
  /** True, kai nė vienas limitas dar nepasiekė soft slenksčio. */
  soft_ok: boolean;
  /** Soft slenkstį peržengę limitai (informacinis; kvietimo neblokuoja). */
  soft_reasons: string[];
  /** RAW perviršio diagnostika: lubas peržengė tik raw suma, billable — ne. */
  raw_notices: string[];
  /** Soft slenkstis pasiektas → prieš kvietimą numesk žemo prioriteto kontekstą. */
  reduce_context: boolean;
  limits: {
    max_llm_calls: number | null;
    max_total_llm_calls: number | null;
    /** Efektyvios whole-task BILLABLE lubos (`max_total_billable_tokens` arba legacy). */
    max_total_tokens: number | null;
  };
};

/**
 * Biudžeto vartų IO portai. `readTokenUsageLog` grąžina žalią `token-usage.jsonl` turinį
 * (tuščia eilutė, kai failo nėra); resets/status adapteriai rašo atominiu būdu.
 */
export type TokenBudgetGatePorts = {
  fs: PolicyConfigFileSystemPort;
  readTokenUsageLog(): Promise<string>;
  readLlmCallResets(): Promise<Record<string, unknown>>;
  writeLlmCallResets(resets: Record<string, unknown>): Promise<void>;
  /** Best-effort statuso veidrodis (`vq/state/token-budget-status.json` raktas → reikšmė). */
  writeBudgetStatus(key: string, status: unknown): Promise<void>;
  nowIso(): string;
};

/** `vq/state/llm-call-resets.json` — requeue biudžeto reset žymos. */
export function llmCallResetsPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "llm-call-resets.json");
}

/** `vq/state/token-budget-status.json` — paskutinių vartų sprendimų veidrodis. */
export function tokenBudgetStatusPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "token-budget-status.json");
}

/** `vq/logs/token-usage.jsonl` — append-only usage žurnalas (rašo E4 telemetrija). */
export function tokenUsageLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "token-usage.jsonl");
}

export async function enforceExecutionBudget(
  ports: TokenBudgetGatePorts,
  runtimeRoot: string,
  request: BudgetEnforcementRequest,
): Promise<BudgetEnforcementStatus> {
  const [contextBudget, toolBudget, modelPolicy] = await Promise.all([
    loadContextBudget(ports.fs, runtimeRoot),
    loadToolBudget(ports.fs, runtimeRoot),
    loadModelPolicy(ports.fs, runtimeRoot),
  ]);
  const profileName = request.profile ?? "default";
  const profile = selectToolBudget(toolBudget, profileName);
  const contextChars = JSON.stringify(request.contextPack).length;
  const files = Array.isArray(request.contextPack.allowed_paths) ? request.contextPack.allowed_paths.length : 0;
  const requestedTools = [...new Set(request.requestedTools ?? [])];
  const reasons: string[] = [];
  const maxContext = Math.min(contextBudget.max_context_chars, profile.max_context_chars ?? Number.MAX_SAFE_INTEGER);
  const maxFiles = Math.min(contextBudget.max_files, profile.max_files ?? Number.MAX_SAFE_INTEGER);

  const taskId = resolveTaskId(request);
  const projectedPhase = request.phase ?? "implementation";
  const gate = evaluateLedgerGate(await readTaskLedger(ports, taskId), profile, projectedPhase, request.llmCalls);
  reasons.push(...gate.hardReasons);

  if (!modelAllowed(modelPolicy, request.model)) reasons.push(`model not allowed: ${request.model}`);
  if (contextChars > maxContext) reasons.push(`context chars ${contextChars} > ${maxContext}`);
  if (files > maxFiles) reasons.push(`context files ${files} > ${maxFiles}`);

  for (const tool of requestedTools) if (!profile[tool]) reasons.push(`tool not allowed: ${tool}`);

  const status: BudgetEnforcementStatus = {
    ok: reasons.length === 0,
    model: request.model,
    profile: profileName,
    reasons,
    context_chars: contextChars,
    files,
    llm_calls: gate.llmCalls,
    requested_tools: requestedTools,
    task_id: taskId,
    total_llm_calls: gate.totalLlmCalls,
    total_tokens: gate.totalTokens,
    billable_tokens: gate.billableTokens,
    phase_status: gate.phaseStatus,
    soft_ok: gate.softReasons.length === 0,
    soft_reasons: gate.softReasons,
    raw_notices: gate.rawNotices,
    reduce_context: gate.softReasons.length > 0,
    limits: {
      max_llm_calls: profile.max_llm_calls ?? null,
      max_total_llm_calls: profile.max_total_llm_calls ?? null,
      max_total_tokens: billableCeiling(profile.max_total_billable_tokens, profile.max_total_tokens) ?? null,
    },
  };
  await ports.writeBudgetStatus("budget_enforcement", status);
  return status;
}

/**
 * Vieno LLM kvietimo autorizacija PRIEŠ jo paleidimą (TOK-2).
 *
 * Sąmoningai siauresnė nei `enforceExecutionBudget`: tikrina TIK whole-task ir fazės
 * ledger'io ribas. Konteksto dydis, modelio politika ir įrankių leidimai yra dispatch kelio
 * atsakomybė — preflight/diagnose kvietimai context-pack'o neturi, o jų blokavimas dėl
 * trūkstamo modelio konfigo būtų klaidingas ne-AG target projektuose.
 *
 * Trūkstamas/sugadintas `tool-budget.json` NEBLOKUOJA kvietimo — galioja numatytieji fazių
 * rezervai, kaip ir kiekviename kitame politikos loaderyje.
 */
export type LlmCallAuthorizationRequest = {
  taskId: string;
  phase: TaskPhase;
  profile?: ToolBudgetName;
  /** Aiškus projektuojamas fazės kvietimų skaičius; nenurodžius — ledger + 1. */
  llmCalls?: number;
};

export type LlmCallAuthorization = {
  allowed: boolean;
  task_id: string;
  phase: TaskPhase;
  /** Soft riba pasiekta — numesk žemo prioriteto kontekstą prieš kvietimą. */
  reduce_context: boolean;
  hard_reasons: string[];
  soft_reasons: string[];
  /** RAW perviršio diagnostika (0000-0a); NIEKADA neverčia {@link allowed} į `false`. */
  raw_notices: string[];
  total_llm_calls: number;
  /** RAW suma su `cache_read` — diagnostika. */
  total_tokens: number;
  /** BILLABLE suma — kietų lubų bazė. */
  billable_tokens: number;
  remaining_total_llm_calls: number | null;
  /** Likę BILLABLE tokenai iki whole-task lubų; maitina mid-dispatch stabdiklį. */
  remaining_total_tokens: number | null;
  phase_status: BudgetPhaseStatus[];
};

export async function authorizeLlmCall(
  ports: TokenBudgetGatePorts,
  runtimeRoot: string,
  request: LlmCallAuthorizationRequest,
): Promise<LlmCallAuthorization> {
  const profile = await loadToolBudgetProfileOrFailsafe(ports.fs, runtimeRoot, request.profile ?? "default");
  const ledger = await readTaskLedger(ports, request.taskId.trim());
  const gate = evaluateLedgerGate(ledger, profile, request.phase, request.llmCalls);

  const authorization: LlmCallAuthorization = {
    allowed: gate.hardReasons.length === 0,
    task_id: request.taskId.trim(),
    phase: request.phase,
    reduce_context: gate.softReasons.length > 0,
    hard_reasons: gate.hardReasons,
    soft_reasons: gate.softReasons,
    raw_notices: gate.rawNotices,
    total_llm_calls: gate.totalLlmCalls,
    total_tokens: gate.totalTokens,
    billable_tokens: gate.billableTokens,
    remaining_total_llm_calls: gate.remainingTotalLlmCalls,
    remaining_total_tokens: gate.remainingTotalTokens,
    phase_status: gate.phaseStatus,
  };
  await ports.writeBudgetStatus("llm_call_authorization", authorization);
  return authorization;
}

/** Trūkstamas/sugadintas konfigas → numatytieji rezervai, ne užrakintas loop'as. */
async function loadToolBudgetProfileOrFailsafe(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
  name: ToolBudgetName,
): Promise<ToolBudgetProfile> {
  try {
    return selectToolBudget(await loadToolBudget(fs, runtimeRoot), name);
  } catch {
    return toolBudgetProfileSchema.parse({});
  }
}

function resolveTaskId(request: BudgetEnforcementRequest): string {
  const explicit = request.taskId?.trim();
  if (explicit) return explicit;
  return typeof request.contextPack["task_id"] === "string" ? (request.contextPack["task_id"]).trim() : "";
}

// `assertExecutionBudget` ištrintas 2026-08-24: metantis apvalkalas aplink `enforceExecutionBudget`
// be nė vieno kvietėjo. Jis prieštaravo ir šio klasterio taisyklei „atmetimas yra REIKŠMĖ, ne
// išimtis" — sprendimą priima `status.ok`, o ne `try/catch`. Tikrasis vartas prijungtas
// (`composition/loop/coordinator-execution-adapters`), tad kartu nedingo jokia patikra.

/**
 * Etalono 1073/1074 lockout pamoka: token-usage.jsonl yra append-only visai task'o
 * istorijai, tad requeue (aiškus žmogaus „bandyk dar kartą") biudžeto skaitiklio
 * NEatstatydavo — infra-nutrauktų ratų istorija stumdavo taską į amžiną "LLM calls N > max"
 * parkinimą. Requeue dabar įrašo reset žymą; projekcija skaičiuoja tik įrašus PO jos.
 */
export async function recordLlmCallReset(ports: TokenBudgetGatePorts, taskId: string): Promise<void> {
  const existing = await ports.readLlmCallResets();
  await ports.writeLlmCallResets({ ...existing, [taskId]: ports.nowIso() });
}

async function llmCallResetAt(ports: TokenBudgetGatePorts, taskId: string): Promise<string | undefined> {
  const resets = await ports.readLlmCallResets();
  const value = resets[taskId];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** `logTokenUsage` infra outcome — 429/usage-limit nutrauktas kvietimas. */
function isInfrastructureUsageEntry(entry: { outcome?: unknown }): boolean {
  return typeof entry.outcome === "string" && entry.outcome.trim().toLowerCase() === "infrastructure";
}

async function readTaskLedger(ports: TokenBudgetGatePorts, taskId: string): Promise<BudgetLedgerView> {
  if (!taskId) {
    const empty = buildTaskUsageLedger("", []);
    return { full: empty, chargeable: empty };
  }
  const resetAt = await llmCallResetAt(ports, taskId);
  const raw = await ports.readTokenUsageLog();
  const entries = parseTaskUsageEntries(raw);
  const since = resetAt === undefined ? {} : { since: resetAt };
  return {
    full: buildTaskUsageLedger(taskId, entries, since),
    chargeable: buildTaskUsageLedger(taskId, entries.filter((entry) => !isInfrastructureUsageEntry(entry)), since),
  };
}
