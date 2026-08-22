// `build-gate` — ar sugeneruotas `dist` atitinka `src`. Etalonas: AG_loop commands/build-gate.ts.
//
// Kodėl atskiras vartas, kai `dist` šviežumą jau tikrina loop preconditions ir Stop hook'as:
// tie du KELIAUJA su darbu (loop'as sustoja, hook'as karantinuoja), o šis atsako operatoriui
// tiesiogiai — vienu paleidimu, be jokio konteksto. Release kelias to reikalauja: pasenęs `dist`
// reiškia, kad hook'ai ir loop vykdo kodą, kurio niekas nebeturi.
//
// Vartas NIEKADA neperstato pats. Tai etalono 2026-07-03 mid-sweep incidento pamoka: gate,
// kuris „pataiso" savo paties radinį, sunaikina įrodymą ir pakeičia medį po operatoriaus kojomis.
// Jis tik praneša ir grąžina rebuild komandą.

import path from "node:path";

/**
 * Kanoninė perstatymo komanda. VIENAS šaltinis visai sistemai: tą pačią eilutę rodo ir šis
 * vartas, ir Stop hook'o karantino pranešimas. Dvi kopijos ilgainiui prasilenktų, ir operatorius
 * gautų dvi skirtingas instrukcijas tam pačiam gedimui.
 */
export const DIST_REBUILD_COMMAND = "pnpm build";

/** Kiek pavyzdžių rodoma ataskaitoje: pilnas sąrašas po masinio pakeitimo paskandintų komandą. */
const MAX_REPORTED_FILES = 10;

/**
 * Pasenusio artefakto vaizdas, kurio reikia BŪTENT šiai ataskaitai.
 *
 * Struktūrinis tipas, o ne importas iš `infrastructure/process/dist-freshness`: application
 * sluoksnis infrastruktūros nemato, o portą tenkina bet kuris platesnis įrašas (`reason`
 * konkrečioje realizacijoje yra siauresnė sąjunga — ji čia tinka be jokio konvertavimo).
 */
export type BuildGateStaleFile = {
  sourcePath: string;
  distPath: string;
  reason: string;
};

export type BuildGatePorts = {
  /** Pasenę arba trūkstami `dist` artefaktai paketo šaknyje (E4 adapteris). */
  findStaleDistFiles(packageRoot: string): Promise<BuildGateStaleFile[]>;
};

export type BuildGateReport = {
  status: "ok" | "stale";
  staleCount: number;
  report: string;
};

/**
 * Deterministinė ataskaita: `ok` atveju vienas sakinys, `stale` atveju — priežastis, kanoninė
 * rebuild komanda ir iki 10 artefaktų. Gryna funkcija, kad testai ir CLI dalintųsi ta pačia forma.
 */
export function renderBuildGateReport(packageRoot: string, staleFiles: readonly BuildGateStaleFile[]): string {
  if (staleFiles.length === 0) {
    return "build-gate: ok — dist matches src (hooks and loop run current code).";
  }

  const examples = staleFiles
    .slice(0, MAX_REPORTED_FILES)
    .map(
      (file) =>
        `  - ${path.relative(packageRoot, file.sourcePath)} -> ${path.relative(packageRoot, file.distPath)} (${file.reason})`,
    )
    .join("\n");

  return [
    `build-gate: stale — ${staleFiles.length} generated file(s) behind src.`,
    "Hooks and the loop run from dist/, so a stale dist executes old logic. This gate only reports; it never rebuilds.",
    `Fix: ${DIST_REBUILD_COMMAND}`,
    "Stale or missing generated files:",
    examples,
  ].join("\n");
}

export async function runBuildGate(ports: BuildGatePorts, packageRoot: string): Promise<BuildGateReport> {
  const staleFiles = await ports.findStaleDistFiles(path.resolve(packageRoot));
  return {
    status: staleFiles.length === 0 ? "ok" : "stale",
    staleCount: staleFiles.length,
    report: renderBuildGateReport(packageRoot, staleFiles),
  };
}
