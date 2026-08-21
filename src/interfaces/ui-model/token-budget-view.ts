// Token biudžeto būsenos projekcija dashboard'ui (etalonas: AG_loop
// interfaces/ui-model/control-plane-model.ts token budget blokas).
//
// Iki šio vaizdo UI apie `vq/state/token-budget-status.json` matė TIK mtime/size eilutę, tad
// operatorius negalėjo pasakyti nei kokios lubos galioja, nei kiek jų sudeginta — nors būtent
// tai paaiškina, kodėl kitas dispatch'as buvo pristabdytas (`reduce_context`) ar neleistas.
//
// Failą rašo biudžeto vartai DVIEM NEPRIKLAUSOMAIS raktais, kiekvieną savo momentu, todėl blokai
// čia NESULIEJAMI: bendras skaičius, sudėtas iš dviejų skirtingų laiko taškų, meluotų apie abu.
// Visi laukai optional — dalinį ar senesnio formato turinį skaitymo kelias privalo praleisti, o
// ne versti dashboard'ą.

/** Whole-task lubos iš galiojančio profilio; `null` reiškia „neribota". */
export type UiTokenBudgetLimits = {
  max_llm_calls: number | null;
  max_total_llm_calls: number | null;
  max_total_tokens: number | null;
};

/** `budget_enforcement` — konteksto/įrankių vartų verdiktas. */
export type UiTokenBudgetEnforcement = {
  ok?: boolean | undefined;
  task_id?: string | undefined;
  model?: string | undefined;
  profile?: string | undefined;
  /** Implementacijos fazės kvietimai plius projektuojamas (migracijos kontraktas). */
  llm_calls?: number | undefined;
  total_llm_calls?: number | undefined;
  /** RAW suma su `cache_read` — diagnostika. */
  total_tokens?: number | undefined;
  /** BILLABLE suma (`input + output + cache_creation`) — kietų lubų bazė. */
  billable_tokens?: number | undefined;
  limits?: UiTokenBudgetLimits | undefined;
  reduce_context?: boolean | undefined;
  reasons?: string[] | undefined;
  soft_reasons?: string[] | undefined;
};

/** `llm_call_authorization` — paskutinio prieš-kvietimo vartų verdiktas. */
export type UiTokenBudgetAuthorization = {
  allowed?: boolean | undefined;
  task_id?: string | undefined;
  phase?: string | undefined;
  total_llm_calls?: number | undefined;
  total_tokens?: number | undefined;
  billable_tokens?: number | undefined;
  /** Likutis iki whole-task lubų; `null` — neribota. */
  remaining_total_llm_calls?: number | null | undefined;
  remaining_total_tokens?: number | null | undefined;
  reduce_context?: boolean | undefined;
  hard_reasons?: string[] | undefined;
  soft_reasons?: string[] | undefined;
};

export type UiTokenBudget = {
  budget_enforcement?: UiTokenBudgetEnforcement | undefined;
  llm_call_authorization?: UiTokenBudgetAuthorization | undefined;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalTextList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : undefined;
}

/** Nesama arba ne skaitinė riba yra „neribota" — lygiai kaip ją rašo biudžeto vartai. */
function limitValue(value: unknown): number | null {
  return optionalNumber(value) ?? null;
}

function toLimits(value: unknown): UiTokenBudgetLimits | undefined {
  const limits = asRecord(value);
  if (!limits) return undefined;
  return {
    max_llm_calls: limitValue(limits["max_llm_calls"]),
    max_total_llm_calls: limitValue(limits["max_total_llm_calls"]),
    max_total_tokens: limitValue(limits["max_total_tokens"]),
  };
}

function toEnforcement(value: unknown): UiTokenBudgetEnforcement | undefined {
  const status = asRecord(value);
  if (!status) return undefined;
  return {
    ok: optionalBoolean(status["ok"]),
    task_id: optionalText(status["task_id"]),
    model: optionalText(status["model"]),
    profile: optionalText(status["profile"]),
    llm_calls: optionalNumber(status["llm_calls"]),
    total_llm_calls: optionalNumber(status["total_llm_calls"]),
    total_tokens: optionalNumber(status["total_tokens"]),
    billable_tokens: optionalNumber(status["billable_tokens"]),
    limits: toLimits(status["limits"]),
    reduce_context: optionalBoolean(status["reduce_context"]),
    reasons: optionalTextList(status["reasons"]),
    soft_reasons: optionalTextList(status["soft_reasons"]),
  };
}

function toAuthorization(value: unknown): UiTokenBudgetAuthorization | undefined {
  const authorization = asRecord(value);
  if (!authorization) return undefined;
  return {
    allowed: optionalBoolean(authorization["allowed"]),
    task_id: optionalText(authorization["task_id"]),
    phase: optionalText(authorization["phase"]),
    total_llm_calls: optionalNumber(authorization["total_llm_calls"]),
    total_tokens: optionalNumber(authorization["total_tokens"]),
    billable_tokens: optionalNumber(authorization["billable_tokens"]),
    remaining_total_llm_calls: limitValue(authorization["remaining_total_llm_calls"]),
    remaining_total_tokens: limitValue(authorization["remaining_total_tokens"]),
    reduce_context: optionalBoolean(authorization["reduce_context"]),
    hard_reasons: optionalTextList(authorization["hard_reasons"]),
    soft_reasons: optionalTextList(authorization["soft_reasons"]),
  };
}

/**
 * `token-budget-status.json` turinys → UI kontraktas.
 *
 * Skaitymo pusė laikoma NEPATIKIMA sąmoningai: failą rašo kitas procesas, jis gali būti tuščias,
 * dalinis ar senesnio formato, o telemetrijos defektas neturi versti dashboard'o. Kai
 * neatpažįstamas nė vienas blokas — `undefined`, kad UI matytų „duomenų nėra", o ne tuščią
 * biudžetą su melagingais nuliais.
 */
export function toUiTokenBudget(value: unknown): UiTokenBudget | undefined {
  const content = asRecord(value);
  if (!content) return undefined;
  const enforcement = toEnforcement(content["budget_enforcement"]);
  const authorization = toAuthorization(content["llm_call_authorization"]);
  if (!enforcement && !authorization) return undefined;
  return {
    ...(enforcement === undefined ? {} : { budget_enforcement: enforcement }),
    ...(authorization === undefined ? {} : { llm_call_authorization: authorization }),
  };
}
