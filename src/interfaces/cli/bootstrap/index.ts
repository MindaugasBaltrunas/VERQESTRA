// interfaces/cli/bootstrap barrel — re-exports only (MOD-1).
// E5 VQ-501 (5/5-a): diegimo ir valdymo lengvosios komandos — project-mode (patariamoji
// klasifikacija virš NAUJO application/project-bootstrap/detect-mode), preflight
// (deterministinis task vartas virš application/quality-gates), restore-stable (planas be
// --execute), smoke (diegimo sveikatos patikra su AG_SMOKE_* žyme) ir install (skip-if-exists
// šablonai + versijos būsena virš domain/project/template-version).
export * from "./project-mode.js";
export * from "./preflight.js";
export * from "./restore-stable.js";
export * from "./smoke.js";
export * from "./install.js";
