// Vienintelė vieta, kur application/interfaces portai surišami su REALIAIS Node adapteriais
// (manual DI, LAY-2). Jokios verslo logikos: tik pervadinimai ir siaurinimai.
//
// Kodėl adapteriai surišami ČIA, o ne portų deklaravimo vietoje: portas yra kvietėjo poreikis, o
// adapteris — infrastruktūros galimybė. Kai jie sutampa vardais, pervadinimo eilutės nėra; kai
// nesutampa (`rename` vs `renamePath`), skirtumas matomas vienoje eilutėje, o ne pasislepia
// adapteryje.

import type { JsonSchemaExportPorts } from "../application/policy-governance/json-schema-export.js";
import type { OpenSpecReconcileFsPort } from "../application/task-execution/openspec-reconcile.js";
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
