/**
 * What a model call costs, in the two quantities a benchmark may report.
 *
 * A leaf module with no imports, because four folds need this arithmetic and they sit in three
 * different layers: the mode aggregate, the compression aggregate, the per-scenario distributions
 * and the adapter that enforces a per-sample token limit. Restating it four times was how the
 * `input + output` definition survived in one place after being corrected in another — the terms
 * are cheap to retype and the disagreement is invisible until two reports differ.
 *
 * The terms are taken flat rather than as a `BenchmarkSample`, because the adapter holds a
 * telemetry envelope it has not yet turned into a sample and would otherwise have to keep its own
 * copy of the formula for exactly one caller.
 */

/** The token counts a bill is computed from. `cacheCreationInputTokens` is absent on a v1 envelope. */
export interface TokenCostTerms {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens?: number | undefined;
  readonly cacheReadInputTokens?: number | undefined;
}

/**
 * `input + output + cacheCreation` — what the provider bills.
 *
 * Cache *reads* are excluded: writing a prefix into the cache is charged like input, re-reading it
 * at a fraction. Both are wrong to omit and wrong to merge, so the read side is
 * {@link cacheReadTokens} and the two are reported side by side.
 *
 * `input_tokens` as a provider reports it already excludes the cached prefix, which is why the
 * cache creation term is not optional accounting detail: without it the measured cost of a mode
 * that reuses a large prefix falls to a small fraction of its bill.
 */
export function billableTokens(terms: TokenCostTerms): number {
  return terms.inputTokens + terms.outputTokens + (terms.cacheCreationInputTokens ?? 0);
}

/** Cache reads. Billed at a fraction of input, so reported beside the bill rather than inside it. */
export function cacheReadTokens(terms: TokenCostTerms): number {
  return terms.cacheReadInputTokens ?? 0;
}

/** The raw stream: everything that crossed the wire. A safety quantity, never the objective. */
export function totalTokens(terms: TokenCostTerms): number {
  return billableTokens(terms) + cacheReadTokens(terms);
}
