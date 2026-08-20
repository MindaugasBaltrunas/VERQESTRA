// Architektūros grafo ir progreso ledger'io IO (etalonai: AG_loop architecture/
// architecture-graph.ts skaitymo/rašymo pusė ir architecture/architecture-progress.ts 1:1).
// Tipai ir grynos taisyklės gyvena domain/architecture; čia — tik JSON failai. Kanoniniai
// keliai VERQESTRA layout'e: `vq/state/architecture/{graph.json,progress.json}` (kelius
// paduoda kvietėjas — saugykla jų neužkoduoja, kaip ir etalonas).

import path from "node:path";
import type {
  ArchitectureGraph,
  ArchitectureNodeProgress,
  ArchitectureProgress,
} from "../../domain/architecture/index.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/** Kanoninis grafo kelias projektui. */
export function architectureGraphPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), "vq", "state", "architecture", "graph.json");
}

/** Kanoninis progreso ledger'io kelias projektui. */
export function architectureProgressPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), "vq", "state", "architecture", "progress.json");
}

export async function readGraph(statePath: string): Promise<ArchitectureGraph | null> {
  const raw = await nodeFsAdapter.readTextFileIfExists(statePath);
  if (raw === undefined) return null;
  return JSON.parse(raw) as ArchitectureGraph;
}

export async function writeGraph(statePath: string, graph: ArchitectureGraph): Promise<void> {
  await nodeFsAdapter.writeTextFile(statePath, JSON.stringify(graph, null, 2));
}

export async function readProgress(statePath: string): Promise<ArchitectureProgress | null> {
  const raw = await nodeFsAdapter.readTextFileIfExists(statePath);
  if (raw === undefined) return null;
  return JSON.parse(raw) as ArchitectureProgress;
}

export async function writeProgress(statePath: string, progress: ArchitectureProgress): Promise<void> {
  await nodeFsAdapter.writeTextFile(statePath, JSON.stringify(progress, null, 2));
}

/**
 * Inicializuoja (arba atnaujina) progreso ledger'į importuotam grafui. Idempotentiška
 * refresh'ų atžvilgiu: esamo įrašo `done` statusas ir sukaupta evidencija IŠSAUGOMI —
 * visi kiti statusai grįžta į `planned`, nes grafo šaltinis galėjo pasikeisti.
 */
export async function initProgress(graph: ArchitectureGraph, statePath: string): Promise<ArchitectureProgress> {
  const existing = await readProgress(statePath);

  const nodes: Record<string, ArchitectureNodeProgress> = {};
  for (const node of graph.nodes) {
    const prev = existing?.nodes[node.id];
    nodes[node.id] = {
      status: prev?.status === "done" ? "done" : "planned",
      attempts: prev?.attempts ?? {},
      queued_tasks: prev?.queued_tasks ?? [],
      done_tasks: prev?.done_tasks ?? [],
      implemented_files: prev?.implemented_files ?? [],
      evidence_refs: prev?.evidence_refs ?? [],
      ...(prev?.interface_contract !== undefined ? { interface_contract: prev.interface_contract } : {}),
      ...(prev?.verified_at !== undefined ? { verified_at: prev.verified_at } : {}),
      ...(prev?.human_review_reason !== undefined ? { human_review_reason: prev.human_review_reason } : {}),
    };
  }

  const progress: ArchitectureProgress = {
    graph_hash: graph.imported_at,
    nodes,
  };

  await writeProgress(statePath, progress);
  return progress;
}

export async function updateNodeProgress(
  statePath: string,
  nodeId: string,
  update: Partial<ArchitectureNodeProgress>,
  clearFields: readonly ("interface_contract" | "verified_at" | "human_review_reason")[] = [],
): Promise<void> {
  const progress = await readProgress(statePath);
  if (!progress) throw new Error(`Progress ledger not found at: ${statePath}`);
  const existing = progress.nodes[nodeId];
  if (!existing) throw new Error(`Node "${nodeId}" not found in progress at: ${statePath}`);
  const merged = { ...existing, ...update };
  // Etalonas laukus išvalydavo per `laukas: undefined` (JSON.stringify juos numeta);
  // su exactOptionalPropertyTypes tas pats efektas išreiškiamas aiškiu clearFields sąrašu.
  for (const field of clearFields) delete merged[field];
  progress.nodes[nodeId] = merged;
  await writeProgress(statePath, progress);
}
