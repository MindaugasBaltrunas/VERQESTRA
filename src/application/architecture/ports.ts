// architecture klasterio IO portai (WBR VQ-501 3/5-c): evidence ledger'io/sintezes
// artefaktų failai ir mazgo progreso persistencija. Realūs adapteriai — E4
// (nodeFsAdapter + infrastructure/bootstrap/architecture-graph-store updateNodeProgress,
// suriša kompozicija VQ-504).

import type { ArchitectureNodeProgress } from "../../domain/architecture/graph.js";
import type { DirectoryEntry } from "../code-intelligence/ports.js";

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

/** Wave variklio FS portas (3/5-d): bazinis portas + šalinimas ir katalogų enumeracija. */
export type ArchitectureWaveFsPort = ArchitectureStateFsPort & {
  /** Šalinimas be klaidos, kai failo nėra (etalono `rm { force: true }`). */
  removeFile(absolutePath: string): Promise<void>;
  /** Failų vardai kataloge; `[]` kai katalogo nėra (etalono readdir-catch). */
  listFiles(absoluteDir: string): Promise<string[]>;
  /** Katalogo įrašai; `[]` kai katalogo nėra — implementation-detector walk. */
  listDirectory(absoluteDir: string): Promise<DirectoryEntry[]>;
};

/**
 * Wave variklio portai. `updateNodeProgress` — etalono architecture-progress
 * updateNodeProgress(progressPath, ...) forma su keliu (infrastructure
 * architecture-graph-store implementacija 1:1; suriša kompozicija VQ-504).
 * Laikrodžiai injektuojami testams (runId Date.now / verified_at ISO).
 */
export type ArchitectureWavePorts = {
  fs: ArchitectureWaveFsPort;
  updateNodeProgress(
    progressPath: string,
    nodeId: string,
    update: Partial<ArchitectureNodeProgress>,
    clearFields?: readonly ("interface_contract" | "verified_at" | "human_review_reason")[],
  ): Promise<void>;
  nowMs?: () => number;
  nowIso?: () => string;
};
