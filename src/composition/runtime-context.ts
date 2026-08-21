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
