// Mermaid flowchart parser — GraphSource gamintojas (E2 inversija: rezultatas struktūriškai
// tenkina domain/architecture GraphSource). Behaviour etalon: AG_loop architecture/
// mermaid-parser.ts (1:1).

export interface MermaidNode {
  id: string;
  label: string;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
}

export interface MermaidGraph {
  nodes: MermaidNode[];
  edges: MermaidEdge[];
}

// Node capture: (id)(((label)))([label])((label))({label})
const NODE = String.raw`(\w+)(?:\(\(([^)]*)\)\)|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?`;

const TEXT_ARROW_RE = new RegExp(`^${NODE}\\s*--\\s*(.+?)\\s*-->\\s*${NODE}$`);
const LABEL_ARROW_RE = new RegExp(`^${NODE}\\s*-->\\|([^|]*)\\|\\s*${NODE}$`);
const SIMPLE_ARROW_RE = new RegExp(`^${NODE}\\s*-->\\s*${NODE}$`);
const NODE_DEF_RE = new RegExp(`^${NODE}$`);

function toGroups(m: RegExpMatchArray): (string | undefined)[] {
  return m;
}

function extractNode(gs: (string | undefined)[], offset: number): { id: string; label?: string } {
  const label = gs[offset + 1] ?? gs[offset + 2] ?? gs[offset + 3] ?? gs[offset + 4];
  return {
    id: gs[offset] as string,
    ...(label === undefined ? {} : { label }),
  };
}

function significantLines(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));
}

/**
 * True when the first significant line carries a flowchart/graph directive —
 * i.e. the content is a diagram type this parser supports. Other Mermaid
 * diagram types (classDiagram, sequenceDiagram, ...) return false.
 */
export function isMermaidFlowchart(content: string): boolean {
  return /^(flowchart|graph)\b/i.test(significantLines(content)[0] ?? "");
}

export function parseMermaidFlowchart(content: string): MermaidGraph {
  const lines = significantLines(content);

  const first = lines[0] ?? "";
  if (!/^(flowchart|graph)\b/i.test(first)) {
    throw new Error(`Invalid Mermaid content: expected "flowchart" or "graph" directive as first line, got: "${first}"`);
  }

  const nodeMap = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  function registerNode(id: string, label?: string): void {
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, label: label ?? id });
    } else if (label !== undefined) {
      nodeMap.set(id, { ...(nodeMap.get(id) as MermaidNode), label });
    }
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "end" || line.startsWith("subgraph")) continue;

    let m: RegExpMatchArray | null;

    // -- text --> (most specific, checked first)
    m = line.match(TEXT_ARROW_RE);
    if (m) {
      const gs = toGroups(m);
      const from = extractNode(gs, 1);
      const to = extractNode(gs, 7);
      registerNode(from.id, from.label);
      registerNode(to.id, to.label);
      edges.push({ from: from.id, to: to.id, ...(gs[6] === undefined ? {} : { label: gs[6] }) });
      continue;
    }

    // -->|label|
    m = line.match(LABEL_ARROW_RE);
    if (m) {
      const gs = toGroups(m);
      const from = extractNode(gs, 1);
      const to = extractNode(gs, 7);
      registerNode(from.id, from.label);
      registerNode(to.id, to.label);
      edges.push({ from: from.id, to: to.id, ...(gs[6] === undefined ? {} : { label: gs[6] }) });
      continue;
    }

    // -->
    m = line.match(SIMPLE_ARROW_RE);
    if (m) {
      const gs = toGroups(m);
      const from = extractNode(gs, 1);
      const to = extractNode(gs, 6);
      registerNode(from.id, from.label);
      registerNode(to.id, to.label);
      edges.push({ from: from.id, to: to.id });
      continue;
    }

    // Standalone node definition
    m = line.match(NODE_DEF_RE);
    if (m) {
      const gs = toGroups(m);
      const node = extractNode(gs, 1);
      if (node.id) registerNode(node.id, node.label);
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges,
  };
}
