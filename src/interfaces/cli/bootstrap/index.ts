// interfaces/cli/bootstrap barrel — re-exports only (MOD-1).
// E5 VQ-501 (5/5-a): diegimo ir valdymo lengvosios komandos — project-mode (patariamoji
// klasifikacija virš NAUJO application/project-bootstrap/detect-mode), preflight
// (deterministinis task vartas virš application/quality-gates), restore-stable (planas be
// --execute), smoke (diegimo sveikatos patikra su AG_SMOKE_* žyme) ir install (skip-if-exists
// šablonai + versijos būsena virš domain/project/template-version).
// E5 VQ-501 (5/5-d): compound-init — darbo erdvės paruošimas su skip-if-exists rašymu ir
// profiliu, seedintu iš realios detekcijos.
export * from "./project-mode.js";
export * from "./compound-init.js";
// E5 VQ-501 (5/5-e): bootstrap-project — pilnas tuščios eilės srautas; kiekviena ne-generated
// baigtis sustoja PRIEŠ rašymą, o eilės failai rašomi tik „nekurti, jei yra" semantika.
export * from "./bootstrap-project.js";
export * from "./preflight.js";
export * from "./restore-stable.js";
export * from "./smoke.js";
export * from "./install.js";
