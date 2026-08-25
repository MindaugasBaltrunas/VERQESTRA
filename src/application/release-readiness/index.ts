// application/release-readiness barrel — re-exports only (MOD-1).
//
// VQ-305 (3/3-b): milestone-check (kokybė + spec išlygiavimas + lokali security politika),
// release-check (build/tests/milestone/docs/package-layout kompozicija + source-state hash;
// docs/package-layout runner'iai — E5 repo politika), architecture-boundary-check,
// final-audit kompozicija per FinalAuditPorts (converge/readiness/backlog/benchmark/
// compression patikras paduoda composition), release-notes ir release-proof.
// benchmark-evidence-check (BENCH-12 vartai virš benchmark klasterio) — VQ-305 3/3-c;
// final-audit jį gauna per portą, tad kompozicija laisva rinktis wiring'ą.
// VQ-305 (3/3-e): compression rollout vartai (task 1206 + 0008) — config-digest
// (kanoninė forma transkribuota iš benchmark paketo), model (kontraktai/portas),
// evidence (raporto sekcija, run-identity sidecar'ai, canary telemetrija) ir
// compression-quality-check kompozicija; final-audit ją gauna per compressionQuality portą.
export * from "./milestone-check.js";
export * from "./release-check.js";
export * from "./architecture-boundary-check.js";
export * from "./benchmark-evidence-check.js";
export * from "./final-audit.js";
export * from "./release-notes.js";
export * from "./release-proof.js";
export * from "./compression-config-digest.js";
export * from "./compression-quality-model.js";
export * from "./compression-quality-evidence.js";
export * from "./compression-quality-check.js";
// VQ-305 (3/3-g): converge/readiness/backlog — FinalAuditPorts patikrų tiekėjai
// (kompozicija adapteriu suploja jų rezultatus į FinalAuditCheck formą).
export * from "./converge-check.js";
export * from "./readiness-audit.js";
export * from "./backlog-audit.js";
// Backlog: „Automatizuoti project status ir converge perleidimą po kiekvieno commit'o su
// telemetry įrašu" (1/2 — use-case; composition wiring atskiras task'as).
export * from "./commit-convergence.js";
