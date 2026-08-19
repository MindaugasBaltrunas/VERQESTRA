// Grafo surinkimas iš struktūrinio šaltinio: sanitizacija + input-source klasifikacija
// import'o metu. Atskirtas nuo graph.ts (tipų modulio), kad importų grafas liktų aciklinis:
// šis failas importuoja ir tipus, ir klasifikavimo taisyklę — abu žemyn, be ciklo.
// Behaviour etalon: AG_loop domain/architecture/graph.ts fromMermaidGraph (WBR VQ-204:
// pervadinta į fromGraphSource kartu su GraphSource inversija; elgesys 1:1).

import { sanitizeGraphLabel, type ArchitectureGraph, type GraphSource } from "./graph.js";
import { classifyInputSourceNodes } from "./input-source-classification.js";

export function fromGraphSource(source: GraphSource, sourcePath: string, importedAt: string): ArchitectureGraph {
  // Pure input-source nodes (data sources / external actors, e.g. `A[Git Repository]`)
  // are flagged `external` at import time so no consumer ever synthesizes an
  // implementation task for them — see input-source-classification.ts (task 895).
  return classifyInputSourceNodes({
    source_path: sourcePath,
    imported_at: importedAt,
    nodes: source.nodes.map((n) => ({
      id: n.id,
      label: sanitizeGraphLabel(n.label),
      kind: "unknown",
      status: "planned",
    })),
    edges: source.edges.map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.label !== undefined ? { label: sanitizeGraphLabel(e.label) } : {}),
      type: "unknown",
    })),
  });
}
