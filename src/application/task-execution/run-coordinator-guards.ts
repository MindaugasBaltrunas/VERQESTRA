/** Pure retry, infrastructure-disposition and cheap-finish prompt rules. */
import type { PreflightFailureClass, PreflightFailureMemoRecord } from "../quality-gates/preflight-memo-schema.js";

/**
 * Parenka, ar infrastruktūros gedimo metu repair būsena išsaugoma, ar task grąžinamas į eilę.
 */
export function infrastructureFailureDisposition(
  currentBucket: string,
  hasTaskScopedRepairPrompt: boolean,
): "preserve" | "requeue" {
  return currentBucket === "error" && hasTaskScopedRepairPrompt ? "preserve" : "requeue";
}

/** Coarse klasė, kurią rašo `start()` preflight kelias (etalono task 1204). */
export const PREFLIGHT_START_FAILURE_CLASS: PreflightFailureClass = "preflight-exit";

/**
 * Ar šis bandymas yra tas pats kritimas ant to paties turinio.
 *
 * `exit_code` į raktą SĄMONINGAI neįeina: guard'as sprendžia PRIEŠ preflight'ą, tad „dabartinio"
 * exit kodo dar nėra, o kad jis atsirastų, reikėtų paleisti būtent tą kvietimą, kurį guard'as ir
 * taupo. Exit kodas lieka įrodymu įraše, log eilutėje ir žurnale. `failure_class` raktu YRA: jis
 * apsaugo nuo to, kad kitos (būsimos) klasės įrašas užblokuotų šį kelią.
 */
export function preflightRetryWithoutChange(
  record: PreflightFailureMemoRecord | undefined,
  expected: { taskId: string; contentHash: string; failureClass: PreflightFailureClass },
): boolean {
  if (!record || !expected.contentHash) return false;
  return (
    record.task_id === expected.taskId &&
    record.content_hash === expected.contentHash &&
    record.failure_class === expected.failureClass
  );
}

/**
 * `# Repair Task` antraštė BET KURIOJE eilutėje.
 *
 * Dispatch CLI `isRepairDispatchPrompt` ieško būtent šio šablono su `m` vėliava, ir nuo jo
 * priklauso dispatch fazė: `repair` fazė duotų siaurą repair turn langą ir atjungtų
 * context-pack kelią, o cheap finish yra IMPLEMENTATION dispatch'as su regeneruotu kontekstu.
 * Repair prompt'as, kurį cheap finish įdeda kaip kontekstą, tokią antraštę turi beveik
 * visada, tad ji NUŽEMINAMA (o ne ištrinama — tekstas lieka skaitomas).
 *
 * Šablonas MIRROR'ina autoritetą baitas į baitą (`\s`, ne `[ \t]`): siauresnis variantas
 * nepagautų CRLF eilutės `# Repair Task\r\n` — `\s*$` `\r` suvalgo, `[ \t]*$` ne. Windows
 * aplinkoje (`core.autocrlf`) būtent tokia eilutė ir ateina iš disko, tad nesutapimas reikštų
 * NENUŽEMINTĄ antraštę, pro vartus praėjusį prompt'ą ir cheap finish dispatch'ą, kurį
 * dispatch CLI klasifikuotų kaip `repair` fazę — t. y. tiksliai tai, ko šis vartas saugo.
 */
const REPAIR_TASK_HEADING = /^#\s+Repair Task\s*$/gm;

/** Ar šis promptas dispatch'ui atrodys kaip repair (t. y. cheap finish sugadintas). */
export function looksLikeRepairDispatchPrompt(prompt: string): boolean {
  return /^#\s+Repair Task\s*$/m.test(prompt);
}

function demoteRepairHeadings(text: string): string {
  return text.replace(REPAIR_TASK_HEADING, "### Repair Task (kontekstas)");
}

/**
 * Cheap finish prompt'as: ORIGINALI užduotis + siauras taisymo nurodymas + repair kontekstas.
 *
 * Gryna funkcija (jokio IO), tad trigerio matricą galima varyti be port'ų. Du kontrakto
 * elementai, kurių keisti negalima:
 *   - originalus task'o kūnas PERKELIAMAS nepakeistas, kad `## Failai` ribos ir `## Agentai`
 *     rolė liktų tos pačios (`assertLoopAdapterAllowed` ir context-pack skaito būtent jas);
 *   - prompt'e neturi likti `# Repair Task` antraštės (žr. {@link REPAIR_TASK_HEADING}).
 */
export function composeCheapFinishPrompt(input: {
  taskBody: string;
  signal: string;
  repairContext?: string;
}): string {
  const repairContext = input.repairContext?.trim();
  return [
    demoteRepairHeadings(input.taskBody.trimEnd()),
    "",
    "## Cheap finish",
    "Ankstesnis bandymas paliko dalinį darbą. Pataisyk TIK šią klaidą, nieko neperrašinėk:",
    input.signal.trim(),
    ...(repairContext ? ["Repair kontekstas:", demoteRepairHeadings(repairContext)] : []),
    "",
  ].join("\n");
}
