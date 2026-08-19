// Pure input-source node classification (task 895). No fs/process imports and no side
// effects — only total functions over an `ArchitectureGraph`.
// Behaviour etalon: AG_loop domain/architecture/input-source-classification.ts.
//
// Problem this solves: architecture graphs routinely contain nodes that are the
// system's INPUT data sources or external actors (e.g. `A[Git Repository]`,
// `X[Git Diff / File Watcher / CI PR Diff]`, a `User` actor). They are not implementable
// code modules, so synthesizing an implementation task for them fabricates scope
// (`src/a.ts`) out of thin air. The readiness rules (`readiness.ts`) treat `external: true`
// nodes as satisfied upstream — this module is what SETS the flag, deterministically
// from the graph shape alone.
//
// Classification rule (deliberately conservative — both signals required):
//   1. structural: the node has NO incoming edges and at least one outgoing edge
//      (it only feeds the system; nothing in the architecture produces it), AND
//   2. lexical: its label/description names a known input source or external actor.
// A lone keyword match never reclassifies a real module (a `User Service` with incoming
// edges stays implementable), and a lone root position never reclassifies a real entry
// module (`Scan Orchestrator` stays implementable). An explicit `external` boolean on
// the node always wins over the heuristic.

import type { ArchitectureGraph, ArchitectureNode } from "./graph.js";

/** Labels that (matched as the whole label) denote human/system actors, not code. */
export const INPUT_SOURCE_ACTOR_LABELS: readonly string[] = [
  "user",
  "users",
  "end user",
  "admin",
  "administrator",
  "developer",
  "operator",
  "customer",
  "client",
  "browser",
  "human",
  "actor",
];

/** Substrings that denote pure input data sources / external systems. */
export const INPUT_SOURCE_KEYWORDS: readonly string[] = [
  "git repository",
  "git repo",
  "source repository",
  "code repository",
  "source code",
  "codebase",
  "git diff",
  "file watcher",
  "pr diff",
  "data source",
  "input source",
  "file system",
  "filesystem",
  "external",
  "third-party",
  "3rd party",
];

function nodeText(node: ArchitectureNode): string {
  return `${node.label} ${node.description ?? ""}`.toLowerCase().trim();
}

/**
 * True when the node is a pure input source / external actor per the module rule above.
 * `incomingCount`/`outgoingCount` are the node's edge counts in the graph; an explicit
 * `external` boolean on the node short-circuits the heuristic.
 */
export function isPureInputSourceNode(
  node: ArchitectureNode,
  incomingCount: number,
  outgoingCount: number,
): boolean {
  if (node.external !== undefined) return node.external;
  if (incomingCount > 0 || outgoingCount === 0) return false;
  const text = nodeText(node);
  const label = node.label.toLowerCase().trim();
  if (INPUT_SOURCE_ACTOR_LABELS.includes(label)) return true;
  return INPUT_SOURCE_KEYWORDS.some((keyword) => text.includes(keyword));
}

/**
 * Returns a graph whose pure input-source nodes carry `external: true` (and, when the
 * node kind is still "unknown", `kind: "input"`). Nodes with an explicit `external`
 * boolean are left untouched. Pure and idempotent: re-running on an already-classified
 * graph changes nothing.
 */
export function classifyInputSourceNodes(graph: ArchitectureGraph): ArchitectureGraph {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of graph.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
  }

  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.external !== undefined) return node;
      if (!isPureInputSourceNode(node, incoming.get(node.id) ?? 0, outgoing.get(node.id) ?? 0)) {
        return node;
      }
      return {
        ...node,
        external: true,
        kind: node.kind === "unknown" ? "input" : node.kind,
      };
    }),
  };
}

/**
 * True when classification would add flags the persisted graph does not have yet —
 * lets adapters migrate a pre-classification `graph.json` with a single idempotent write.
 */
export function inputSourceClassificationChanged(before: ArchitectureGraph, after: ArchitectureGraph): boolean {
  return before.nodes.some((node, index) => {
    const classified = after.nodes[index];
    return classified !== undefined && (node.external !== classified.external || node.kind !== classified.kind);
  });
}
