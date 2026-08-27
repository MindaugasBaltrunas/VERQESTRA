// REF/SIG/SRC tier'ų pritaikymas surinktiems simboliams ir overflow ladder'io taikymas.
// Behaviour etalon: AG_loop application/context-pack/assemble.ts (tiers pusė; WBR VQ-302
// skaidymas). Pure over its inputs — sprendimas gyvena context-selection-policy.

import {
  contractSignatureBudget,
  selectCodeContextTiers,
  symbolSourceBudget,
  type CodeContextReduction,
  type CodeContextSymbolState,
  type CodeContextTier,
  type ContextSelectionLimits,
} from "../../policy-governance/context-selection-policy.js";
import type { SourceSlice } from "../source-slice.js";
import type { CodeContextCandidates, TieredContextSymbol } from "./gather.js";

/**
 * Assign REF/SIG/SRC tiers to the gathered symbols (task 0023) and attach the exact source
 * to every symbol that earned SRC. This function only marries the policy's assignments back
 * onto the symbol list and turns downgrades into pack notes.
 */
export function applyCodeContextTiers(
  candidates: CodeContextCandidates,
  limits: ContextSelectionLimits,
  reservedChars: number,
): { symbols: TieredContextSymbol[]; notes: string[] } {
  const slices = candidates.sourceSlices ?? new Map<string, SourceSlice>();
  const selection = selectCodeContextTiers(
    candidates.symbolFragments.map((symbol) => ({
      id: symbol.id,
      role: symbol.role,
      signatureChars: symbol.signature?.length ?? 0,
      sourceChars: slices.get(symbol.id)?.text.length ?? 0,
    })),
    {
      max_symbol_slice_chars: limits.max_symbol_slice_chars,
      max_symbol_signature_chars: limits.max_symbol_signature_chars,
      sourceBudgetChars: symbolSourceBudget(limits, reservedChars),
      contractSignatureBudgetChars: contractSignatureBudget(limits, reservedChars),
    },
  );

  const tierById = new Map(selection.assignments.map((assignment) => [assignment.id, assignment.tier]));
  const symbols = candidates.symbolFragments.map((symbol): TieredContextSymbol => {
    const tier = tierById.get(symbol.id) ?? "REF";
    const slice = tier === "SRC" ? slices.get(symbol.id) : undefined;
    const tiered: TieredContextSymbol = {
      ...symbol,
      tier,
      ...(slice ? { source: { text: slice.text, hash: slice.hash, line: slice.line, endLine: slice.endLine } } : {}),
    };
    if (tier === "REF") {
      // REF is symbol, file and line range BY DEFINITION: a signature nothing renders is
      // pure weight in the non-droppable overhead, which is exactly what overflows the
      // budget when a task has many contracts (task 0006).
      delete tiered.signature;
    }
    return tiered;
  });

  return { symbols, notes: selection.downgraded.map((entry) => `code context tier downgraded: ${entry}`) };
}

/**
 * The pack-side view of a symbol's current detail level, for `planCodeContextReductions`.
 * A pack assembled with `symbol_slices` off carries no `tier`, so the level is read from
 * what the symbol actually holds — the same rule the reduction below applies in reverse.
 */
export function codeContextSymbolState(symbol: TieredContextSymbol): CodeContextSymbolState {
  return {
    id: symbol.id,
    role: symbol.role,
    tier: currentTier(symbol),
    hasSignature: symbol.signature !== undefined,
  };
}

function currentTier(symbol: TierMeasurableSymbol): CodeContextTier {
  if (symbol.tier !== undefined) {
    return symbol.tier;
  }
  if (symbol.source !== undefined) {
    return "SRC";
  }
  return symbol.signature !== undefined ? "SIG" : "REF";
}

/**
 * The subset of a symbol's fields `measureSymbolTierChars`/`currentTier` need. Declared
 * separately from `TieredContextSymbol` (rather than reused) so a pack read back through
 * `contextPackSchema` — whose zod `.optional()` fields carry an explicit `| undefined` under
 * `exactOptionalPropertyTypes` — is directly assignable, without persist.ts having to narrow
 * every unrelated field (`line`, `endLine`, `id`, ...) first.
 */
type TierMeasurableSymbol = {
  tier?: CodeContextTier | undefined;
  signature?: string | undefined;
  source?: { text: string } | undefined;
};

/**
 * SRC/SIG chars of a gathered symbol list, measured at gather time so persist.ts never has to
 * recompute it after the tier decision (task 036-b-03). Reuses `currentTier`'s fallback — the
 * same rule `codeContextSymbolState` applies — so a `symbol_slices`-off list (no explicit
 * `tier`, no `source`, but `signature` already read from the index with no extra I/O) still
 * reports its real SIG weight instead of leaving the pair absent. SRC stays a true zero in that
 * case: no source slice was ever read, so there is nothing to sum.
 */
export function measureSymbolTierChars(
  symbols: readonly TierMeasurableSymbol[],
): { symbolSourceChars: number; symbolSignatureChars: number } {
  let symbolSourceChars = 0;
  let symbolSignatureChars = 0;
  for (const symbol of symbols) {
    const tier = currentTier(symbol);
    if (tier === "SRC" && symbol.source) {
      symbolSourceChars += symbol.source.text.length;
    } else if (tier === "SIG" && symbol.signature) {
      symbolSignatureChars += symbol.signature.length;
    }
  }
  return { symbolSourceChars, symbolSignatureChars };
}

/**
 * Apply one rung of the overflow ladder to the FULL symbol list.
 *
 * A demotion sheds exactly the payload the new tier no longer covers: anything below SRC
 * loses its source slice, REF also loses its signature. Symbols the rung dropped are gone
 * from the pack entirely. `tier` is only rewritten where the symbol already carried one, so
 * a `symbol_slices`-off pack never gains a tier key it would not otherwise have.
 *
 * Always derived from the untouched list rather than from the previous rung's output, so
 * applying a rung is idempotent and the reduced pack stays a pure function of the plan.
 */
export function applyCodeContextReduction(
  symbols: readonly TieredContextSymbol[],
  reduction: CodeContextReduction,
): TieredContextSymbol[] {
  const tierById = new Map(reduction.symbols.map((entry) => [entry.id, entry.tier]));
  const reduced: TieredContextSymbol[] = [];
  for (const symbol of symbols) {
    const tier = tierById.get(symbol.id);
    if (tier === undefined) {
      continue;
    }
    const next: TieredContextSymbol = { ...symbol };
    if (tier !== "SRC") {
      delete next.source;
    }
    if (tier === "REF") {
      delete next.signature;
    }
    if (symbol.tier !== undefined) {
      next.tier = tier;
    }
    reduced.push(next);
  }
  return reduced;
}
