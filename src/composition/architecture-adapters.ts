// Architektūros ir code-intelligence klasterio adapteriai (manual DI, LAY-2).
//
// Šis klasteris skaito PRODUKTO medį (indeksas, simbolių skenas, kodo žemėlapis) ir rašo
// architektūros būseną (`vq/state/architecture/*`). Failų sistemos portas čia yra tas pats
// `codeIntelligenceFs`, kurį naudoja ir final-audit ribų patikra — antra kopija reikštų, kad
// vartai ir komanda gali matyti skirtingą tą patį medį.

import type { ArchitectureWaveFsPort, ArchitectureWavePorts } from "../application/architecture/ports.js";
import type { DirectoryEntry } from "../application/code-intelligence/ports.js";
import type { ArchitectureGraph, ArchitectureProgress } from "../domain/architecture/graph.js";
import { initProgress, updateNodeProgress, writeGraph } from "../infrastructure/bootstrap/architecture-graph-store.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { codeIntelligenceFs } from "./node-adapters.js";

/** Wave variklio FS portas: būsenos skaitymas/rašymas plius katalogų enumeracija. */
export const architectureWaveFs: ArchitectureWaveFsPort = {
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
  writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
  removeFile: (absolutePath) => nodeFsAdapter.removeFile(absolutePath),
  listFiles: (absoluteDir) => nodeFsAdapter.listFiles(absoluteDir),
  listDirectory: (absoluteDir): Promise<DirectoryEntry[]> => codeIntelligenceFs.listDirectory(absoluteDir),
};

/**
 * Wave variklio portai.
 *
 * Laikrodžiai (`nowMs`/`nowIso`) SĄMONINGAI nepaduodami: portas jiems turi savo default'us, o
 * kompozicijos įrašytas realus laikrodis būtų tiesiog tas pats — tik dar vienoje vietoje, kurią
 * testams reikėtų apeiti.
 */
export const architectureWavePorts: ArchitectureWavePorts = {
  fs: architectureWaveFs,
  updateNodeProgress: (progressPath, nodeId, update, clearFields) =>
    updateNodeProgress(progressPath, nodeId, update, clearFields),
};

/**
 * Grafo saugykla `architecture` komandai: importo rašymas ir progreso inicializacija.
 *
 * Abu veiksmai eina per TĄ PATĮ infrastructure modulį kaip ir bootstrap kelias — kitaip
 * rankinis `architecture import` ir automatinis bootstrap rašytų skirtingos formos būseną,
 * o wave variklis vieną iš jų perskaitytų neteisingai.
 */
export const architectureGraphStore = {
  writeGraph: (statePath: string, graph: ArchitectureGraph): Promise<void> => writeGraph(statePath, graph),
  initProgress: (graph: ArchitectureGraph, statePath: string): Promise<ArchitectureProgress> =>
    initProgress(graph, statePath),
};
