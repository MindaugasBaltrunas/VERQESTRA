// Task-scoped repair prompt'o kelio taisyklė ir scope perkėlimas (etalono
// orchestrator/tasks/task-repair.ts grynoji pusė, VQ-304 3/3). Failų skaitymo/rašymo
// apvalkalai (write/read/remove) yra `RepairPromptPort` adapterio (E4) darbas — čia jų nėra.
import path from "node:path";
import { extractSection, findSectionBounds, splitLines } from "../../shared/markdown.js";
import { allowedPaths } from "../../domain/tasks/allowed-paths.js";
import { parseBacktickChecks } from "../quality-gates/preflight-rules.js";

/**
 * `vq/state/repair/<task_id>.md` — kanoninis repair prompt'o kelias. `runtimeRoot` yra
 * VERQESTRA runtime šaknis (`path.join(root, "vq")`; etalone tą pačią rolę atliko `AG/`).
 * Id validacija yra saugiklis nuo path traversal — prompt'o failas visada lieka repair kataloge.
 */
export function taskRepairPath(runtimeRoot: string, taskId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(taskId) || taskId === "." || taskId === "..") {
    throw new Error(`Invalid repair task id: ${taskId}`);
  }
  return path.join(runtimeRoot, "state", "repair", `${taskId}.md`);
}

/**
 * Pakeičia `heading` sekcijos body (iki kitos antraštės) nauju tekstu; jei sekcijos
 * nėra — prideda ją gale. Naudojama vietoj paprasto append, kad dubliuota antraštė
 * nepaslėptų naujo turinio nuo `extractSection` (jis skaito tik PIRMĄ atitikmenį).
 */
function replaceOrAppendSection(taskText: string, heading: string, body: string): string {
  const lines = splitLines(taskText);
  // Riba — ta pati, kurią mato `extractSection` (2026-08-24, RAG auditas 5): vietinis ciklas buvo
  // fence-aklas, tad sekcija būdavo perrašoma ne ties ta riba, pagal kurią ją vėliau skaito
  // kvietėjai.
  const bounds = findSectionBounds(lines, (line) => line.trim() === heading);
  if (bounds === undefined) {
    return `${taskText.trimEnd()}\n\n${heading}\n${body}`;
  }
  return [...lines.slice(0, bounds.start + 1), body, ...lines.slice(bounds.end)].join("\n");
}

/**
 * Perkelia originalios užduoties scope sekcijas į repair prompt'ą, jei repair prompt'e
 * jų nėra arba jos neparse'inamos (etalono task 1045 regresija):
 *
 * - `## Failai` — be jos post-repair diagnozė (`evaluateLocalDiagnosis`) baigtą darbą
 *   parkina kaip "allowed paths missing" ir task-scoped rollback ištrina jau
 *   užcommitintus naujus failus iš disko; context-pack krenta į advisory skip, tad
 *   repair dispatch'as lieka be budget enforcement.
 * - `## Patikra` — repair šablono "Paleisk užduotyje nurodytas patikras." neturi
 *   backtick komandų, kurių reikalauja context-pack (`parseBacktickChecks`).
 *
 * Pure string logika; jau parseable sekcijos paliekamos nepaliestos, todėl antras
 * repair ratas (originalas = ankstesnis repair prompt'as) yra no-op.
 */
export function carryTaskScopeIntoRepairPrompt(repairPrompt: string, originalTaskText: string): string {
  if (!repairPrompt.trim()) return repairPrompt;
  const original = originalTaskText ?? "";
  let result = repairPrompt.trimEnd();

  if (allowedPaths(result).length === 0 && allowedPaths(original).length > 0) {
    result = replaceOrAppendSection(result, "## Failai", extractSection(original, "## Failai"));
  }

  if (parseBacktickChecks(result).length === 0 && parseBacktickChecks(original).length > 0) {
    result = replaceOrAppendSection(result, "## Patikra", extractSection(original, "## Patikra"));
  }

  // ## Spec source: repair prompt'as tampa task failu, tad parkintas ir vėliau
  // requeue'intas repair'as be šios sekcijos krenta preflight'e ("missing required
  // sections: ## Spec source") — originalo nuoroda perkeliama, kad requeue veiktų.
  if (!extractSection(result, "## Spec source") && extractSection(original, "## Spec source")) {
    result = replaceOrAppendSection(result, "## Spec source", extractSection(original, "## Spec source"));
  }

  return `${result.trimEnd()}\n`;
}
