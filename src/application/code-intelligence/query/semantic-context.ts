// Semantic symbol selection (task 1106, spec ag-loop-optimization-v1 "Repository
// intelligence" / "Execution context"). Behaviour etalon: AG_loop code-index/query.ts
// (semantinė pusė; WBR VQ-301 skaidymas — query.ts liko grafų užklausoms).
//
// Context packs used to describe a task's code neighbourhood with whole FILES only.
// That is broad: a worker editing one function received the file list and had to re-read
// everything to find the declaration. The AST indexer (code-index 2.0.0) records each
// symbol's line range, so the pack can name the concrete declarations instead — bounded,
// deterministic, and ranked by the graph evidence that made each symbol relevant.
//
// This module stays pure: it only reads an already-built CodeIndexData. Char/count
// budgeting beyond `maxSymbols` remains the caller's (policy layer) decision.

import type { CodeIndexData, CodeIndexSymbol } from "../indexing/types.js";
import { queryCodeGraphData, type CodeGraphQueryResult } from "./query.js";

/**
 * Why a symbol earned its place in the pack, highest priority first. The tiers combine
 * visibility (the `export` modifier) with reach (`references` / `reExports` edges), so a
 * declaration with live consumers always outranks one nothing depends on.
 *
 * - `exported` — exported AND referenced by another production file or re-exported
 *   through a barrel: a live public contract, the most expensive thing to break.
 * - `public` — exported with no recorded in-repo consumer: still public surface.
 * - `used` — not exported, yet referenced across files (index anomaly / non-TS source);
 *   ranked above test-only reach because production code depends on it.
 * - `tested` — reached only from test files.
 * - `declared` — internal declaration with no recorded cross-file reference.
 */
export const SYMBOL_SELECTION_PRIORITY = ["exported", "public", "used", "tested", "declared"] as const;

export type SymbolSelectionReason = (typeof SYMBOL_SELECTION_PRIORITY)[number];

/**
 * How a selected declaration relates to the task (task 0023).
 *
 * - `target` — declared in a file the task is allowed to edit; the worker will rewrite it,
 *   so it is worth the exact source.
 * - `contract` — declared elsewhere and referenced by one of those files: the public API
 *   the edited code calls and must keep calling correctly. Its declaration head is enough.
 *
 * The role never decides WHETHER a symbol is selected (graph evidence does, see
 * {@link SYMBOL_SELECTION_PRIORITY}); it decides how much of it a context compiler pays for.
 */
export const SYMBOL_CONTEXT_ROLES = ["target", "contract"] as const;

export type SymbolContextRole = (typeof SYMBOL_CONTEXT_ROLES)[number];

/** One concrete declaration selected for a context pack, with its source line range. */
export type ContextSymbol = {
  id: string;
  file: string;
  name: string;
  /** 1-based declaration start line; absent when the language has no AST indexer yet. */
  line?: number;
  /** 1-based declaration end line; absent together with `line`. */
  endLine?: number;
  /**
   * Compact declaration head from the index (code-index 2.1.0), when the language has a
   * signature-producing indexer. This is the cheap form of the declaration; the exact
   * source is read on demand from `file` + `line`/`endLine`.
   */
  signature?: string;
  exported: boolean;
  reason: SymbolSelectionReason;
  /** Relation to the task's edit targets; see {@link SYMBOL_CONTEXT_ROLES}. */
  role: SymbolContextRole;
};

export type SemanticContextLimits = {
  /** Hard upper bound on selected TARGET symbols across all targets. */
  maxSymbols: number;
  /**
   * Hard upper bound on CONTRACT symbols — declarations the edited files reference but do
   * not own. `0` (the default) selects target symbols only, which is the pre-0023
   * behaviour every caller that does not opt in keeps.
   */
  maxContractSymbols?: number;
};

export type SemanticCodeContext = {
  targets: string[];
  /**
   * Priority-ranked and deduplicated: target symbols first (bounded by `maxSymbols`),
   * then contract symbols (bounded by `maxContractSymbols`).
   */
  symbols: ContextSymbol[];
  /** Raw graph neighbourhood — NOT truncated here (the policy layer budgets it). */
  related_files: string[];
  /** Raw impacted tests — already restricted to .ts/.tsx by queryCodeGraphData. */
  impacted_tests: string[];
  /** Human-readable symbol summary, one `target:`/`symbols:` pair per matched target. */
  summary: string[];
  notes: string[];
};

/**
 * Select the concrete symbols a task's targets consist of, plus the unbounded graph
 * neighbourhood the caller still needs for contracts and impacted tests.
 *
 * Deterministic: candidates are ranked by (reason priority, symbol id) and interleaved
 * round-robin across targets, so every target contributes before any target contributes a
 * second symbol, and the same index + targets always yield the same selection.
 */
export function selectSemanticCodeContext(
  data: CodeIndexData,
  targets: string[],
  limits: SemanticContextLimits,
): SemanticCodeContext {
  // `maxSymbols: 0` asks for the file-level view only (related_files + impacted_tests,
  // no symbol detail): skip symbol ranking entirely rather than ranking symbols that
  // could never be kept.
  const wantsSymbols = limits.maxSymbols > 0;
  const contractLimit = Math.max(0, limits.maxContractSymbols ?? 0);
  const evidence = wantsSymbols ? collectSymbolEvidence(data) : undefined;
  const perTarget: { target: string; ranked: ContextSymbol[] }[] = [];
  const relatedFiles = new Set<string>();
  const impactedTests = new Set<string>();
  const targetFiles = new Set<string>();
  const notes: string[] = [];

  for (const target of targets) {
    const result = queryCodeGraphData(data, target);
    for (const file of result.related_files) relatedFiles.add(file);
    for (const test of result.impacted_tests) impactedTests.add(test);
    for (const file of result.matched_files) targetFiles.add(file.path);
    if (result.related_files.length === 0) {
      notes.push(`no graph match for ${target}`);
    }
    if (!evidence) {
      continue;
    }

    const ranked = rankSymbols(collectTargetSymbols(data, result), evidence, "target");
    if (ranked.length > 0) {
      perTarget.push({ target, ranked });
    } else if (result.related_files.length > 0) {
      notes.push(`no indexed symbols for ${target}`);
    }
  }

  const symbols = wantsSymbols ? interleave(perTarget.map((entry) => entry.ranked), limits.maxSymbols) : [];
  // Contracts are selected AFTER the targets and from a separate bucket, so a rich
  // dependency surface can never displace a declaration the task actually edits.
  const contracts =
    evidence && contractLimit > 0
      ? rankSymbols(collectContractSymbols(data, targetFiles), evidence, "contract").slice(0, contractLimit)
      : [];

  return {
    targets,
    symbols: [...symbols, ...contracts],
    related_files: Array.from(relatedFiles).sort(),
    impacted_tests: Array.from(impactedTests).sort(),
    summary: summarizeSelection(perTarget, symbols, contracts),
    notes,
  };
}

/**
 * Describe exactly the symbols that were kept — never the full ranked candidate list.
 * The summary lands in the context pack's fixed, non-droppable overhead, so describing
 * every declaration of a symbol-rich target would let one file emit an unbounded line and
 * squeeze out the spec fragments the pack budgets around. Each kept symbol is described
 * once, under the first target that declares it, matching the deduplication `interleave`
 * already applied.
 *
 * Contract symbols have no owning target, so they are described once, at the end, under a
 * `contracts:` line. The line is absent unless contract selection was asked for, which is
 * what keeps a pack assembled without it byte-identical to the pre-0023 one.
 */
function summarizeSelection(
  perTarget: { target: string; ranked: ContextSymbol[] }[],
  selected: ContextSymbol[],
  contracts: ContextSymbol[] = [],
): string[] {
  const pending = new Set(selected.map((symbol) => symbol.id));
  const lines: string[] = [];
  for (const { target, ranked } of perTarget) {
    const kept = ranked.filter((symbol) => pending.delete(symbol.id));
    if (kept.length > 0) {
      lines.push(`target: ${target}`, `symbols: ${kept.map(describeSymbol).join(", ")}`);
    }
  }
  if (contracts.length > 0) {
    lines.push(`contracts: ${contracts.map(describeSymbol).join(", ")}`);
  }
  return lines;
}

/**
 * `FileName.symbolName:line-endLine` — the compact worker-facing symbol reference. The
 * range is omitted when the index carries no line information for that symbol.
 */
export function formatSymbolFragment(symbol: ContextSymbol): string {
  const base = symbol.file.split("/").pop() ?? symbol.file;
  const name = base.replace(/\.[^.]+$/, "");
  const range = symbol.line === undefined ? "" : `:${symbol.line}-${symbol.endLine ?? symbol.line}`;
  return `${name}.${symbol.name}${range}`;
}

function describeSymbol(symbol: ContextSymbol): string {
  return `${formatSymbolFragment(symbol)} (${symbol.reason})`;
}

type SymbolEvidence = {
  reExported: Set<string>;
  usedBy: Set<string>;
  testedBy: Set<string>;
};

// Cross-file usage evidence, keyed by symbol id (`path/to/file.ts#name`). `references`
// edges are emitted by the AST indexer for every imported binding that is actually read;
// star `reExports` edges point at a file (not a symbol id) and simply never match here.
function collectSymbolEvidence(data: CodeIndexData): SymbolEvidence {
  const testFiles = new Set(data.files.filter((file) => file.isTest).map((file) => file.path));
  const evidence: SymbolEvidence = { reExported: new Set(), usedBy: new Set(), testedBy: new Set() };
  for (const edge of data.edges) {
    if (edge.type === "reExports") {
      evidence.reExported.add(edge.to);
    } else if (edge.type === "references") {
      (testFiles.has(edge.from) ? evidence.testedBy : evidence.usedBy).add(edge.to);
    }
  }
  return evidence;
}

// Symbols of the target: everything declared in a matched file, plus symbols the target
// named directly (a `file.ts#symbol` or bare symbol-name query).
function collectTargetSymbols(data: CodeIndexData, result: CodeGraphQueryResult): CodeIndexSymbol[] {
  const matchedFiles = new Set(result.matched_files.map((file) => file.path));
  const byId = new Map<string, CodeIndexSymbol>();
  for (const symbol of data.symbols) {
    if (matchedFiles.has(symbol.file)) {
      byId.set(symbol.id, symbol);
    }
  }
  for (const symbol of result.matched_symbols) {
    byId.set(symbol.id, symbol);
  }
  return Array.from(byId.values());
}

/**
 * Declarations the edited files CALL but do not own (task 0023).
 *
 * The evidence is the AST indexer's `references` edge (file -> symbol id), so this is not
 * "everything the imported modules export": it is exactly the exported declarations the
 * target files actually read. Symbols declared inside a target file are excluded — those
 * are target symbols, selected above with their own budget.
 */
function collectContractSymbols(data: CodeIndexData, targetFiles: Set<string>): CodeIndexSymbol[] {
  const referenced = new Set<string>();
  for (const edge of data.edges) {
    if (edge.type === "references" && targetFiles.has(edge.from)) {
      referenced.add(edge.to);
    }
  }
  return data.symbols.filter(
    (symbol) => symbol.exported && referenced.has(symbol.id) && !targetFiles.has(symbol.file),
  );
}

function rankSymbols(symbols: CodeIndexSymbol[], evidence: SymbolEvidence, role: SymbolContextRole): ContextSymbol[] {
  return symbols
    .map((symbol) => ({
      id: symbol.id,
      file: symbol.file,
      name: symbol.name,
      ...(symbol.line === undefined ? {} : { line: symbol.line }),
      ...(symbol.endLine === undefined ? {} : { endLine: symbol.endLine }),
      ...(symbol.signature === undefined ? {} : { signature: symbol.signature }),
      exported: symbol.exported,
      reason: selectionReason(symbol, evidence),
      role,
    }))
    .sort((left, right) => {
      const byReason = SYMBOL_SELECTION_PRIORITY.indexOf(left.reason) - SYMBOL_SELECTION_PRIORITY.indexOf(right.reason);
      return byReason !== 0 ? byReason : left.id.localeCompare(right.id);
    });
}

function selectionReason(symbol: CodeIndexSymbol, evidence: SymbolEvidence): SymbolSelectionReason {
  const reachedByProduction = evidence.usedBy.has(symbol.id) || evidence.reExported.has(symbol.id);
  if (reachedByProduction) {
    return symbol.exported ? "exported" : "used";
  }
  if (evidence.testedBy.has(symbol.id)) {
    return "tested";
  }
  return symbol.exported ? "public" : "declared";
}

// Round-robin across targets so a single symbol-rich file cannot consume the whole budget
// and leave a co-edited file unrepresented.
function interleave(groups: ContextSymbol[][], limit: number): ContextSymbol[] {
  const selected: ContextSymbol[] = [];
  const seen = new Set<string>();
  const depth = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < depth && selected.length < limit; index += 1) {
    for (const group of groups) {
      const symbol = group[index];
      if (!symbol || seen.has(symbol.id) || selected.length >= limit) {
        continue;
      }
      seen.add(symbol.id);
      selected.push(symbol);
    }
  }
  return selected;
}
