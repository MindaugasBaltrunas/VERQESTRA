// Kompozicijos šaknis: IŠ KUR imamos projekto ir runtime šaknys (etalonas: AG_loop
// orchestrator/runtime/context.ts `detectProjectRoot`).
//
// Vienintelė vieta visame produkte, kuri skaito `process.env` ir `process.cwd()` šiuo klausimu.
// Visi sluoksniai šaknis gauna PARAMETRU — kitaip du moduliai tame pačiame procese galėtų dirbti
// skirtingose šaknyse (etalone būtent tokia klaida gimdė „ledger'is vienoje, failai kitoje").
//
// `CLAUDE_PROJECT_DIR` laimi prieš `cwd`, nes jį nustato procesą PALEIDĘS operatorius arba hook'ų
// aplinka: hook'as vykdomas iš nenuspėjamo katalogo, tad `cwd` ten nėra įrodymas.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_DIR_ENV = "CLAUDE_PROJECT_DIR";

/** Runtime katalogo vardas — VERQESTRA produkto būsena gyvena `vq/`. */
export const RUNTIME_DIR = "vq";

/** Užduočių eilės ir OpenSpec kontraktai lieka `AG/` (paketo kontraktas, žr. CLAUDE.md). */
export const TASKS_DIR = "AG";

export type RuntimeRoots = {
  /** Repozitorijos šaknis. */
  projectRoot: string;
  /** `<projectRoot>/vq` — būsena, konfigai, logai. */
  runtimeRoot: string;
  /** `<projectRoot>/AG` — užduočių bucket'ai ir OpenSpec. */
  agRoot: string;
};

export type ResolveRootsInput = {
  env?: (name: string) => string | undefined;
  cwd?: () => string;
};

export function resolveRuntimeRoots(input: ResolveRootsInput = {}): RuntimeRoots {
  const fromEnv = input.env?.(PROJECT_DIR_ENV)?.trim();
  const projectRoot = path.resolve(fromEnv ? fromEnv : (input.cwd?.() ?? process.cwd()));
  return {
    projectRoot,
    runtimeRoot: path.join(projectRoot, RUNTIME_DIR),
    agRoot: path.join(projectRoot, TASKS_DIR),
  };
}

/**
 * Šio DIEGIMO šaknis (paketo katalogas), o ne vartotojo projekto šaknis.
 *
 * Skirtumas esminis: `install` kopijuoja šablonus IŠ paketo Į svetimą projektą, tad šablonų
 * kelio negalima vesti iš `projectRoot` — kitaip diegimas ieškotų savo šablonų taikinyje.
 * Vedama iš šio modulio vietos: `<paketas>/dist/composition/runtime-context.js` → du lygiai aukštyn.
 */
export function packageRoot(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..");
}

/** Šablonų medis, kurį diegia `install`. */
export function templatesRoot(moduleUrl?: string): string {
  return path.join(moduleUrl === undefined ? packageRoot() : packageRoot(moduleUrl), "templates");
}

/** Šio diegimo CLI įėjimas — `smoke` tikrina ir jo buvimą. */
export function cliEntryPath(moduleUrl?: string): string {
  return path.join(moduleUrl === undefined ? packageRoot() : packageRoot(moduleUrl), "dist", "cli.js");
}
