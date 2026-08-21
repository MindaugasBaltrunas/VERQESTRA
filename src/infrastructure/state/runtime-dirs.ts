// Runtime katalogų paruošimas (etalonas: orchestrator/runtime/context.ts `ensureDirs`).
//
// Etalone tai buvo GLOBALI funkcija, kviečiama proceso starte, ir dėl to jos priklausomybė buvo
// nematoma: bet kuris kelias galėjo tyliai remtis tuo, kad katalogai jau yra. VERQESTRA ją laiko
// paprastu adapteriu, kurį komandos gauna per portą — taip matosi, KAS jos reikalauja.
//
// Skirtumas nuo etalono yra tik šaknų: task'ų bucket'ai lieka `AG/tasks/*` (eilės kontraktas),
// o būsena, žurnalai ir konfigas keliauja į `vq/*` (šio produkto runtime).

import path from "node:path";
import { taskBuckets } from "../../domain/tasks/buckets.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/** Katalogai, kurių egzistavimu remiasi eilės ir būsenos keliai. */
export function runtimeDirectories(agRoot: string, runtimeRoot: string): string[] {
  return [
    ...taskBuckets.map((bucket) => path.join(agRoot, "tasks", bucket)),
    path.join(agRoot, "tasks", "examples"),
    path.join(runtimeRoot, "supervisor"),
    path.join(runtimeRoot, "state"),
    path.join(runtimeRoot, "logs"),
    path.join(runtimeRoot, "config"),
  ];
}

/**
 * Sukuria katalogus ir pasėja `retry-counts.json`.
 *
 * Sėjama TIK kai failo nėra: esamas skaitiklių failas yra bandymų istorija, o jo perrašymas
 * tuščiu objektu grąžintų jau išnaudotus retry biudžetus į nulį.
 */
export async function ensureRuntimeDirs(agRoot: string, runtimeRoot: string): Promise<void> {
  await Promise.all(runtimeDirectories(agRoot, runtimeRoot).map((dir) => nodeFsAdapter.makeDirectory(dir)));
  const retryCounts = path.join(runtimeRoot, "state", "retry-counts.json");
  if (!(await nodeFsAdapter.exists(retryCounts))) {
    await nodeFsAdapter.writeFileExclusive(retryCounts, "{}\n");
  }
}
