// Run lygio tokenų biudžetas ready-set'ui.
//
// `BuildReadySetInput.budget` egzistavo nuo pradžių, o `loop-command` jam padavė hardcoded
// `() => undefined`, tad `budget-exhausted` ir `budget-insufficient` — du iš šešių blokavimo
// motyvų — produkcijoje buvo nepasiekiami.
//
// Prijungti nebuvo prie ko: visos esamos ribos yra PER-TASK. `tool-budget.json`
// `max_total_billable_tokens` yra vieno task'o lubos, o `token-budget-status.json`
// `remaining_total_tokens` — paskutinio autorizuoto kvietimo task'o likutis. Paėmus bet kurį iš
// jų kaip planavimo biudžetą, vieno task'o likutis taptų visos eilės riba.
//
// Todėl riba yra atskira ir NEPRIVALOMA. Jos nesant grąžinama `undefined` — tiksliai ta elgsena,
// kuri buvo iki šiol — tad niekam nieko neįjungiama be sprendimo. Ją įrašius, mechanizmas veikia.

import { parseTaskUsageEntries, taskUsageTokenTotal } from "../../domain/tokens/usage-ledger.js";
import type { ReadySetBudget } from "./build-ready-set.js";

/** Neprivalomas raktas `vq/config/token-budget.json` faile. */
export const RUN_BUDGET_CONFIG_KEY = "maxRunBillableTokens";

export type RunBudgetPorts = {
  /** `vq/config/token-budget.json` turinys arba `undefined`, kai jo nėra. */
  readBudgetConfig: () => Promise<string | undefined>;
  /** `vq/logs/token-usage.jsonl` turinys arba `undefined`, kai jo nėra. */
  readUsageLog: () => Promise<string | undefined>;
};

function declaredCeiling(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Sugadintas konfigas neįjungia ribos, kurios operatorius nedeklaravo. Fail-open čia yra
    // teisinga kryptis: tikroji išlaidų prievarta stovi dispatch'e, o šis vartas yra planavimo
    // užuomina. Užrakinti visą eilę dėl neperskaitomo failo reikštų sustabdyti darbą dėl dalyko,
    // kurio niekas net nepamatavo.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = (parsed as Record<string, unknown>)[RUN_BUDGET_CONFIG_KEY];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Kiek run'as jau išleido, pagal loop'o paties usage žurnalą.
 *
 * Sumuojama per VISUS įrašus, ne per vieną task'ą: klausimas čia yra „kiek liko eilei", o ne
 * „kiek liko šitam darbui". `taskUsageTokenTotal` neša tą pačią apmokestinamą aritmetiką, kurią
 * naudoja likusi apskaita, tad riba ir išlaidos matuojamos ta pačia kiekybe.
 */
function spentBillableTokens(raw: string | undefined): number {
  if (raw === undefined) return 0;
  return parseTaskUsageEntries(raw).reduce((total, entry) => total + taskUsageTokenTotal(entry), 0);
}

/**
 * Ready-set biudžetas, arba `undefined`, kai run lygio riba nedeklaruota.
 *
 * `undefined` NĖRA „biudžetas išnaudotas" — tai „ribos nėra", ir `buildReadySet` tą skiria:
 * neapibrėžtas biudžetas neblokuoja nieko.
 */
export async function readRunBudget(ports: RunBudgetPorts): Promise<ReadySetBudget | undefined> {
  const ceiling = declaredCeiling(await ports.readBudgetConfig());
  if (ceiling === undefined) return undefined;
  const remaining = ceiling - spentBillableTokens(await ports.readUsageLog());
  return { remaining_tokens: Math.max(remaining, 0), exhausted: remaining <= 0 };
}
