// Pure interface-contract inference. Low domain layer: no fs/process/git imports and no side
// effects — only a total function over already-loaded graph/progress/evidence value types.
// Behaviour etalon: AG_loop domain/architecture/interface-inference.ts; node:path
// basename/extname pakeisti path-lite (WBR VQ-204) — semantika identiška.

import { baseOf, splitExt } from "./path-lite.js";
import type { ArchitectureGraph, ArchitectureProgress, NodeInterfaceContract } from "./graph.js";
import type { EvidenceEntry } from "./evidence.js";

export function inferInterfaceContract(
  nodeId: string,
  graph: ArchitectureGraph,
  progress: ArchitectureProgress,
  evidenceLedger: EvidenceEntry[],
): NodeInterfaceContract {
  const incomingEdges = graph.edges.filter((e) => e.to === nodeId);
  const outgoingEdges = graph.edges.filter((e) => e.from === nodeId);

  const upstream = incomingEdges.map((e) => e.from);
  const downstream = outgoingEdges.map((e) => e.to);

  const inputs = incomingEdges.filter((e) => e.label !== undefined).map((e) => e.label as string);

  const outputs = outgoingEdges.filter((e) => e.label !== undefined).map((e) => e.label as string);

  const nodeProgress = progress.nodes[nodeId];
  const implementedFiles = nodeProgress?.implemented_files ?? [];
  const public_exports = implementedFiles.map((f) => splitExt(baseOf(f)).base);

  const checks = evidenceLedger
    .filter((e) => e.node_id === nodeId && (e.source === "openspec" || e.source === "readme"))
    .map((e) => e.excerpt);

  return { inputs, outputs, upstream, downstream, public_exports, checks };
}
