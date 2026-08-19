// Pure architecture-graph domain module — tik vertybiniai tipai ir label sanitizacija;
// jokių importų, IO ar side effects. Grafo SURINKIMAS iš šaltinio gyvena graph-import.ts —
// atskirai, kad tipų modulis neimportuotų klasifikavimo taisyklės, kuri pati importuoja
// šiuos tipus (acyclic gate). Behaviour etalon: AG_loop domain/architecture/graph.ts.
//
// WBR VQ-204 inversija: vietoj MermaidGraph importo iš parser'io (application sluoksnis, E3)
// čia apibrėžtas struktūrinis GraphSource tipas — parser'io rezultatas jį TENKINA, tad
// priklausomybės kryptis apsiverčia be jokio elgesio pokyčio.

/** Struktūrinis grafo šaltinio tipas — bet kuris parser'is (mermaid ar kitas) jį tenkina. */
export type GraphSource = {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
};

export type ArchitectureGraph = {
  source_path: string;
  imported_at: string;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
};

export type ArchitectureNode = {
  id: string;
  label: string;
  kind: "component" | "input" | "adapter" | "store" | "gate" | "report" | "unknown";
  status: "planned" | "ready" | "queued" | "active" | "repairing" | "done" | "human-review";
  description?: string;
  external?: boolean;
};

export type ArchitectureEdge = {
  from: string;
  to: string;
  label?: string;
  type: "depends_on" | "produces" | "consumes" | "validates" | "unknown";
};

export type ArchitectureProgress = {
  graph_hash: string;
  nodes: Record<string, ArchitectureNodeProgress>;
};

export type ArchitectureNodeProgress = {
  status: "planned" | "ready" | "queued" | "active" | "repairing" | "done" | "human-review";
  attempts: Record<string, number>;
  queued_tasks: string[];
  done_tasks: string[];
  implemented_files: string[];
  interface_contract?: NodeInterfaceContract;
  evidence_refs: string[];
  verified_at?: string;
  human_review_reason?: string;
};

export type NodeInterfaceContract = {
  inputs: string[];
  outputs: string[];
  upstream: string[];
  downstream: string[];
  public_exports: string[];
  checks: string[];
};

// Grafo label yra laisvas tekstas iš (galimai nepatikimo) šaltinio failo, o vėliau
// įterpiamas į auto-generuojamą task markdown'ą, kurį vykdo agentas. Sanitizuojam, kad
// label negalėtų injektuoti markdown sekcijų / instrukcijų (newlines, #, `, |, >) ir
// apribojam ilgį — apsauga nuo indirect prompt injection. (Pervadinta iš
// sanitizeMermaidLabel — taisyklė nepriklauso nuo šaltinio formato.)
export function sanitizeGraphLabel(label: string): string {
  return label
    .replace(/[\r\n]+/g, " ")
    .replace(/[`#>|*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
