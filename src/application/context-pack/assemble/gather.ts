// Code-context kandidatų surinkimas context pack'ui: semantinė simbolių atranka, source
// slice'ai, architektūros mazgų atitikimas. Behaviour etalon: AG_loop application/
// context-pack/assemble.ts (gather pusė; WBR VQ-302 skaidymas). Renka TIK žalius
// kandidatus (task 921) — truncation sprendžia vienas selectGraphFirstContext kvietimas.

import path from "node:path";
import type { CodeIntelligenceFileSystemPort } from "../../code-intelligence/ports.js";
import { ensureFreshCodeIndexForExistingCodeTask } from "../../code-intelligence/query/guard.js";
import { checkCodeIndexFreshness, readCodeIndex } from "../../code-intelligence/store/code-index-store.js";
import { selectSemanticCodeContext, type ContextSymbol } from "../../code-intelligence/query/semantic-context.js";
import type { ContextSelectionLimits } from "../../policy-governance/context-selection-policy.js";
import type { ContextPackSymbolTier } from "../context-pack-schema.js";
import { createSourceSliceReader, type SourceSlice } from "../source-slice.js";
import type { ContextPackFileSystemPort } from "../ports.js";

// A selected symbol as the pack carries it (task 0023): the graph selection plus, when the
// `symbol_slices` compression feature is on, its detail tier and — for SRC — the exact
// hash-verified source slice. Both extras are absent with the feature off, which is what
// keeps a flag-off pack byte-identical to the pre-0023 one.
export type TieredContextSymbol = ContextSymbol & {
  tier?: ContextPackSymbolTier;
  source?: { text: string; hash: string; line: number; endLine: number };
};

export type CodeContext = {
  enabled: boolean;
  related_files: string[];
  impacted_tests: string[];
  architecture_nodes: string[];
  priority_order: string[];
  summary: string[];
  notes: string[];
  // Concrete declarations (with line ranges) the task edits — the semantic replacement
  // for "here is the whole file, find it yourself" (task 1106).
  symbol_fragments: TieredContextSymbol[];
};

// Raw, not-yet-truncated code-graph candidates. Deliberately holds no priority selection
// of its own — truncation is decided once, centrally (task 921).
export type CodeContextCandidates = {
  enabled: boolean;
  architectureNodes: string[];
  codeGraphNeighbors: string[];
  impactedTests: string[];
  summary: string[];
  notes: string[];
  // Already bounded when gathered (max_related_files symbols, ranked). Unlike the file/test
  // buckets these do not compete in selectGraphFirstContext: they are the highest-value
  // context and are accounted for as fixed overhead in `reservedChars`.
  symbolFragments: TieredContextSymbol[];
  // Exact source slices of the TARGET symbols, keyed by symbol id (task 0023). Read only
  // when the `symbol_slices` feature is on; whether a slice is actually spent on a symbol
  // is decided later, by selectCodeContextTiers, against the measured pack overhead.
  sourceSlices?: Map<string, SourceSlice>;
  // True when the code index was stale/missing and was deterministically rebuilt before
  // this context was gathered — "degraded mode must be visible" (task 975).
  rebuilt: boolean;
};

// What the code-context gathering is allowed to spend beyond the graph selection itself
// (task 0023). Both fields are driven by the `symbol_slices` compression feature: with it
// off, contract selection is 0 and no slice is ever read.
export type CodeContextGatherOptions = {
  maxContractSymbols: number;
  readSourceSlices: boolean;
};

// Production auto-wiring (task 861, hardened by task 975): unlike the explicit
// --with-code-graph flag path (gatherCodeContextCandidates), the production dispatch path
// never passes that flag but must not silently drop code graph context for existing-code
// tasks just because the index is stale or missing. A blocked rebuild propagates as a
// thrown error so the caller routes the task to human review instead of masquerading a
// degraded pack as graph-aware. New-file tasks (no existing target) still skip entirely.
export async function autoGatherCodeContextCandidates(
  codeFs: CodeIntelligenceFileSystemPort,
  fs: ContextPackFileSystemPort,
  projectRoot: string,
  targets: string[],
  limits: ContextSelectionLimits,
  options: CodeContextGatherOptions,
): Promise<CodeContextCandidates | undefined> {
  const readiness = await ensureFreshCodeIndexForExistingCodeTask(codeFs, projectRoot, targets);
  if (readiness.kind === "skip") {
    return undefined;
  }
  if (readiness.kind === "blocked") {
    throw new Error(`code graph context requires a fresh code index: ${readiness.reason}. Run the code-index build.`);
  }

  const context = await gatherFreshCodeContext(
    codeFs,
    fs,
    projectRoot,
    readiness.existingTargets,
    limits,
    readiness.kind === "rebuilt",
    options,
  );
  if (readiness.kind === "rebuilt") {
    return {
      ...context,
      notes: ["code index was stale and was deterministically rebuilt before dispatch", ...context.notes],
    };
  }
  return context;
}

export async function gatherCodeContextCandidates(
  codeFs: CodeIntelligenceFileSystemPort,
  fs: ContextPackFileSystemPort,
  projectRoot: string,
  targets: string[],
  limits: ContextSelectionLimits,
  options: CodeContextGatherOptions,
): Promise<CodeContextCandidates> {
  const freshness = await checkCodeIndexFreshness(codeFs, projectRoot);
  if (!freshness.ok) {
    throw new Error(`code graph context requires a fresh code index: ${freshness.reason}. Run the code-index build.`);
  }

  return await gatherFreshCodeContext(codeFs, fs, projectRoot, targets, limits, false, options);
}

async function gatherFreshCodeContext(
  codeFs: CodeIntelligenceFileSystemPort,
  fs: ContextPackFileSystemPort,
  projectRoot: string,
  targets: string[],
  limits: ContextSelectionLimits,
  rebuilt: boolean,
  options: CodeContextGatherOptions,
): Promise<CodeContextCandidates> {
  if (targets.length === 0) {
    // Graph-first: with no explicit targets there is no graph node to expand from, and
    // we deliberately do NOT fall back to scanning directories.
    return {
      enabled: true,
      architectureNodes: [],
      codeGraphNeighbors: [],
      impactedTests: [],
      summary: [],
      notes: ["code graph context requested, but task has no explicit allowed file targets"],
      symbolFragments: [],
      rebuilt,
    };
  }

  // Semantic, symbol-level selection (task 1106): one traversal yields the concrete
  // declarations of the edited files, their direct contracts and the tests that cover them.
  const data = await readCodeIndex(codeFs, projectRoot);
  const semantic = selectSemanticCodeContext(data, targets, {
    maxSymbols: limits.max_related_files,
    ...(options.maxContractSymbols > 0 ? { maxContractSymbols: options.maxContractSymbols } : {}),
  });
  const architectureNodes = await matchArchitectureNodes(fs, projectRoot, targets);

  // Exact source of the TARGET symbols (task 0023), hash-verified against the index the
  // selection above came from. `missing_range` is the normal case for symbols without AST
  // ranges and stays silent; every other failure is worth a note.
  let sourceSlices: Map<string, SourceSlice> | undefined;
  const sliceNotes: string[] = [];
  if (options.readSourceSlices) {
    sourceSlices = new Map();
    const reader = createSourceSliceReader(fs, projectRoot, data);
    for (const symbol of semantic.symbols) {
      if (symbol.role !== "target") {
        continue;
      }
      const slice = await reader.readSymbol(symbol);
      if (slice.ok) {
        sourceSlices.set(symbol.id, slice.value);
      } else if (slice.error.code !== "missing_range") {
        // Simbolio id ateina iš kodo indekso, t. y. iš repozitorijos. Pastaba yra MŪSŲ tekstas
        // (`trusted`), tad į jį įdėta svetima dalis renderinama backtick'uose — struktūrizuota,
        // o ne laisva.
        sliceNotes.push(`source slice unavailable for \`${symbol.id}\`: ${slice.error.code}`);
      }
    }
  }

  return {
    enabled: true,
    architectureNodes,
    codeGraphNeighbors: semantic.related_files,
    impactedTests: semantic.impacted_tests,
    summary: semantic.summary.slice(0, limits.max_related_files * 2),
    notes: [
      "code_context is advisory only; allowed_paths remains the hard edit boundary",
      ...semantic.notes.slice(0, limits.max_related_files),
      ...sliceNotes,
    ],
    symbolFragments: semantic.symbols,
    ...(sourceSlices ? { sourceSlices } : {}),
    rebuilt,
  };
}

// Best-effort architecture-graph node match: surface the labels of nodes whose id or
// label token appears in one of the explicit targets. The graph is advisory context,
// so a missing/unreadable graph simply yields no architecture nodes.
async function matchArchitectureNodes(
  fs: ContextPackFileSystemPort,
  projectRoot: string,
  targets: string[],
): Promise<string[]> {
  const graph = await readArchitectureGraph(fs, projectRoot);
  if (!graph) {
    return [];
  }
  const haystack = targets.join("\n").toLowerCase();
  const matched: string[] = [];
  for (const node of graph.nodes) {
    const idToken = node.id.toLowerCase();
    const labelToken = node.label.toLowerCase();
    if ((idToken && haystack.includes(idToken)) || (labelToken && haystack.includes(labelToken))) {
      matched.push(node.label || node.id);
    }
  }
  return matched;
}

async function readArchitectureGraph(
  fs: ContextPackFileSystemPort,
  projectRoot: string,
): Promise<{ nodes: Array<{ id: string; label: string }> } | null> {
  try {
    const raw = await fs.readTextFileIfExists(path.join(projectRoot, "vq", "state", "architecture", "graph.json"));
    if (raw === undefined) return null;
    const parsed = JSON.parse(raw) as { nodes?: Array<{ id?: unknown; label?: unknown }> };
    if (!Array.isArray(parsed.nodes)) return null;
    return {
      nodes: parsed.nodes
        .filter((node) => typeof node.id === "string")
        .map((node) => ({ id: node.id as string, label: typeof node.label === "string" ? node.label : "" })),
    };
  } catch {
    return null;
  }
}
