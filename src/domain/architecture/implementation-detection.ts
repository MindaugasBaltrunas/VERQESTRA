// Pure already-implemented detection domain module. No fs/path/process imports and no side
// effects — only the total functions that decide which implementation candidates an
// architecture node's label suggests, and the node-map config shape a project may provide
// to declare where a node is really implemented.
// Behaviour etalon: AG_loop domain/architecture/implementation-detection.ts.
//
// Imported architecture graphs often describe code that already exists. Be šio filtro wave
// variklis kiekvienam mazgui sintezuodavo run-tree taską, vykdytojo sesija atsakydavo
// ALREADY_IMPLEMENTED, ir loop'as degindavo pilnus ciklus nekeisdamas nė vienos kodo
// eilutės. Detekcija leidžia mazgą pažymėti "done" be tasko.

export type NodeImplementationMapEntry = {
  /** `true` — mazgas laikomas įgyvendintu besąlygiškai (elgsenos/invariantų mazgai be failų). */
  implemented?: boolean;
  /** Repo-relative keliai; mazgas įgyvendintas tik jei VISI egzistuoja. */
  paths?: string[];
  /** Laisvos formos pastaba operatoriui — detekcijai įtakos neturi. */
  note?: string;
};

export type NodeImplementationMap = {
  nodes: Record<string, NodeImplementationMapEntry>;
};

/** Basenames too generic to prove anything by themselves — auto-detection ignores them. */
const GENERIC_BASENAMES: ReadonlySet<string> = new Set([
  "index.ts",
  "index.js",
  "main.ts",
  "main.js",
  "types.ts",
  "app.ts",
]);

/**
 * Parses the node-map JSON, returning null on any shape violation instead of throwing —
 * a broken config must degrade to "no map", never crash the wave engine.
 */
export function parseNodeImplementationMap(raw: string): NodeImplementationMap | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const nodes = (data as { nodes?: unknown }).nodes;
  if (typeof nodes !== "object" || nodes === null || Array.isArray(nodes)) return null;

  const result: NodeImplementationMap = { nodes: {} };
  for (const [nodeId, value] of Object.entries(nodes as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Record<string, unknown>;
    if (entry["implemented"] !== undefined && typeof entry["implemented"] !== "boolean") return null;
    if (
      entry["paths"] !== undefined &&
      (!Array.isArray(entry["paths"]) || entry["paths"].some((p) => typeof p !== "string"))
    ) {
      return null;
    }
    result.nodes[nodeId] = {
      ...(entry["implemented"] !== undefined ? { implemented: entry["implemented"] } : {}),
      ...(entry["paths"] !== undefined ? { paths: entry["paths"] as string[] } : {}),
      ...(typeof entry["note"] === "string" ? { note: entry["note"] } : {}),
    };
  }
  return result;
}

/**
 * Filename tokens the label explicitly names (e.g. "pollLoop.ts<br/ poll, claim ...").
 * Generic basenames (index.ts, main.ts, ...) are dropped — a match on those proves nothing;
 * such nodes belong in the node-map instead.
 */
export function extractLabelFilenames(label: string): string[] {
  const matches = label.match(/[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:tsx?|[mc]?js|sql)\b/g) ?? [];
  const unique: string[] = [];
  for (const raw of matches) {
    const name = raw.trim();
    if (GENERIC_BASENAMES.has(name.toLowerCase())) continue;
    if (!unique.includes(name)) unique.push(name);
  }
  return unique;
}

/**
 * Kebab-case component names (billing-module, email-worker) and scoped package names
 * (@acme/database → database) the label mentions. The fs adapter resolves these against the
 * conventional roots (modules/, packages/, apps/, workers/).
 */
export function extractDirectoryCandidates(label: string): string[] {
  const unique: string[] = [];
  for (const match of label.match(/@[a-z0-9-]+\/[a-z0-9-]+/g) ?? []) {
    const name = match.split("/")[1];
    if (name !== undefined && !unique.includes(name)) unique.push(name);
  }
  for (const match of label.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) ?? []) {
    if (!unique.includes(match)) unique.push(match);
  }
  return unique;
}
