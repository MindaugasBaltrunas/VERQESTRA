// CHEAP FINISH (task 0000-0-repair-cheap-finish): VIENAS papildomas, griežtai apribotas
// dispatch'as mechaninės klaidos užbaigimui, kai įprastą repair ratą sustabdė biudžeto
// lubos arba retry limitas. Behaviour etalon: AG_loop policy/token-budget-optimizer.ts
// (cheap-finish pusė; WBR VQ-302 skaidymas). Visos funkcijos GRYNOS: sprendimas priimamas
// iš jau surinktų įrodymų, o efektus taiko run-coordinator per CheapFinishPort.

import { type TokenBudgetTier } from "./tiers.js";
import { resolveMaxTurns, type TurnLimits } from "./turn-budget.js";

/**
 * Turn lango tier'as cheap finish dispatch'ui. Reikšmė NĖRA nauja konstanta:
 * `DEFAULT_TURN_LIMITS.small` (20) jau yra siauriausias dokumentuotas langas.
 */
export const CHEAP_FINISH_TURN_TIER: TokenBudgetTier = "small";

/**
 * Cheap finish sesijos BILLABLE tokenų stabdiklis. 300k yra tarp
 * {@link MIN_CHEAP_FINISH_BILLABLE_TOKENS} (self-DoS grindys) ir bendro dispatch default'o:
 * vienos mechaninės klaidos taisymas su jau surinktu kontekstu yra dydžio eile pigesnis už
 * pilną sesiją (2026-08-12 sunkiausios sesijos billable buvo 444k–654k — 300k lubos tokio
 * darbo ATKARTOTI neleidžia). ŽINOMAS APRIBOJIMAS (E1): mid-stream watchdog'as šios
 * reikšmės kol kas neskaito — įvielinimas gyvena atskirame follow-up task'e.
 */
export const DEFAULT_CHEAP_FINISH_BILLABLE_TOKENS = 300_000;

/**
 * Kietos GRINDYS cheap finish billable stabdikliui — žemiau 100k neriboja nė vienas
 * dispatch raktas. Dublikatas, o ne importas iš konfigo modulio: importo kryptis viena
 * (config -> optimizer), o šis modulis privalo likti be IO.
 */
export const MIN_CHEAP_FINISH_BILLABLE_TOKENS = 100_000;

/** Kokia mechaninė klaida liko — VIENINTELĖS dvi klasės, kurioms cheap finish leidžiamas. */
export type CheapFinishClass = "typecheck" | "test";

/** Kas sustabdė įprastą repair ratą. */
export type CheapFinishBlocker = "task-budget" | "phase-budget" | "retry-limit";

export type CheapFinishDecision =
  | { eligible: false; reasons: string[] }
  | {
      eligible: true;
      class: CheapFinishClass;
      blockedBy: CheapFinishBlocker;
      billableLimit: number;
      maxTurns: number;
      tokenBudgetTier: TokenBudgetTier;
      /**
       * Ar cheap finish dispatch'ui reikia naujos biudžeto epochos. Visada `true` — epochą
       * tikrina DU nepriklausomi vartai, ir tik vienas jų žino apie orkestratoriaus išimtį;
       * ledger reset yra VIENINTELIS mechanizmas, atidarantis šviežią epochą abiem pusėms.
       */
      requiresLedgerReset: boolean;
      reasons: string[];
    };

/**
 * Deterministinės diagnozės eilutė, iš kurios imamas klaidos signalas. Modelio diagnozė
 * čia NEPATAIKO SĄMONINGAI: cheap finish remiasi TIK deterministiniu, mašinos suformuotu
 * signalu, kurį galima perskaityti be interpretacijos.
 */
const LOCAL_DIAGNOSIS_SIGNAL = /^local-diagnosis:\s*clear local issue:\s*(.+)$/;

/** `tsc` klaida signalo eilutėje. */
const CHEAP_FINISH_TYPECHECK_SIGNAL = /\berror TS\d+\b/gi;

/**
 * Node `assert` / testų runner'io kritimas signalo eilutėje. `AssertionError
 * [ERR_ASSERTION]` yra VIENAS kritimas dviem vardais, tad pora suvalgoma vienu match'u;
 * du atskiri žymenys lieka dvi klaidos ir cheap finish nebeleidžiamas.
 */
const CHEAP_FINISH_TEST_SIGNAL = /\bAssertionError\b(?:\s*\[ERR_ASSERTION\])?|\bERR_ASSERTION\b|\btest failed\b/gi;

function countMatches(text: string, pattern: RegExp): number {
  // `matchAll` reikalauja `g` vėliavos; regexp'ai aukščiau ją turi, o `matchAll` bendro
  // objekto `lastIndex` nemutuoja (kiekvienas kvietimas dirba su savo iteratoriumi).
  return [...text.matchAll(pattern)].length;
}

/**
 * Klaidos klasė iš diagnozės priežasties, arba `undefined` (fail-closed). Du vartai:
 * deterministinė `local-diagnosis: clear local issue: …` eilutė IR joje LYGIAI VIENAS
 * klaidos žymuo.
 */
export function classifyCheapFinishDiagnosis(decisionReason: string): CheapFinishClass | undefined {
  const signal = LOCAL_DIAGNOSIS_SIGNAL.exec(decisionReason.trim())?.[1]?.trim();
  if (!signal) return undefined;

  const typecheckHits = countMatches(signal, CHEAP_FINISH_TYPECHECK_SIGNAL);
  const testHits = countMatches(signal, CHEAP_FINISH_TEST_SIGNAL);
  if (typecheckHits + testHits !== 1) return undefined;
  return typecheckHits === 1 ? "typecheck" : "test";
}

/** `task LLM calls …` / `task tokens …` — whole-task lubos. */
const TASK_BUDGET_VETO = /\b(?:task tokens |task LLM calls )/;

/** `phase repair …` — repair fazės rezervas. */
const PHASE_BUDGET_VETO = /\bphase repair /;

/**
 * Atskiros veto priežastys iš `budget_enforcement_failed=…` eilutės, arba `undefined`, jei
 * žymos nėra. Skaidoma tuo pačiu `"; "` skirtuku, kuriuo jas sujungia dispatch kelias.
 */
function budgetVetoReasons(veto: string): string[] | undefined {
  const marker = "budget_enforcement_failed=";
  const at = veto.indexOf(marker);
  if (at < 0) return undefined;
  return veto
    .slice(at + marker.length)
    .split(";")
    .map((reason) => reason.trim())
    .filter((reason) => reason.length > 0);
}

/**
 * Kuris blokatorius sustabdė repair ratą. Vertinamos VISOS veto priežastys: užtenka vienos
 * neatleidžiamos (`context chars …`, `model not allowed: …`), ir blokatorius NEATPAŽĮSTAMAS,
 * kad vienintelė task'o cheap finish žymė nebūtų sudeginta garantuotai blokuojamam
 * kvietimui. Pateiktas, bet neatpažintas veto NUGALI retry prognozę (fail-closed).
 */
export function classifyCheapFinishBlocker(input: {
  budgetVetoReason?: string;
  retryLimitPredicted: boolean;
}): CheapFinishBlocker | undefined {
  const veto = input.budgetVetoReason?.trim();
  if (veto) {
    const reasons = budgetVetoReasons(veto);
    if (!reasons || reasons.length === 0) return undefined;
    if (!reasons.every((reason) => isCheapFinishWaivedBudgetReason(reason))) return undefined;
    if (reasons.some((reason) => TASK_BUDGET_VETO.test(reason))) return "task-budget";
    if (reasons.some((reason) => PHASE_BUDGET_VETO.test(reason))) return "phase-budget";
    return undefined;
  }
  return input.retryLimitPredicted ? "retry-limit" : undefined;
}

/**
 * Cheap finish billable lubos: `override` (operatorius) → default 300k, apkarpyta bendru
 * dispatch billable stabdikliu ir prispausta prie kietų grindų. Kryptis viena: cheap finish
 * gali būti tik GRIEŽTESNIS už bendrą dispatch ribą — todėl `min(...)`, ne `max(...)`.
 */
export function resolveCheapFinishBillableLimit(input: {
  override?: number;
  maxDispatchBillableTokens?: number;
}): number {
  const override = input.override;
  const base =
    override !== undefined && Number.isFinite(override) && override > 0
      ? Math.floor(override)
      : DEFAULT_CHEAP_FINISH_BILLABLE_TOKENS;
  const ceiling = input.maxDispatchBillableTokens;
  const capped =
    ceiling !== undefined && Number.isFinite(ceiling) && ceiling > 0 ? Math.min(base, Math.floor(ceiling)) : base;
  return Math.max(MIN_CHEAP_FINISH_BILLABLE_TOKENS, capped);
}

/**
 * Cheap finish turn langas — tas pats `resolveMaxTurns`, prikaltas prie
 * {@link CHEAP_FINISH_TURN_TIER} ir `implementation` fazės. Operatoriaus `limits`/`ceiling`
 * reikšmę gali tik MAŽINTI; `0` (aiškus opt-out iš `--max-turns`) išsaugomas nepakitęs.
 */
export function resolveCheapFinishTurns(input: { limits?: TurnLimits; ceiling?: number }): number {
  return resolveMaxTurns({
    phase: "implementation",
    tier: CHEAP_FINISH_TURN_TIER,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    ...(input.ceiling === undefined ? {} : { ceiling: input.ceiling }),
  });
}

/**
 * Ar ŠI biudžeto priežastis yra ta, kurią cheap finish vienkartinai atleidžia. Atleidžiamos
 * TIK kiekybinės whole-task ir fazės lubos; kokybiniai draudimai LIEKA blokuojantys — jie
 * sako „šis kvietimas neteisėtas", o ne „kvota išsemta".
 */
export function isCheapFinishWaivedBudgetReason(reason: string): boolean {
  const text = reason.trim();
  return (
    /^LLM calls \d+ > \d+$/.test(text) ||
    /^task (?:LLM calls|tokens) \d+ > \d+$/.test(text) ||
    /^phase \S+ (?:LLM calls|tokens) \d+ > \d+$/.test(text)
  );
}

/**
 * VIENINTELIS cheap finish sprendimas. Fail-closed: kiekvienas nepatenkintas vartas grąžina
 * `eligible: false` su įvardyta priežastimi, tad „nežinau" niekada nevirsta papildomu
 * dispatch'u. Įrodymų vartas yra pati šio kelio prasmė: cheap finish egzistuoja tam, kad
 * IŠSAUGOTŲ dalinį darbą — be nė vieno produkto darbo pėdsako taisyti nėra ko.
 */
export function decideCheapFinish(input: {
  verdict?: string;
  diagnosisReason?: string;
  hasUncommittedProductWork: boolean;
  hasCommittedProductWork: boolean;
  budgetVetoReason?: string;
  retryLimitPredicted: boolean;
  alreadyArmed: boolean;
  billableOverride?: number;
  maxDispatchBillableTokens?: number;
  turnLimits?: TurnLimits;
  turnCeiling?: number;
}): CheapFinishDecision {
  const reasons: string[] = [];

  if (input.alreadyArmed) {
    return { eligible: false, reasons: ["cheap finish already armed for this task"] };
  }
  if (input.verdict !== "repair") {
    return { eligible: false, reasons: [`verdict is not repair: ${input.verdict ?? "<missing>"}`] };
  }

  const diagnosisClass = classifyCheapFinishDiagnosis(input.diagnosisReason ?? "");
  if (!diagnosisClass) {
    return { eligible: false, reasons: ["diagnosis is not a single deterministic local issue"] };
  }
  reasons.push(`single local ${diagnosisClass} error`);

  if (!input.hasUncommittedProductWork && !input.hasCommittedProductWork) {
    return { eligible: false, reasons: [...reasons, "no product work to finish"] };
  }
  reasons.push(input.hasUncommittedProductWork ? "uncommitted product work" : "committed product work");

  const blockedBy = classifyCheapFinishBlocker({
    ...(input.budgetVetoReason === undefined ? {} : { budgetVetoReason: input.budgetVetoReason }),
    retryLimitPredicted: input.retryLimitPredicted,
  });
  if (!blockedBy) {
    return { eligible: false, reasons: [...reasons, "no cheap-finish blocker (budget veto or retry limit)"] };
  }
  reasons.push(`blocked by ${blockedBy}`);

  return {
    eligible: true,
    class: diagnosisClass,
    blockedBy,
    billableLimit: resolveCheapFinishBillableLimit({
      ...(input.billableOverride === undefined ? {} : { override: input.billableOverride }),
      ...(input.maxDispatchBillableTokens === undefined
        ? {}
        : { maxDispatchBillableTokens: input.maxDispatchBillableTokens }),
    }),
    maxTurns: resolveCheapFinishTurns({
      ...(input.turnLimits === undefined ? {} : { limits: input.turnLimits }),
      ...(input.turnCeiling === undefined ? {} : { ceiling: input.turnCeiling }),
    }),
    tokenBudgetTier: CHEAP_FINISH_TURN_TIER,
    requiresLedgerReset: true,
    reasons,
  };
}
