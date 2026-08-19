// Canonical graph from raw input. Normalization is total and deterministic: ids and
// references go through normalizeTaskReference, paths become POSIX, PDAG-2 placeholders
// are dropped, duplicate edges collapse, both collections are sorted. Deliberately NOT
// done here: repair — duplicate ids and self-edges are preserved exactly as given so
// validation can report them; a graph is never silently "fixed" by guessing.
// Behaviour etalon: AG_loop buildTaskGraph.

import { isPlaceholderDependency, normalizeTaskReference } from "../dependencies.js";
import { computeTaskGraphHash } from "./hash.js";
import {
  TASK_GRAPH_RULES_VERSION,
  TASK_GRAPH_SCHEMA_VERSION,
  compareDependencies,
  compareNodes,
  type TaskDependency,
  type TaskDependencyInput,
  type TaskGraph,
  type TaskGraphInput,
  type TaskGraphNodeInput,
  type TaskNode,
} from "./model.js";

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function normalizedList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeNode(input: TaskGraphNodeInput): TaskNode {
  const taskId = normalizeTaskReference(input.task_id);
  if (!taskId) {
    throw new Error(`task graph: node has no usable task id (${JSON.stringify(input.task_id)})`);
  }
  const node: TaskNode = {
    task_id: taskId,
    file: toPosix(input.file ?? "").trim(),
    status: input.status ?? "queued",
    checks: normalizedList(input.checks),
    scope: normalizedList(input.scope),
    requires_approval: input.requires_approval ?? false,
    approved: input.approved ?? false,
  };
  // Deklaruotų, bet tuščių sąrašų nelaikome deklaracija: `write_symbols: []` ir jokio
  // lauko reiškia tą patį — dimensija neįrodyta. Taip conflict detector'iui neatsiranda
  // antro, tylaus būdo pasakyti „nieko nerašau".
  const writeSymbols = normalizedList(input.write_symbols);
  if (writeSymbols.length > 0) node.write_symbols = writeSymbols;
  const architectureNodes = normalizedList(input.architecture_nodes);
  if (architectureNodes.length > 0) node.architecture_nodes = architectureNodes;

  if (input.estimated_tokens !== undefined) {
    node.estimated_tokens = Math.max(0, Math.trunc(input.estimated_tokens));
  }
  return node;
}

export function buildTaskGraph(input: TaskGraphInput): TaskGraph {
  const nodes = input.nodes.map(normalizeNode).sort(compareNodes);

  const declared: TaskDependencyInput[] = [];
  for (const rawNode of input.nodes) {
    for (const dependency of rawNode.depends_on ?? []) {
      declared.push({ task_id: rawNode.task_id, depends_on: dependency, origin: "markdown" });
    }
  }
  declared.push(...(input.dependencies ?? []));

  const byKey = new Map<string, TaskDependency>();
  for (const edge of declared) {
    const taskId = normalizeTaskReference(edge.task_id);
    const dependsOn = normalizeTaskReference(edge.depends_on);
    if (!taskId || !dependsOn || isPlaceholderDependency(dependsOn)) continue;
    const origin = edge.origin ?? "markdown";
    byKey.set(`${taskId}${dependsOn}${origin}`, { task_id: taskId, depends_on: dependsOn, origin });
  }

  const dependencies = [...byKey.values()].sort(compareDependencies);
  const graph: TaskGraph = {
    schema_version: TASK_GRAPH_SCHEMA_VERSION,
    rules_version: TASK_GRAPH_RULES_VERSION,
    graph_hash: "",
    nodes,
    dependencies,
  };
  return { ...graph, graph_hash: computeTaskGraphHash(graph) };
}
