// application/project-bootstrap barrel — re-exports only (MOD-1).
//
// VQ-305 (3/3-g): detect-profile (workspace įrodymai per ProfileDetectionPorts → grynas
// domain/project resolveProjectProfile) ir generate (OpenSpec change iš README intencijos
// + architektūros grafo per BootstrapSpecPorts; LLM generatorius — E4/E5 injekcija).
export * from "./detect-profile.js";
export * from "./generate.js";
