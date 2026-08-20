// interfaces/cli/spec barrel — re-exports only (MOD-1).
// E5 VQ-501 (3/5-a): spec komandų klasteris — spec-drift (rendinimas virš application
// quality-gates), export-api-contract ir export-json-schema (application eksporto
// moduliai per portus) + bendras flagValue. Likusios spec pusės komandos (plan,
// openspec-reconcile) — 3/5-b; architecture komanda — 3/5-c.
export * from "./flag-value.js";
export * from "./spec-drift.js";
export * from "./export-api-contract.js";
export * from "./export-json-schema.js";
