// Architektūros grafo bootstrap'as iš .mmd šaltinio (etalonas: AG_loop orchestrator/
// bootstrap/bootstrap-architecture.ts). Ta pati parse -> convert -> write grandinė kaip
// rankinis importas, tad queue sintezė visada mato aktualų grafą; initProgress išsaugo
// `done` mazgų statusą per refresh'us. VERQESTRA keliai: šaltiniai vq/architecture/source,
// būsena vq/state/architecture.

import path from "node:path";
import {
  isMermaidFlowchart,
  parseMermaidFlowchart,
} from "../../application/code-intelligence/graph-source/mermaid-parser.js";
import { fromGraphSource } from "../../domain/architecture/index.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { detectBootstrapEligibility } from "./bootstrap-detector.js";
import {
  architectureGraphPath,
  architectureProgressPath,
  initProgress,
  writeGraph,
} from "./architecture-graph-store.js";

export type BootstrapArchitectureResult =
  | { status: "no-architecture" }
  | { status: "imported"; sourcePath: string; nodes: number; edges: number };

/**
 * Suranda `vq/architecture/source/*.mmd` per esamą bootstrap-detector skeną ir importuoja/
 * atnaujina architektūros grafą. Keli šaltiniai jau rikiuoti detektoriaus — deterministiškai
 * imamas PIRMAS flowchart'as: šaltinio kataloge gali gyventi ir kiti Mermaid diagramų tipai
 * (pvz. classDiagram code-map), kurių ši grandinė importuoti negali — jie praleidžiami.
 */
export async function bootstrapArchitectureFromSource(
  projectRoot: string,
  importedAt: string = new Date().toISOString(),
): Promise<BootstrapArchitectureResult> {
  const root = path.resolve(projectRoot);
  const detection = await detectBootstrapEligibility(root);

  if (detection.mmdSources.length === 0) {
    return { status: "no-architecture" };
  }

  let sourceAbsolutePath: string | undefined;
  let content: string | undefined;
  for (const candidate of detection.mmdSources) {
    const candidateContent = await nodeFsAdapter.readTextFileIfExists(candidate);
    if (candidateContent && isMermaidFlowchart(candidateContent)) {
      sourceAbsolutePath = candidate;
      content = candidateContent;
      break;
    }
  }
  if (!sourceAbsolutePath || !content) {
    return { status: "no-architecture" };
  }

  const sourceRelativePath = path.relative(root, sourceAbsolutePath).replace(/\\/g, "/");
  const mermaidGraph = parseMermaidFlowchart(content);
  const graph = fromGraphSource(mermaidGraph, sourceRelativePath, importedAt);

  await writeGraph(architectureGraphPath(root), graph);
  await initProgress(graph, architectureProgressPath(root));

  return {
    status: "imported",
    sourcePath: sourceRelativePath,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  };
}
