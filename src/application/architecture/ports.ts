// architecture klasterio IO portai (WBR VQ-501 3/5-c): evidence ledger'io/sintezes
// artefaktų failai ir mazgo progreso persistencija. Realūs adapteriai — E4
// (nodeFsAdapter + infrastructure/bootstrap/architecture-graph-store updateNodeProgress,
// suriša kompozicija VQ-504).

import type { ArchitectureNodeProgress } from "../../domain/architecture/graph.js";

export type ArchitectureStateFsPort = {
  exists(absolutePath: string): Promise<boolean>;
  /** Failo tekstas arba `undefined`, kai failo nėra (nebuvimas — atsakymas, ne klaida). */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** Append su tėvinių katalogų sukūrimu (etalono mkdir recursive + appendFile). */
  appendTextFile(absolutePath: string, text: string): Promise<void>;
  /** Rašymas su tėvinių katalogų sukūrimu (etalono mkdir recursive + writeFile). */
  writeTextFile(absolutePath: string, text: string): Promise<void>;
};

/**
 * Mazgo progreso persistencijos portas — etalono updateNodeProgress(progressPath, ...)
 * atitikmuo be kelio: `vq/state/architecture/progress.json` vietą žino adapteris,
 * ne use case'as.
 */
export type NodeProgressStorePort = {
  updateNodeProgress(nodeId: string, update: Partial<ArchitectureNodeProgress>): Promise<void>;
};
