// domain/metrics barrel — re-exports only (MOD-1). canonicalJsonStringify čia NĖRA:
// jis gyvena shared/json (FQC-12; WBR VQ-204 acceptance grep-taisyklė).
export * from "./usage.js";
export * from "./cases.js";
export * from "./acceptance-gates.js";
export * from "./task-metrics.js";
export * from "./totals.js";
export * from "./comparison.js";
