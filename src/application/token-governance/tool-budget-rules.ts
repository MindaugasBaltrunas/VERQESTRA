// Tool-budget vartų GRYNOSIOS taisyklės (etalono policy/tool-budget.ts skaičiavimo pusė,
// WBR VQ-305; skaidymas pagal 500 eil. gate — IO orkestracija gyvena tool-budget-gates.ts).
// Vienas ledger'io vartų skaičiavimas, kurį dalinasi pilnas dispatch enforcement'as ir
// plonas prieš-kvietimo autorizavimas — be bendros funkcijos šios dvi vietos neišvengiamai
// išsiskirtų fazių limitų semantika.
import {
  TASK_PHASES,
  canonicalTaskPhase,
  type TaskPhase,
  type TaskUsageLedger,
} from "../../domain/tokens/usage-ledger.js";
import type { TaskPhaseBudget, ToolBudgetProfile } from "../policy-governance/tool-budget-config.js";

/** Vienos kanoninės fazės biudžeto būsena (TOK-2). */
export type BudgetPhaseStatus = {
  phase: TaskPhase;
  records: number;
  llm_calls: number;
  zero_usage_events: number;
  /** RAW suma su `cache_read` — DIAGNOSTIKA (0000-0a); kieti sprendimai ja nesiremia. */
  total_tokens: number;
  /** Fazės BILLABLE suma (`input + output + cache_creation`) — lyginama su {@link max_tokens}. */
  billable_tokens: number;
  max_llm_calls: number | null;
  /** Efektyvios fazės BILLABLE lubos (`max_billable_tokens`, arba legacy `max_tokens`). */
  max_tokens: number | null;
  ok: boolean;
  /** False, kai fazė peržengė soft slenkstį, bet dar telpa į hard ribą. */
  soft_ok: boolean;
};

// TOK-2 fazių biudžeto rezervai: whole-task biudžetas paverčiamas fazių dalimis, todėl viena
// fazė nebegali sudeginti viso task'o lango. Du sąmoningi apribojimai (1103 migracijos
// kontraktas „konfigas tyli → jokių naujų blokavimų"): rezervas išvedamas TIK iš deklaruoto
// whole-task limito ir galioja TIK fazei, kurios kvietimas ruošiamas.
export type PhaseBudgetReserve = {
  /** Kvietimų grindys: fazei visada paliekama bent tiek kvietimų. */
  maxLlmCalls: number;
  /** Whole-task token biudžeto dalis, rezervuota šiai fazei. Suma = 1. */
  tokenShare: number;
};

export const DEFAULT_PHASE_BUDGET_RESERVES: Record<TaskPhase, PhaseBudgetReserve> = {
  planning: { maxLlmCalls: 3, tokenShare: 0.05 },
  preflight: { maxLlmCalls: 4, tokenShare: 0.1 },
  implementation: { maxLlmCalls: 3, tokenShare: 0.45 },
  diagnosis: { maxLlmCalls: 4, tokenShare: 0.1 },
  repair: { maxLlmCalls: 3, tokenShare: 0.2 },
  "integration-review": { maxLlmCalls: 3, tokenShare: 0.07 },
  other: { maxLlmCalls: 6, tokenShare: 0.03 },
};

/**
 * Soft slenkstis: kokią hard ribos dalį pasiekus kvietimas dar leidžiamas, bet kvietėjas
 * PRIVALO numesti žemo prioriteto kontekstą. Taip brangus kontekstas mažėja PRIEŠ
 * atsitrenkiant į sieną, o ne po jos.
 */
export const SOFT_BUDGET_RATIO = 0.8;

/**
 * Du to paties žurnalo pjūviai (TOK-4): `full` — VISI įrašai (token sumos, todėl realiai
 * sudeginti tokenai niekada nedingsta); `chargeable` — be infrastruktūros įvykių (LLM
 * kvietimų skaitikliai, kad usage-limit/429 nutraukimas nesudegintų bandymo).
 */
export type BudgetLedgerView = { full: TaskUsageLedger; chargeable: TaskUsageLedger };

export type LedgerGateResult = {
  llmCalls: number;
  totalLlmCalls: number;
  /** RAW suma su `cache_read` — tik diagnostikai (0000-0a). */
  totalTokens: number;
  /** BILLABLE suma — vienintelė kietų ir soft token lubų bazė. */
  billableTokens: number;
  phaseStatus: BudgetPhaseStatus[];
  hardReasons: string[];
  softReasons: string[];
  /** RAW perviršis be billable perviršio; niekada nepatenka į hard/soft priežastis. */
  rawNotices: string[];
  remainingTotalLlmCalls: number | null;
  remainingTotalTokens: number | null;
};

/**
 * Efektyvios BILLABLE lubos iš kanoninio ir legacy raktų poros. Abiem esant laimi
 * GRIEŽTESNIS — prieštaraujantis konfigas niekada netampa laisvesnis.
 */
export function billableCeiling(canonical: number | undefined, legacy: number | undefined): number | undefined {
  return stricter(canonical, legacy);
}

/**
 * RAW perviršio diagnostinė eilutė (0000-0a). Rašoma TIK kai raw peržengė lubas, o billable
 * — ne: būtent tada senasis RAW enforcement'as būtų nužudęs task'ą už gerai veikiantį prompt
 * cache (0007 incidentas). Kai billable jau peržengtas, veikia kietas veto.
 */
function rawTokenNotice(scope: string, raw: number, billable: number, ceiling: number | null | undefined): string | undefined {
  if (typeof ceiling !== "number" || raw <= ceiling || billable > ceiling) return undefined;
  return `${scope} raw tokens ${raw} > ${ceiling} (billable ${billable} within limit) — diagnostika, baigtis nekeičiama`;
}

/**
 * Soft riba: `used` PASIEKĖ `SOFT_BUDGET_RATIO` dalį `limit` (įskaitytinai), bet dar telpa į
 * hard ribą. Įskaitytinai sąmoningai — prie mažų ribų griežta nelygybė reikštų, kad soft
 * signalas neįvyksta niekada iki paskutinio kvietimo.
 */
export function softExceeded(used: number, limit: number | undefined | null): boolean {
  return typeof limit === "number" && used <= limit && used >= limit * SOFT_BUDGET_RATIO;
}

export function evaluateLedgerGate(
  ledger: BudgetLedgerView,
  profile: ToolBudgetProfile,
  projectedPhase: TaskPhase,
  explicitLlmCalls?: number,
): LedgerGateResult {
  // Migracijos kontraktas: `max_llm_calls` toliau reiškia dispatch bandymus. Repair
  // dispatch'ai ledger'yje atskiriami į `repair` fazę, tad čia jie sudedami atgal.
  const dispatchCalls = phaseCalls(ledger.chargeable, "implementation") + phaseCalls(ledger.chargeable, "repair");
  // Biudžetas tikrinamas tiesiai prieš kvietimą, tad projektuojamas kvietimas įskaitomas.
  const llmCalls = explicitLlmCalls ?? dispatchCalls + 1;
  const totalLlmCalls = ledger.chargeable.llm_calls + 1;
  // Tokenai imami iš PILNO ledger'io: infra kvietimas nedega bandymo, bet realiai sudeginti
  // tokenai lieka whole-task sąskaitoje (TOK-4). 0000-0a: kietos lubos lyginamos su BILLABLE
  // suma; RAW lieka apskaičiuota ir matoma, bet TIK kaip `rawNotices` diagnostika.
  const totalTokens = ledger.full.usage.total_tokens;
  const billableTokens = ledger.full.usage.billable_tokens;
  const maxBillableTokens = billableCeiling(profile.max_total_billable_tokens, profile.max_total_tokens);

  const hardReasons: string[] = [];
  const softReasons: string[] = [];
  const rawNotices: string[] = [];

  if (profile.max_llm_calls !== undefined && llmCalls > profile.max_llm_calls) {
    hardReasons.push(`LLM calls ${llmCalls} > ${profile.max_llm_calls}`);
  } else if (softExceeded(llmCalls, profile.max_llm_calls)) {
    softReasons.push(`LLM calls ${llmCalls} near ${profile.max_llm_calls}`);
  }
  if (profile.max_total_llm_calls !== undefined && totalLlmCalls > profile.max_total_llm_calls) {
    hardReasons.push(`task LLM calls ${totalLlmCalls} > ${profile.max_total_llm_calls}`);
  } else if (softExceeded(totalLlmCalls, profile.max_total_llm_calls)) {
    softReasons.push(`task LLM calls ${totalLlmCalls} near ${profile.max_total_llm_calls}`);
  }
  if (maxBillableTokens !== undefined && billableTokens > maxBillableTokens) {
    hardReasons.push(`task tokens ${billableTokens} > ${maxBillableTokens}`);
  } else if (softExceeded(billableTokens, maxBillableTokens)) {
    softReasons.push(`task tokens ${billableTokens} near ${maxBillableTokens}`);
  }
  const taskRawNotice = rawTokenNotice("task", totalTokens, billableTokens, maxBillableTokens);
  if (taskRawNotice) rawNotices.push(taskRawNotice);

  const phaseStatus = buildPhaseStatus(ledger, profile, projectedPhase);
  for (const phase of phaseStatus) {
    if (phase.max_llm_calls !== null && phase.llm_calls > phase.max_llm_calls) {
      hardReasons.push(`phase ${phase.phase} LLM calls ${phase.llm_calls} > ${phase.max_llm_calls}`);
    } else if (softExceeded(phase.llm_calls, phase.max_llm_calls)) {
      softReasons.push(`phase ${phase.phase} LLM calls ${phase.llm_calls} near ${phase.max_llm_calls}`);
    }
    if (phase.max_tokens !== null && phase.billable_tokens > phase.max_tokens) {
      hardReasons.push(`phase ${phase.phase} tokens ${phase.billable_tokens} > ${phase.max_tokens}`);
    } else if (softExceeded(phase.billable_tokens, phase.max_tokens)) {
      softReasons.push(`phase ${phase.phase} tokens ${phase.billable_tokens} near ${phase.max_tokens}`);
    }
    const phaseRawNotice = rawTokenNotice(
      `phase ${phase.phase}`,
      phase.total_tokens,
      phase.billable_tokens,
      phase.max_tokens,
    );
    if (phaseRawNotice) rawNotices.push(phaseRawNotice);
  }

  return {
    llmCalls,
    totalLlmCalls,
    totalTokens,
    billableTokens,
    phaseStatus,
    hardReasons,
    softReasons,
    rawNotices,
    remainingTotalLlmCalls:
      profile.max_total_llm_calls === undefined ? null : Math.max(0, profile.max_total_llm_calls - totalLlmCalls),
    // Likutis irgi BILLABLE: jis maitina mid-dispatch stabdiklį.
    remainingTotalTokens:
      maxBillableTokens === undefined ? null : Math.max(0, maxBillableTokens - billableTokens),
  };
}

function phaseCalls(ledger: TaskUsageLedger, phase: TaskPhase): number {
  return ledger.phases.find((entry) => entry.phase === phase)?.llm_calls ?? 0;
}

/**
 * Aiškiai sukonfigūruotas fazės limitas. Raktai normalizuojami per `canonicalTaskPhase`,
 * todėl senas `phase_limits.dispatch` veikia kaip `implementation`; keliems raktams
 * susiliejus į tą pačią fazę laimi griežtesnis.
 */
function configuredPhaseLimit(profile: ToolBudgetProfile, phase: TaskPhase): TaskPhaseBudget {
  const configured: TaskPhaseBudget = {};
  for (const [key, value] of Object.entries(profile.phase_limits ?? {})) {
    if (canonicalTaskPhase(key) !== phase) continue;
    configured.max_llm_calls = stricter(configured.max_llm_calls, value.max_llm_calls);
    // 0000-0a: kanoninis `max_billable_tokens` ir legacy `max_tokens` yra TAS PATS limitas
    // (billable) — suliejami „laimi griežtesnis" taisykle; rezultatas nešamas `max_tokens`.
    configured.max_tokens = stricter(
      configured.max_tokens,
      billableCeiling(value.max_billable_tokens, value.max_tokens),
    );
  }
  return configured;
}

/**
 * Efektyvus fazės limitas: aiškus konfigas, o jam tylint — numatytasis rezervas
 * (žr. {@link DEFAULT_PHASE_BUDGET_RESERVES} ir ten aprašytus du apribojimus).
 */
function resolvePhaseBudget(profile: ToolBudgetProfile, phase: TaskPhase, projected: boolean): TaskPhaseBudget {
  const configured = configuredPhaseLimit(profile, phase);
  if (!projected) {
    return configured;
  }

  const reserve = DEFAULT_PHASE_BUDGET_RESERVES[phase];
  const derivedCalls =
    profile.max_total_llm_calls === undefined
      ? undefined
      : Math.max(Math.ceil(profile.max_total_llm_calls * reserve.tokenShare), reserve.maxLlmCalls);
  const wholeTaskTokens = billableCeiling(profile.max_total_billable_tokens, profile.max_total_tokens);
  const derivedTokens = wholeTaskTokens === undefined ? undefined : Math.ceil(wholeTaskTokens * reserve.tokenShare);
  const maxLlmCalls = configured.max_llm_calls ?? derivedCalls;
  const maxTokens = configured.max_tokens ?? derivedTokens;
  return {
    ...(maxLlmCalls === undefined ? {} : { max_llm_calls: maxLlmCalls }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  };
}

function stricter(current: number | undefined, candidate: number | undefined): number | undefined {
  if (candidate === undefined) return current;
  return current === undefined ? candidate : Math.min(current, candidate);
}

/**
 * Fazių būsena deterministine `TASK_PHASES` tvarka. Įtraukiamos stebėtos fazės, fazės su
 * limitu ir projektuojamo kvietimo fazė. Kvietimai imami iš `chargeable` (be infra įvykių),
 * tokenai — iš `full`.
 */
function buildPhaseStatus(
  ledger: BudgetLedgerView,
  profile: ToolBudgetProfile,
  projectedPhase: TaskPhase,
): BudgetPhaseStatus[] {
  const statuses: BudgetPhaseStatus[] = [];
  for (const phase of TASK_PHASES) {
    const recorded = ledger.full.phases.find((entry) => entry.phase === phase);
    const chargeable = ledger.chargeable.phases.find((entry) => entry.phase === phase);
    // Įtraukimą lemia AIŠKUS konfigas: išvestas rezervas galioja tik projektuojamai fazei,
    // tad jis negali įtraukti į ataskaitą niekada nevykusių fazių.
    const configured = configuredPhaseLimit(profile, phase);
    const hasLimit = configured.max_llm_calls !== undefined || configured.max_tokens !== undefined;
    if (!recorded && !hasLimit && phase !== projectedPhase) continue;
    const limit = resolvePhaseBudget(profile, phase, phase === projectedPhase);

    const maxLlmCalls = limit.max_llm_calls ?? null;
    const maxTokens = limit.max_tokens ?? null;
    // Projektuojamas kvietimas įskaitomas į savo fazę — taip fazės riba reiškia tą patį,
    // ką ir bendra riba: „prieš kvietimą", ne „po jo".
    const llmCalls = (chargeable?.llm_calls ?? 0) + (phase === projectedPhase ? 1 : 0);
    const totalTokens = recorded?.usage.total_tokens ?? 0;
    // 0000-0a: fazės lubos, kaip ir whole-task lubos, lyginamos su BILLABLE suma.
    const billableTokens = recorded?.usage.billable_tokens ?? 0;
    const ok = (maxLlmCalls === null || llmCalls <= maxLlmCalls) && (maxTokens === null || billableTokens <= maxTokens);
    statuses.push({
      phase,
      records: recorded?.records ?? 0,
      llm_calls: llmCalls,
      zero_usage_events: recorded?.zero_usage_events ?? 0,
      total_tokens: totalTokens,
      billable_tokens: billableTokens,
      max_llm_calls: maxLlmCalls,
      max_tokens: maxTokens,
      ok,
      soft_ok: ok && !softExceeded(llmCalls, maxLlmCalls) && !softExceeded(billableTokens, maxTokens),
    });
  }
  return statuses;
}
