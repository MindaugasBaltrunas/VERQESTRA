// Task-graph traversal: node resolution, adjacency, cycles and scheduling depths.
// Task graphs are queue-sized (tens of nodes), so the obvious reachability formulation is
// used rather than an index-based SCC pass — the cost is irrelevant, the rule readable.
// Behaviour etalon: AG_loop task-graph.ts traversal half.

import { normalizeTaskReference } from "../dependencies.js";
import type { TaskGraph, TaskNode } from "./model.js";

/** First node whose id matches the reference, or undefined. Exact match wins over a prefix. */
export function resolveTaskNode(graph: TaskGraph, reference: string): TaskNode | undefined {
  const normalized = normalizeTaskReference(reference);
  if (!normalized) return undefined;
  const exact = graph.nodes.find((node) => node.task_id === normalized);
  if (exact) return exact;
  // Markdown often abbreviates a blocker to its number (`depends_on: 1111`). Nodes are
  // sorted by id, so the prefix fallback resolves the same way on every run.
  return graph.nodes.find((node) => node.task_id.startsWith(`${normalized}-`));
}

/** Blocker ids declared for a task, in canonical order. */
export function dependenciesOf(graph: TaskGraph, taskId: string): string[] {
  const normalized = normalizeTaskReference(taskId);
  return graph.dependencies.filter((edge) => edge.task_id === normalized).map((edge) => edge.depends_on);
}

/** Adjacency map `task → its blockers`, restricted to edges resolving to a node in the graph. */
export function internalEdges(graph: TaskGraph): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const node of graph.nodes) edges.set(node.task_id, []);
  for (const edge of graph.dependencies) {
    const resolved = resolveTaskNode(graph, edge.depends_on);
    if (!resolved || !edges.has(edge.task_id)) continue;
    const current = edges.get(edge.task_id) as string[];
    if (!current.includes(resolved.task_id)) current.push(resolved.task_id);
  }
  for (const blockers of edges.values()) blockers.sort();
  return edges;
}

/** Nodes reachable from `start` by following dependency edges (task → its blockers). */
function dependencyClosure(start: string, edges: ReadonlyMap<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(start) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(edges.get(current) ?? []));
  }
  return seen;
}

/**
 * Cycles over the internal edges: a node that can reach itself participates; groups are
 * mutually-reachable sets (strongly connected components).
 */
export function detectTaskGraphCycles(graph: TaskGraph): { members: Set<string>; groups: string[][] } {
  const edges = internalEdges(graph);
  const closures = new Map<string, Set<string>>();
  for (const node of edges.keys()) closures.set(node, dependencyClosure(node, edges));

  const members = new Set<string>();
  for (const [node, closure] of closures) {
    if (closure.has(node)) members.add(node);
  }

  const groups: string[][] = [];
  const grouped = new Set<string>();
  for (const node of [...members].sort()) {
    if (grouped.has(node)) continue;
    const group = [...members]
      .filter((other) => other === node || (closures.get(node)?.has(other) && closures.get(other)?.has(node)))
      .sort();
    for (const member of group) grouped.add(member);
    groups.push(group);
  }

  return { members, groups };
}

/**
 * Longest dependency path to each node — the deterministic scheduling order. Cycle
 * participants get depth 0: they are never schedulable, so their depth carries no meaning.
 */
export function taskGraphDepths(graph: TaskGraph): Map<string, number> {
  const edges = internalEdges(graph);
  const { members: cycleMembers } = detectTaskGraphCycles(graph);
  const depths = new Map<string, number>();

  const depthOf = (taskId: string, seen: Set<string>): number => {
    const cached = depths.get(taskId);
    if (cached !== undefined) return cached;
    if (cycleMembers.has(taskId) || seen.has(taskId)) return 0;
    seen.add(taskId);
    const blockerDepths = (edges.get(taskId) ?? []).map((blocker) => depthOf(blocker, seen) + 1);
    const depth = blockerDepths.length > 0 ? Math.max(...blockerDepths) : 0;
    seen.delete(taskId);
    depths.set(taskId, depth);
    return depth;
  };

  for (const node of graph.nodes) depthOf(node.task_id, new Set());
  return depths;
}
