// application/release-readiness barrel — re-exports only (MOD-1).
//
// VQ-305 (3/3-b): milestone-check (kokybė + spec išlygiavimas + lokali security politika),
// release-check (build/tests/milestone/docs/package-layout kompozicija + source-state hash;
// docs/package-layout runner'iai — E5 repo politika), architecture-boundary-check,
// final-audit kompozicija per FinalAuditPorts (converge/readiness/backlog/benchmark/
// compression patikras paduoda composition), release-notes ir release-proof.
// benchmark-evidence-check (BENCH-12 vartai virš benchmark klasterio) — VQ-305 3/3-c;
// final-audit jį gauna per portą, tad kompozicija laisva rinktis wiring'ą.
export * from "./milestone-check.js";
export * from "./release-check.js";
export * from "./architecture-boundary-check.js";
export * from "./benchmark-evidence-check.js";
export * from "./final-audit.js";
export * from "./release-notes.js";
export * from "./release-proof.js";
