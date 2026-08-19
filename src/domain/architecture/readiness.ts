// Pure architecture-readiness domain module. No fs/path/process imports and no side effects —
// only the total functions that compute which nodes are ready given a graph and its progress.
// Behaviour etalon: AG_loop domain/architecture/readiness.ts.
//
// Cycle handling: imported architecture graphs are frequently cyclic (feedback edges like
// review→unknowns or store↔patch-engine). A naive "all incoming edges done" rule deadlocks
// every strongly connected component — each member waits for the others forever. Readiness
// therefore works on the SCC condensation (Tarjan): a strongly connected component is treated
// as ONE unit. Edges inside a component never block its members (they all become ready
// together), and an edge FROM a component is satisfied for downstream only once EVERY
// non-external member of that component is done. For acyclic graphs every component is a
// single node, so this degrades to exactly the old per-node rule.

import type { ArchitectureGraph, ArchitectureNode, ArchitectureProgress } from "./graph.js";

/**
 * Tarjan strongly-connected components over the architecture graph, iterative so deep chains
 * can't overflow the call stack. Returns nodeId -> component id; edges whose endpoints are not
 * graph nodes are ignored. Every node gets a component (single-node components for acyclic parts).
 */
export function computeStronglyConnectedComponents(graph: ArchitectureGraph): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) adjacency.set(node.id, []);
  for (const edge of graph.edges) {
    if (adjacency.has(edge.from) && adjacency.has(edge.to)) adjacency.get(edge.from)!.push(edge.to);
  }

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  let nextIndex = 0;
  let nextComponent = 0;

  for (const root of adjacency.keys()) {
    if (index.has(root)) continue;
    index.set(root, nextIndex);
    lowlink.set(root, nextIndex);
    nextIndex += 1;
    stack.push(root);
    onStack.add(root);
    const frames: Array<{ id: string; child: number }> = [{ id: root, child: 0 }];

    while (frames.length > 0) {
      // Invariantas: while sąlyga garantuoja bent vieną frame — indeksavimas saugus.
      const frame = frames[frames.length - 1]!;
      const neighbors = adjacency.get(frame.id)!;
      if (frame.child < neighbors.length) {
        const next = neighbors[frame.child]!;
        frame.child += 1;
        if (!index.has(next)) {
          index.set(next, nextIndex);
          lowlink.set(next, nextIndex);
          nextIndex += 1;
          stack.push(next);
          onStack.add(next);
          frames.push({ id: next, child: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(frame.id, Math.min(lowlink.get(frame.id)!, index.get(next)!));
        }
      } else {
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) lowlink.set(parent.id, Math.min(lowlink.get(parent.id)!, lowlink.get(frame.id)!));
        if (lowlink.get(frame.id) === index.get(frame.id)) {
          for (;;) {
            const member = stack.pop()!;
            onStack.delete(member);
            component.set(member, nextComponent);
            if (member === frame.id) break;
          }
          nextComponent += 1;
        }
      }
    }
  }

  return component;
}

export function getReadyNodes(graph: ArchitectureGraph, progress: ArchitectureProgress): ArchitectureNode[] {
  const component = computeStronglyConnectedComponents(graph);

  const membersByComponent = new Map<number, ArchitectureNode[]>();
  for (const node of graph.nodes) {
    const componentId = component.get(node.id)!;
    const members = membersByComponent.get(componentId);
    if (members) members.push(node);
    else membersByComponent.set(componentId, [node]);
  }

  const componentDone = (componentId: number): boolean =>
    (membersByComponent.get(componentId) ?? []).every(
      (member) => member.external === true || progress.nodes[member.id]?.status === "done",
    );

  // A component is blocked when ANY cross-component edge into ANY of its members is
  // unsatisfied; intra-component edges never block. This keeps the whole cycle together:
  // no member leaks to ready while another member's upstream is still pending.
  const blockedComponents = new Set<number>();
  for (const edge of graph.edges) {
    const toComponent = component.get(edge.to);
    if (toComponent === undefined) continue;
    const fromComponent = component.get(edge.from);
    if (fromComponent === toComponent) continue;
    const satisfied =
      fromComponent === undefined
        ? // Edge from an id that is not a graph node: same fallback as the pre-SCC rule.
          progress.nodes[edge.from]?.status === "done"
        : componentDone(fromComponent);
    if (!satisfied) blockedComponents.add(toComponent);
  }

  return graph.nodes.filter((node) => !blockedComponents.has(component.get(node.id)!));
}

export function computeReadiness(graph: ArchitectureGraph, progress: ArchitectureProgress): ArchitectureProgress {
  const readyIds = new Set(getReadyNodes(graph, progress).map((n) => n.id));
  const updatedNodes = { ...progress.nodes };
  for (const [id, nodeProgress] of Object.entries(updatedNodes)) {
    if (nodeProgress.status === "planned" && readyIds.has(id)) {
      updatedNodes[id] = { ...nodeProgress, status: "ready" };
    }
  }
  return { ...progress, nodes: updatedNodes };
}
