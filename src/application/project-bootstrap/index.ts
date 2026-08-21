// application/project-bootstrap barrel — re-exports only (MOD-1).
//
// VQ-305 (3/3-g): detect-profile (workspace įrodymai per ProfileDetectionPorts → grynas
// domain/project resolveProjectProfile) ir generate (OpenSpec change iš README intencijos
// + architektūros grafo per BootstrapSpecPorts; LLM generatorius — E4/E5 injekcija).
// VQ-501 (5/5-a): detect-mode (patariamoji projekto režimo klasifikacija — signalai per
// tuos pačius ProfileDetectionPorts, sprendimas grynas domain/project classifyProjectMode).
export * from "./detect-profile.js";
export * from "./generate.js";
export * from "./detect-mode.js";
