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
//
// Semantika yra RUN pjūvis, ne viso gyvavimo suma (task 133): `maxRunBillableTokens` vardas žadėjo
// per-run ribą nuo pat pradžių, bet iki šiol išlaidos buvo sumuojamos per VISĄ `token-usage.jsonl`
// — kiekvienas naujas run paveldėdavo visų ankstesnių išlaidas, ir riba, kartą pasiekusi `exhausted`,
// negrįždavo be rankinio žurnalo valymo. Žurnalo `run_id` laukas (jau egzistuoja, `token-usage-log.ts`)
// leidžia pjūvį be schemos keitimo: sumuojami tik įrašai, kurių `run_id` sutampa su einamuoju.

import { parseTaskUsageEntries, taskUsageTokenTotal, type TaskUsageEntry } from "../../domain/tokens/usage-ledger.js";
import type { ReadySetBudget } from "./build-ready-set.js";

/** Neprivalomas raktas `vq/config/token-budget.json` faile. */
export const RUN_BUDGET_CONFIG_KEY = "maxRunBillableTokens";

export type RunBudgetPorts = {
  /** `vq/config/token-budget.json` turinys arba `undefined`, kai jo nėra. */
  readBudgetConfig: () => Promise<string | undefined>;
  /** `vq/logs/token-usage.jsonl` turinys arba `undefined`, kai jo nėra. */
  readUsageLog: () => Promise<string | undefined>;
  /**
   * Einamojo run'o tapatybė (loop-command `runId`, `randomUUID()` vieną kartą per paleidimą).
   * Filtruoja žurnalą į ŠIO run'o pjūvį — be jos suma būtų viso gyvavimo žurnalo suma.
   */
  runId: string;
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
 * Įrašo `run_id`, arba `undefined`, kai žurnalo eilutė jo neneša (senas formatas, fastpath).
 *
 * `TaskUsageEntry` (domain/tokens/usage-ledger) `run_id` lauko nedeklaruoja — jis rašomas
 * (`infrastructure/state/token-usage-log.ts`), bet ledger'io grynoji pusė jo nenaudoja. Skaitymas
 * per `Record<string, unknown>` čia neišplečia domeno tipo, tik pasiekia lauką, kurį JSON eilutė
 * jau neša.
 */
function runIdOfEntry(entry: TaskUsageEntry): string | undefined {
  const raw = (entry as unknown as Record<string, unknown>)["run_id"];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

/**
 * Kiek ŠIS run'as jau išleido, pagal loop'o paties usage žurnalą.
 *
 * Sumuojama per įrašus, kurių `run_id` sutampa su einamuoju run'u — ankstesnių run'ų išlaidos
 * neriboja naujo. `run_id` žurnale jau egzistuoja (`token-usage-log.ts`, sourced iš attempt
 * manifest'o, kurį prirašo wave scheduler'io `runId`), tad pjūvis skaito esamą lauką, o ne prideda
 * naują. `taskUsageTokenTotal` neša tą pačią apmokestinamą aritmetiką, kurią naudoja likusi
 * apskaita, tad riba ir išlaidos matuojamos ta pačia kiekybe.
 */
function spentBillableTokens(raw: string | undefined, runId: string): number {
  if (raw === undefined) return 0;
  return parseTaskUsageEntries(raw)
    .filter((entry) => runIdOfEntry(entry) === runId)
    .reduce((total, entry) => total + taskUsageTokenTotal(entry), 0);
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
  const remaining = ceiling - spentBillableTokens(await ports.readUsageLog(), ports.runId);
  return { remaining_tokens: Math.max(remaining, 0), exhausted: remaining <= 0 };
}
