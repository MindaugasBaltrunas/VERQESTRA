// Architektūros ir code-intelligence klasterio adapteriai (manual DI, LAY-2).
//
// Šis klasteris skaito PRODUKTO medį (indeksas, simbolių skenas, kodo žemėlapis) ir rašo
// architektūros būseną (`vq/state/architecture/*`). Kodo skaitymas eina per ŠAKNIES APIMTIES
// `codeIntelligenceFs` — tą patį, kurį naudoja final-audit ribų patikra ir code-index vartai:
// antra kopija reikštų ne tik skirtingą tą patį medį, bet ir prarastą symlink'o vartą.

import type { ArchitectureWaveFsPort, ArchitectureWavePorts } from "../../application/architecture/ports.js";
import type { DirectoryEntry } from "../../application/code-intelligence/ports.js";
import type { ArchitectureGraph, ArchitectureProgress } from "../../domain/architecture/graph.js";
import { initProgress, updateNodeProgress, writeGraph } from "../../infrastructure/bootstrap/architecture-graph-store.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { codeIntelligenceFs } from "../runtime/node-adapters.js";
import type { AssembleContextPackDeps } from "../../application/context-pack/assemble/assemble.js";
import { createContextCacheAdapter } from "../../infrastructure/persistence/context-cache-store.js";
import { attemptIdentityAdapter, type AttemptResolutionPort } from "../../infrastructure/state/attempt-resolution.js";
import { contextPackFs } from "./readiness-adapters.js";

/**
 * Wave variklio FS portas: būsenos skaitymas/rašymas plius katalogų enumeracija.
 *
 * `listDirectory` eina per šaknies apimties code-intelligence adapterį (implementation-detector
 * juo vaikšto po produkto medį), todėl portui reikia projekto šaknies.
 */
export function architectureWaveFs(projectRoot: string): ArchitectureWaveFsPort {
  const codeFs = codeIntelligenceFs(projectRoot);
  return {
    exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
    writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
    removeFile: (absolutePath) => nodeFsAdapter.removeFile(absolutePath),
    listFiles: (absoluteDir) => nodeFsAdapter.listFiles(absoluteDir),
    listDirectory: (absoluteDir): Promise<DirectoryEntry[]> => codeFs.listDirectory(absoluteDir),
  };
}

/**
 * Wave variklio portai.
 *
 * Laikrodžiai (`nowMs`/`nowIso`) SĄMONINGAI nepaduodami: portas jiems turi savo default'us, o
 * kompozicijos įrašytas realus laikrodis būtų tiesiog tas pats — tik dar vienoje vietoje, kurią
 * testams reikėtų apeiti.
 */
export function architectureWavePorts(projectRoot: string): ArchitectureWavePorts {
  return {
    fs: architectureWaveFs(projectRoot),
    updateNodeProgress: (progressPath, nodeId, update, clearFields) =>
      updateNodeProgress(progressPath, nodeId, update, clearFields),
  };
}

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

/**
 * `context-pack` surinkimo deps.
 *
 * Kešas paduodamas VISADA: jo nebuvimas portui reiškia `--no-context-cache`, o tai kas kartą
 * iš naujo skaitytų ir reitinguotų visą kontekstą. Kešo raktas mato ŠALTINIŲ hash'us, ne kodą,
 * todėl pack'o semantiką keičiantis pataisymas privalo kelti `CONTEXT_CACHE_VERSION` — kitaip
 * senas įrašas grįžta kaip `hit` ir tyliai anuliuoja pataisymą (žr. CLAUDE.md).
 *
 * `attemptIdentity` susieja context-size telemetriją su TUO PAČIU bandymu, kurį mato usage
 * eilutės; be jos dvi to paties bandymo eilutės būtų nesugretinamos.
 */
export function assembleContextPackDeps(
  projectRoot: string,
  runtimeRoot: string,
  resolution: AttemptResolutionPort,
): AssembleContextPackDeps {
  return {
    fs: contextPackFs,
    codeFs: codeIntelligenceFs(projectRoot),
    cache: createContextCacheAdapter(projectRoot, runtimeRoot),
    attemptIdentity: attemptIdentityAdapter(resolution),
  };
}
