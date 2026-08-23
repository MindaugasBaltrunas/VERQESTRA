// Task-graph content fingerprint: `tg<rules>:<sha256 pirmi 16 hex>` iš kanoninio JSON.
// Everything that can change scheduling is hashed; the stored `graph_hash` itself is
// excluded (it is the output). `write_symbols`/`architecture_nodes` enter the payload only
// when declared — the conditional form keeps rules_version=1: an undeclared graph hashes
// exactly as before those fields existed, a declaring one gets a distinct hash.
// Behaviour etalon: AG_loop computeTaskGraphHash (byte-stable via shared canonical JSON).

import { canonicalJsonStringify } from "../../../shared/json.js";
import { sha256Hex } from "../../../shared/hash.js";
import { compareDependencies, compareNodes, type TaskGraph } from "./model.js";

export function computeTaskGraphHash(graph: Omit<TaskGraph, "graph_hash"> & { graph_hash?: string }): string {
  const payload = {
    rules: graph.rules_version,
    schema: graph.schema_version,
    nodes: [...graph.nodes].sort(compareNodes).map((node) => ({
      id: node.task_id,
      file: node.file,
      status: node.status,
      checks: [...node.checks],
      scope: [...node.scope],
      ...(node.write_symbols && node.write_symbols.length > 0 ? { write_symbols: [...node.write_symbols] } : {}),
      ...(node.architecture_nodes && node.architecture_nodes.length > 0
        ? { architecture_nodes: [...node.architecture_nodes] }
        : {}),
      requires_approval: node.requires_approval,
      approved: node.approved,
      estimated_tokens: node.estimated_tokens ?? null,
    })),
    deps: [...graph.dependencies]
      .sort(compareDependencies)
      .map((edge) => ({ from: edge.task_id, to: edge.depends_on, origin: edge.origin })),
  };
  // Prefiksas ima GRAFO `rules_version`, ne šio build'o konstantą (2026-08-23, operatoriaus
  // radinys). Antraštė visada deklaravo formą `tg<rules>`, bet reikšmė buvo imama iš
  // `TASK_GRAPH_RULES_VERSION`, tad grafas, pasirašytas taisyklėmis 999, gaudavo `tg1:` — t. y.
  // prefiksas, kurio VISA prasmė yra pasakyti, kurios taisyklės pagimdė atspaudą, sakydavo
  // einamojo proceso versiją. Dviejų skirtingų taisyklių atspaudai buvo neatskiriami iš akies.
  //
  // Elgesys nepakinta nė vienam realiam grafui: `buildTaskGraph` visada antspauduoja
  // `TASK_GRAPH_RULES_VERSION`, tad kol ji yra 1, `tg${graph.rules_version}` === `tg1`.
  return `tg${graph.rules_version}:${sha256Hex(canonicalJsonStringify(payload)).slice(0, 16)}`;
}
