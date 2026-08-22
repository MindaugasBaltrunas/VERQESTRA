/**
 * Compression measurement contract (task 0029).
 *
 * The façade over `domain/compression/*`, mirroring `domain/metrics.ts` and
 * `domain/baseline.ts`: one module a consumer — and the package barrel — names,
 * so the split into a registry, a variant, a cohort, a fold and a verdict stays
 * an internal arrangement rather than five things every caller has to know.
 *
 * Compression is a second dimension beside `ExecutionMode`: the mode says who
 * did the work, a variant says how much context the work was given. Nothing here
 * decides a verdict from a character count — chars are diagnostics, tokens are
 * the measurement.
 */

export * from "./compression/features.js";
export * from "./compression/variant.js";
export * from "./compression/cohort.js";
export * from "./compression/aggregate.js";
export * from "./compression/compression-verdict.js";
