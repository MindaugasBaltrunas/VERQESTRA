// Task-graph traversal: node resolution, adjacency, cycles and scheduling depths.
// Task graphs are queue-sized (tens of nodes), so the obvious reachability formulation is
// used rather than an index-based SCC pass — the cost is irrelevant, the rule readable.
// Behaviour etalon: AG_loop task-graph.ts traversal half.

import { dependencyMatches, normalizeTaskReference } from "../dependencies.js";
import { detectCyclesOverEdges, longestDependencyDepths } from "./adjacency.js";
import type { TaskGraph, TaskNode } from "./model.js";

/** First node whose id matches the reference, or undefined. Exact match wins over a prefix. */
export function resolveTaskNode(graph: TaskGraph, reference: string): TaskNode | undefined {
  const normalized = normalizeTaskReference(reference);
  if (!normalized) return undefined;
  const exact = graph.nodes.find((node) => node.task_id === normalized);
  if (exact) return exact;

  // Markdown sutrumpina blokuotoją iki numerio (`depends_on: 1111`) — ir kartais atvirkščiai:
  // mazgas yra `1111`, o nuoroda parašyta pilnu vardu. Iki 2026-08-22 čia buvo tik viena kryptis
  // (`node.startsWith(ref + "-")`), o `dependencyMatches` domene — simetriška. Tas pats klausimas
  // gaudavo du atsakymus: mazgui `1111` nuoroda `1111-fix-parser` planuotojui buvo
  // `missing-dependency`, o `schedule-next-wave` ir `route-blocked` laikė ją atitikmeniu. Abu
  // fail-closed, tad nesaugaus planavimo nebuvo — bet dvi taisyklės tam pačiam klausimui yra
  // vieta, kur trečias kvietėjas pasirenka neteisingą.
  const candidates = graph.nodes.filter((node) => dependencyMatches(normalized, node.task_id));
  // Dviprasmybė atmetama, o ne sprendžiama rūšiavimu. `1111` prie `1111-a` ir `1111-b` anksčiau
  // tyliai duodavo pirmą pagal id; tyli teisinga atsakymo pusė čia yra „nežinau", nes klaidingas
  // blokuotojas atrakina task'ą, kuris turėjo laukti.
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Blocker ids declared for a task, in canonical order. Ta pati briauna, deklaruota
 * dviem kilmėmis (`markdown` ir `runtime`), yra VIENAS blokuotojas — ne du. */
export function dependenciesOf(graph: TaskGraph, taskId: string): string[] {
  const normalized = normalizeTaskReference(taskId);
  return [...new Set(graph.dependencies.filter((edge) => edge.task_id === normalized).map((edge) => edge.depends_on))];
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

/**
 * Cycles over the internal edges: a node that can reach itself participates; groups are
 * mutually-reachable sets (strongly connected components).
 *
 * Algoritmas gyvena `adjacency.ts` ir yra BENDRAS su bangos planuokliu; čia lieka tik šio
 * skaitytojo briaunų politika — fail-closed `internalEdges`.
 */
export function detectTaskGraphCycles(graph: TaskGraph): { members: Set<string>; groups: string[][] } {
  return detectCyclesOverEdges(internalEdges(graph));
}

/**
 * Longest dependency path to each node — the deterministic scheduling order. Cycle
 * participants get depth 0: they are never schedulable, so their depth carries no meaning.
 */
export function taskGraphDepths(
  graph: TaskGraph,
  // Ciklo dalyviai paduodami, kai kvietėjas juos jau apskaičiavo. `buildReadySet` kviečia ir
  // `validateTaskGraph`, ir šitą, o abu vidumi ėjo per `detectTaskGraphCycles` — tas pats
  // tranzityvinis uždarinys per visą grafą dukart per vieną ready-set.
  precomputedCycleMembers?: ReadonlySet<string>,
): Map<string, number> {
  const edges = internalEdges(graph);
  // `internalEdges` užsėja KIEKVIENĄ mazgą, tad `edges.keys()` sutampa su `graph.nodes` ID
  // rinkiniu — bendras primityvas apeina visus mazgus lygiai taip pat, kaip anksčiau darė ši
  // funkcija.
  return longestDependencyDepths(edges, precomputedCycleMembers ?? detectCyclesOverEdges(edges).members);
}
