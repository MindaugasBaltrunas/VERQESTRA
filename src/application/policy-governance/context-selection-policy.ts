// Graph-first context selection policy (task 863). Behaviour etalon: AG_loop
// policy/context-selection-policy.ts (1:1; loader — per portą, kelias — vq/config).
//
// This module is a *pure* policy layer decision: given already-gathered candidate context
// (spec refs, architecture graph nodes, allowed file targets, code-graph neighbours,
// impacted tests, short doc snippets) it produces a deterministic, bounded selection. It
// never scans directories, reads product source or calls an LLM.

import path from "node:path";
import type { PolicyConfigFileSystemPort } from "./ports.js";

// Deterministic priority order. Higher-priority sources are honoured first when the
// char budget is tight; lower-priority sources are dropped before higher ones.
export const CONTEXT_PRIORITY_ORDER = [
  "spec_refs",
  "architecture_nodes",
  "allowed_paths",
  "code_graph_neighbors",
  "impacted_tests",
  "docs_snippets",
] as const;

export type ContextSource = (typeof CONTEXT_PRIORITY_ORDER)[number];

// Per-source count limits. max_context_chars is the global secondary bound applied
// across the whole selection after the per-bucket caps.
export type ContextSelectionLimits = {
  max_related_files: number;
  max_tests: number;
  max_spec_fragments: number;
  max_context_chars: number;
  /** Upper bound on SIG-tier contract declarations (task 0023). */
  max_contract_symbols: number;
  /** Total char budget the SRC tier may claim across all symbols (task 0023). */
  max_symbol_source_chars: number;
  /** Per-symbol ceiling for one exact source slice; a bigger declaration falls back to SIG. */
  max_symbol_slice_chars: number;
  /** Per-symbol ceiling for one declaration signature; a bigger one falls back to REF. */
  max_symbol_signature_chars: number;
  /**
   * Total char budget the SIG tier may claim across CONTRACT symbols (task 0006). Be jo
   * `max_contract_symbols` deklaracijos galėtų kiekviena išleisti po
   * `max_symbol_signature_chars` nedroppinamame overhead'e (2026-08-12 perpildymas).
   * Optional so limits objects built before the field existed still type-check; absent
   * means {@link DEFAULT_MAX_CONTRACT_SYMBOL_CHARS}. Every loader-produced object carries it.
   */
  max_contract_symbol_chars?: number;
};

/** Fallback for {@link ContextSelectionLimits.max_contract_symbol_chars} when it is absent. */
export const DEFAULT_MAX_CONTRACT_SYMBOL_CHARS = 1200;

export const DEFAULT_CONTEXT_SELECTION_LIMITS: ContextSelectionLimits = {
  max_related_files: 8,
  max_tests: 4,
  max_spec_fragments: 8,
  max_context_chars: 12000,
  max_contract_symbols: 6,
  max_symbol_source_chars: 3000,
  max_symbol_slice_chars: 1200,
  max_symbol_signature_chars: 240,
  max_contract_symbol_chars: DEFAULT_MAX_CONTRACT_SYMBOL_CHARS,
};

/**
 * Clamp the policy's own char ceiling to the budget the assembled pack is enforced against.
 *
 * `max_context_chars` reaches a context pack from two independent places: the per-task
 * budget (which the token optimizer shrinks for small/medium tasks) and the static policy
 * ceiling. Every budget decision in this module must see the SMALLER of the two —
 * budgeting against the static ceiling while the assembler enforces the per-task one is
 * what let the reserved overhead alone exceed the limit on 2026-08-12.
 */
export function effectiveContextSelectionLimits(
  limits: ContextSelectionLimits,
  maxContextChars: number,
): ContextSelectionLimits {
  return {
    ...limits,
    max_context_chars: Math.max(0, Math.min(limits.max_context_chars, maxContextChars)),
  };
}

// Candidate context for a single task. Every field is a plain list of short strings
// (refs, node labels, repo-relative paths); the policy does not fetch file bodies.
export type GraphFirstContextCandidates = {
  specRefs: string[];
  architectureNodes: string[];
  allowedPaths: string[];
  codeGraphNeighbors: string[];
  impactedTests: string[];
  docsSnippets: string[];
};

export type GraphFirstSelection = {
  spec_refs: string[];
  architecture_nodes: string[];
  allowed_paths: string[];
  related_files: string[];
  impacted_tests: string[];
  docs_snippets: string[];
  // Sources that contributed at least one item, in priority order — a compact,
  // deterministic proof of what the pack was built from.
  order: ContextSource[];
  // "<source>:<item>" entries excluded because the char budget was exhausted.
  dropped: string[];
  estimated_chars: number;
};

// Rough per-item serialization overhead (quotes, comma, indentation) used only for
// the proactive char budget; the assembler still enforces the exact JSON size.
const CONTEXT_ITEM_OVERHEAD = 8;

/**
 * Deterministically select a small, graph-first, policy-bounded context set.
 *
 * `reservedChars` is the fixed, non-droppable overhead the caller has already committed
 * to the same budget; it is subtracted from `max_context_chars` up front (task 977).
 */
export function selectGraphFirstContext(
  candidates: GraphFirstContextCandidates,
  limits: ContextSelectionLimits,
  reservedChars = 0,
): GraphFirstSelection {
  const buckets: Record<ContextSource, string[]> = {
    // Spec refs and allowed paths keep caller order (they are already prioritized);
    // graph-derived buckets are sorted for stable, deterministic truncation.
    spec_refs: capList(dedupeStable(candidates.specRefs), limits.max_spec_fragments),
    architecture_nodes: capList(sortDedupe(candidates.architectureNodes), limits.max_related_files),
    allowed_paths: dedupeStable(candidates.allowedPaths),
    code_graph_neighbors: capList(sortDedupe(candidates.codeGraphNeighbors), limits.max_related_files),
    impacted_tests: capList(sortDedupe(candidates.impactedTests), limits.max_tests),
    docs_snippets: capList(dedupeStable(candidates.docsSnippets), limits.max_spec_fragments),
  };

  // The droppable context sources compete for whatever the fixed overhead leaves behind.
  const effectiveBudget = Math.max(0, limits.max_context_chars - Math.max(0, reservedChars));

  const seen = new Set<string>();
  const dropped: string[] = [];
  const order: ContextSource[] = [];
  let usedChars = 0;
  let budgetExhausted = false;

  for (const source of CONTEXT_PRIORITY_ORDER) {
    const kept: string[] = [];
    for (const item of buckets[source]) {
      if (seen.has(item)) {
        // Already counted under a higher-priority source; free to keep.
        kept.push(item);
        continue;
      }
      const cost = item.length + CONTEXT_ITEM_OVERHEAD;
      if (budgetExhausted || usedChars + cost > effectiveBudget) {
        budgetExhausted = true;
        dropped.push(`${source}:${item}`);
        continue;
      }
      usedChars += cost;
      seen.add(item);
      kept.push(item);
    }
    buckets[source] = kept;
    if (kept.length > 0) {
      order.push(source);
    }
  }

  return {
    spec_refs: buckets.spec_refs,
    architecture_nodes: buckets.architecture_nodes,
    allowed_paths: buckets.allowed_paths,
    related_files: buckets.code_graph_neighbors,
    impacted_tests: buckets.impacted_tests,
    docs_snippets: buckets.docs_snippets,
    order,
    dropped,
    estimated_chars: usedChars,
  };
}

// ---------------------------------------------------------------------------
// Code-context tiers (task 0023): REF — symbol, file, line range; SIG — compact
// declaration head; SRC — exact hash-verified source (tik EDIT taikiniai). Tier
// sprendimas gyvena čia, nes jis YRA biudžeto sprendimas.
// ---------------------------------------------------------------------------

/** Detail levels, cheapest first. */
export const CODE_CONTEXT_TIERS = ["REF", "SIG", "SRC"] as const;

export type CodeContextTier = (typeof CODE_CONTEXT_TIERS)[number];

/**
 * One already-selected symbol, measured. Sizes are `0` when that form is unavailable —
 * no signature in the index, or no exact slice could be read.
 */
export type SymbolTierCandidate = {
  id: string;
  role: "target" | "contract";
  signatureChars: number;
  sourceChars: number;
};

export type SymbolTierAssignment = {
  id: string;
  tier: CodeContextTier;
};

export type SymbolTierSelection = {
  /** One assignment per candidate, in candidate order. */
  assignments: SymbolTierAssignment[];
  /** Chars claimed by the SRC tier — the amount the caller must reserve from the budget. */
  source_chars: number;
  /** `<id>: SRC -> SIG (<why>)` notes for symbols that could not get the tier of their role. */
  downgraded: string[];
};

/**
 * How much of the context budget the SRC tier may claim at most. The remainder always stays
 * available to the droppable sources, so one large declaration can never be the reason a
 * task ships without its spec.
 */
export const CODE_CONTEXT_DROPPABLE_FLOOR_SHARE = 0.25;

/**
 * What the code-context tiers may spend in total: the budget minus the fixed pack overhead
 * and the droppable-source floor. `0` when nothing is left.
 */
function codeContextTierBudget(limits: ContextSelectionLimits, reservedChars: number): number {
  const floor = Math.floor(limits.max_context_chars * CODE_CONTEXT_DROPPABLE_FLOOR_SHARE);
  return Math.max(0, limits.max_context_chars - Math.max(0, reservedChars) - floor);
}

/**
 * The SRC char budget for one pack: the configured cap, further reduced by whatever the
 * fixed pack overhead and the droppable-source floor already claim.
 */
export function symbolSourceBudget(limits: ContextSelectionLimits, reservedChars: number): number {
  return Math.min(limits.max_symbol_source_chars, codeContextTierBudget(limits, reservedChars));
}

/**
 * The SIG char budget contract symbols share, out of the same remainder: whatever the SRC
 * tier may claim is subtracted first, so the two code-context budgets can never jointly
 * exceed what the pack has left.
 */
export function contractSignatureBudget(limits: ContextSelectionLimits, reservedChars: number): number {
  const cap = limits.max_contract_symbol_chars ?? DEFAULT_MAX_CONTRACT_SYMBOL_CHARS;
  const remainder = codeContextTierBudget(limits, reservedChars) - symbolSourceBudget(limits, reservedChars);
  return Math.max(0, Math.min(cap, remainder));
}

/**
 * Assign a detail tier to every selected symbol, deterministically and within one budget.
 *
 * Candidates are consumed in the caller's ranking order (graph evidence first). Nothing is
 * ever truncated: a declaration that does not fit whole is served as SIG or REF, because
 * half a function body in a prompt is worse than an honest reference to it.
 */
export function selectCodeContextTiers(
  candidates: SymbolTierCandidate[],
  limits: Pick<ContextSelectionLimits, "max_symbol_slice_chars" | "max_symbol_signature_chars"> & {
    sourceBudgetChars: number;
    /**
     * Shared SIG budget for CONTRACT symbols (see {@link contractSignatureBudget}). Omitted
     * means unbounded, the pre-0006 behaviour kept for callers that only budget SRC.
     */
    contractSignatureBudgetChars?: number;
  },
): SymbolTierSelection {
  const assignments: SymbolTierAssignment[] = [];
  const downgraded: string[] = [];
  const contractSignatureBudgetChars = limits.contractSignatureBudgetChars ?? Number.POSITIVE_INFINITY;
  let usedChars = 0;
  let usedSignatureChars = 0;

  for (const candidate of candidates) {
    let signature = candidate.signatureChars > 0 && candidate.signatureChars <= limits.max_symbol_signature_chars;
    if (candidate.role === "target" && candidate.sourceChars > 0) {
      if (candidate.sourceChars > limits.max_symbol_slice_chars) {
        downgraded.push(
          `${candidate.id}: SRC -> ${signature ? "SIG" : "REF"} (${candidate.sourceChars} chars over the ${limits.max_symbol_slice_chars} per-symbol slice limit)`,
        );
      } else if (usedChars + candidate.sourceChars > limits.sourceBudgetChars) {
        downgraded.push(
          `${candidate.id}: SRC -> ${signature ? "SIG" : "REF"} (source budget ${limits.sourceBudgetChars} chars exhausted)`,
        );
      } else {
        usedChars += candidate.sourceChars;
        assignments.push({ id: candidate.id, tier: "SRC" });
        continue;
      }
    }
    // Contract signatures compete for one shared budget, in ranking order: the declarations
    // the task calls most directly keep their SIG form, the rest degrade to a reference.
    if (signature && candidate.role === "contract") {
      if (usedSignatureChars + candidate.signatureChars > contractSignatureBudgetChars) {
        downgraded.push(
          `${candidate.id}: SIG -> REF (contract signature budget ${contractSignatureBudgetChars} chars exhausted)`,
        );
        signature = false;
      } else {
        usedSignatureChars += candidate.signatureChars;
      }
    }
    assignments.push({ id: candidate.id, tier: signature ? "SIG" : "REF" });
  }

  return { assignments, source_chars: usedChars, downgraded };
}

// ---------------------------------------------------------------------------
// Overflow ladder (task 0006)
// ---------------------------------------------------------------------------

/** What a symbol currently carries in the pack, as input to {@link planCodeContextReductions}. */
export type CodeContextSymbolState = {
  id: string;
  role: "target" | "contract";
  tier: CodeContextTier;
  /** Whether the symbol has a signature to fall back to when its SRC slice is shed. */
  hasSignature: boolean;
};

/** One rung of the overflow ladder: the CUMULATIVE code-context state after shedding. */
export type CodeContextReduction = {
  /** Surviving symbols in candidate order, with the tier this rung leaves them at. */
  symbols: SymbolTierAssignment[];
  /** Ids shed entirely up to and including this rung, in the order they were shed. */
  dropped: string[];
  /** One char-cheap note describing everything shed so far, for the pack's own notes. */
  note: string;
};

/**
 * The deterministic ladder the assembler walks when a pack still exceeds its char limit
 * after every droppable source is gone (task 0006). Each rung sheds the least valuable
 * payload still present: 1) SRC -> SIG/REF (lowest graph rank first); 2) SIG -> REF;
 * 3) contract symbols dropped entirely. The caller re-measures after each rung and stops
 * at the first pack that fits. Pure and order-stable; each rung is a complete state, so
 * applying it is idempotent.
 */
export function planCodeContextReductions(symbols: readonly CodeContextSymbolState[]): CodeContextReduction[] {
  const state = symbols.map((symbol) => ({ ...symbol, dropped: false }));
  const rungs: CodeContextReduction[] = [];
  // Counts SYMBOLS, not steps: one symbol walking SRC -> SIG -> REF is one demoted symbol.
  const demotedIds = new Set<string>();
  const droppedIds: string[] = [];

  const emit = (): void => {
    rungs.push({
      symbols: state.filter((symbol) => !symbol.dropped).map((symbol) => ({ id: symbol.id, tier: symbol.tier })),
      dropped: [...droppedIds],
      note:
        `code context reduced to fit max_context_chars: ${demotedIds.size} symbol(s) demoted, ` +
        `${droppedIds.length} contract symbol(s) dropped`,
    });
  };

  // Lowest graph rank first = last candidate first: the caller ranks by graph evidence and
  // appends contracts after targets, so reverse order is exactly "least valuable first".
  for (const from of ["SRC", "SIG"] as const) {
    for (let index = state.length - 1; index >= 0; index -= 1) {
      const symbol = state[index];
      if (!symbol || symbol.tier !== from) {
        continue;
      }
      // A shed slice falls back to the signature when there is one; the SIG pass then takes
      // that away too if the pack is still over the limit.
      symbol.tier = from === "SRC" && symbol.hasSignature ? "SIG" : "REF";
      demotedIds.add(symbol.id);
      emit();
    }
  }

  for (let index = state.length - 1; index >= 0; index -= 1) {
    const symbol = state[index];
    if (!symbol || symbol.dropped || symbol.role !== "contract") {
      continue;
    }
    symbol.dropped = true;
    droppedIds.push(symbol.id);
    emit();
  }

  return rungs;
}

/**
 * Load the graph-first selection limits from the config file.
 *
 * Shared keys (max_spec_fragments, max_context_chars) default to the already-loaded
 * context budget; the graph-specific keys default to DEFAULT_CONTEXT_SELECTION_LIMITS.
 * Missing/empty file → derived defaults. Invalid JSON or a non-positive-integer value
 * → fail-fast.
 */
export async function loadContextSelectionPolicy(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
  budgetDefaults: { max_spec_fragments?: number; max_context_chars?: number } = {},
): Promise<ContextSelectionLimits> {
  const defaults: ContextSelectionLimits = {
    max_related_files: DEFAULT_CONTEXT_SELECTION_LIMITS.max_related_files,
    max_tests: DEFAULT_CONTEXT_SELECTION_LIMITS.max_tests,
    max_spec_fragments: budgetDefaults.max_spec_fragments ?? DEFAULT_CONTEXT_SELECTION_LIMITS.max_spec_fragments,
    max_context_chars: budgetDefaults.max_context_chars ?? DEFAULT_CONTEXT_SELECTION_LIMITS.max_context_chars,
    max_contract_symbols: DEFAULT_CONTEXT_SELECTION_LIMITS.max_contract_symbols,
    max_symbol_source_chars: DEFAULT_CONTEXT_SELECTION_LIMITS.max_symbol_source_chars,
    max_symbol_slice_chars: DEFAULT_CONTEXT_SELECTION_LIMITS.max_symbol_slice_chars,
    max_symbol_signature_chars: DEFAULT_CONTEXT_SELECTION_LIMITS.max_symbol_signature_chars,
    max_contract_symbol_chars: DEFAULT_MAX_CONTRACT_SYMBOL_CHARS,
  };

  const raw = (await fs.readTextFileIfExists(path.join(runtimeRoot, "config", "context-selection-policy.json"))) ?? "";
  if (!raw.trim()) {
    return defaults;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`context selection policy is not valid JSON: ${message}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("context selection policy must be a JSON object");
  }

  const source = parsed as Record<string, unknown>;
  return {
    max_related_files: positiveIntOr(source["max_related_files"], defaults.max_related_files, "max_related_files"),
    max_tests: positiveIntOr(source["max_tests"], defaults.max_tests, "max_tests"),
    max_spec_fragments: positiveIntOr(source["max_spec_fragments"], defaults.max_spec_fragments, "max_spec_fragments"),
    max_context_chars: positiveIntOr(source["max_context_chars"], defaults.max_context_chars, "max_context_chars"),
    max_contract_symbols: positiveIntOr(source["max_contract_symbols"], defaults.max_contract_symbols, "max_contract_symbols"),
    max_symbol_source_chars: positiveIntOr(
      source["max_symbol_source_chars"],
      defaults.max_symbol_source_chars,
      "max_symbol_source_chars",
    ),
    max_symbol_slice_chars: positiveIntOr(
      source["max_symbol_slice_chars"],
      defaults.max_symbol_slice_chars,
      "max_symbol_slice_chars",
    ),
    max_symbol_signature_chars: positiveIntOr(
      source["max_symbol_signature_chars"],
      defaults.max_symbol_signature_chars,
      "max_symbol_signature_chars",
    ),
    max_contract_symbol_chars: positiveIntOr(
      source["max_contract_symbol_chars"],
      defaults.max_contract_symbol_chars ?? DEFAULT_MAX_CONTRACT_SYMBOL_CHARS,
      "max_contract_symbol_chars",
    ),
  };
}

function positiveIntOr(value: unknown, fallback: number, key: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`context selection policy ${key} must be a positive integer`);
  }
  return value;
}

function dedupeStable(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function sortDedupe(values: string[]): string[] {
  return dedupeStable(values).sort();
}

function capList(values: string[], limit: number): string[] {
  return limit > 0 ? values.slice(0, limit) : [];
}
