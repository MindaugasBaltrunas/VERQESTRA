// Vienintelė vieta, kur application/interfaces portai surišami su REALIAIS Node adapteriais
// (manual DI, LAY-2). Jokios verslo logikos: tik pervadinimai ir siaurinimai.
//
// Kodėl adapteriai surišami ČIA, o ne portų deklaravimo vietoje: portas yra kvietėjo poreikis, o
// adapteris — infrastruktūros galimybė. Kai jie sutampa vardais, pervadinimo eilutės nėra; kai
// nesutampa (`rename` vs `renamePath`), skirtumas matomas vienoje eilutėje, o ne pasislepia
// adapteryje.

import type { LearningFsPort } from "../application/learning/ports.js";
import type { JsonSchemaExportPorts } from "../application/policy-governance/json-schema-export.js";
import type { ApiContractExportPorts } from "../application/task-planning/api-contract-export.js";
import type { OpenSpecReconcileFsPort } from "../application/task-execution/openspec-reconcile.js";
import { taskLedgerPath } from "../application/task-execution/task-ledger-rules.js";
import type { TaskLedgerEntry } from "../application/task-execution/task-ledger-rules.js";
import type { TaskLedgerStorePort } from "../application/task-execution/task-ledger-service.js";
import { toPrettyJson, tryParseJson } from "../shared/json.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";

/** `export-json-schema` portas: vienintelis rašymas, visada atominis. */
export const jsonSchemaExportPorts: JsonSchemaExportPorts = {
  writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
};

/** `openspec-reconcile` portas: archyvavimas plius katalogų enumeracija. */
export const openSpecReconcileFs: OpenSpecReconcileFsPort = {
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  writeTextFileAtomic: (absolutePath, content) => nodeFsAdapter.writeTextFileAtomic(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  // Portas prašo `rename`, adapteris siūlo `renamePath` su win32 contention retry — skirtumas
  // lieka matomas čia, o ne paslėptas adapteryje.
  rename: (fromPath, toPath) => nodeFsAdapter.renamePath(fromPath, toPath),
  listSubdirectories: (absoluteDir) => nodeFsAdapter.listSubdirectories(absoluteDir),
  listFiles: (absoluteDir) => nodeFsAdapter.listFiles(absoluteDir),
};

/** Learning atmintis: skaitymas plius append/write su katalogo sukūrimu. */
export const learningFs: LearningFsPort = {
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
  writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
};

/** `export-api-contract`: spec šaltinio skaitymas plius vienas rašymas. */
export const apiContractExportPorts: ApiContractExportPorts = {
  fs: {
    exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    listSubdirectories: (absoluteDir) => nodeFsAdapter.listSubdirectories(absoluteDir),
  },
  writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
};

/**
 * Task ledger'io saugykla. Serializacija (`toPrettyJson`) lieka ČIA, o ne adapteryje: baitinis
 * on-disk formatas yra kontraktas, kurį skaito ir kiti procesai.
 *
 * Sugadintas ledger'is grąžinamas kaip TUŠČIAS, o ne meta: `sync` komanda tokiu atveju jį
 * perrašo teisinga forma, o griuvimas paliktų operatorių be vienintelio įrankio, kuris tai taiso.
 */
export function taskLedgerStore(runtimeRoot: string): TaskLedgerStorePort {
  const file = taskLedgerPath(runtimeRoot);
  return {
    exists: () => nodeFsAdapter.exists(file),
    read: async () => {
      const raw = await nodeFsAdapter.readTextFileIfExists(file);
      if (raw === undefined) return {};
      const parsed = tryParseJson<unknown>(raw);
      if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        return {};
      }
      return parsed.value as Record<string, TaskLedgerEntry>;
    },
    write: (ledger) => nodeFsAdapter.writeTextFile(file, toPrettyJson(ledger)),
  };
}
