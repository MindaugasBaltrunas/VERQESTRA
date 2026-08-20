// interfaces/cli/spec barrel — re-exports only (MOD-1).
// E5 VQ-501 (3/5-a): spec komandų klasteris — spec-drift (rendinimas virš application
// quality-gates), export-api-contract ir export-json-schema (application eksporto
// moduliai per portus) + bendras flagValue. Architecture komanda — 3/5-c.
export * from "./flag-value.js";
export * from "./spec-drift.js";
export * from "./export-api-contract.js";
export * from "./export-json-schema.js";
// E5 VQ-501 (3/5-b): plan (kontrakto generavimas/validacija per application
// task-planning/plan) ir openspec-reconcile (0030 batch suderinimas per application
// task-execution/openspec-reconcile; exit 0/1/2 — converge kontraktas).
export * from "./plan.js";
export * from "./openspec-reconcile.js";
