// domain/architecture barrel — re-exports only (MOD-1). Skirtingai nei AG_loop etalonas,
// įtraukia ir node-verification-rules (WBR VQ-204) — verifikacijos taisyklės yra to paties
// domeno dalis, o ne atskiras privatus modulis.
export * from "./graph.js";
export * from "./graph-hash.js";
export * from "./graph-import.js";
export * from "./path-lite.js";
export * from "./input-source-classification.js";
export * from "./evidence.js";
export * from "./implementation-detection.js";
export * from "./interface-inference.js";
export * from "./readiness.js";
export * from "./node-verification-rules.js";
// E5 VQ-501 (3/5-c): repair-policy — verifyNode failure klasifikacija + bandymų limitas
// (etalono architecture-repair-policy.ts grynos taisyklės).
export * from "./repair-policy.js";
