// Ar integracija palietė variklio arba UI source (etalonas: AG_loop integration-build-impact.ts).
// VERQESTRA skirtumas: variklio source šaknis yra `src/` (ne AG/orchestrator/src/) — pakeitimas
// ten reiškia „dist gali būti pasenęs", o `ui-app/src/` — kad `ui-app/dist` gali būti pasenęs.

import path from "node:path";
import { run } from "../process/run-process.js";

/** Repo-relative prefiksas, kurio pakeitimas reiškia „variklio dist gali būti pasenęs". */
export const ORCHESTRATOR_SRC_PREFIX = "src/";

/** Repo-relative prefiksas, kurio pakeitimas reiškia „ui-app/dist gali būti pasenęs". */
export const UI_SRC_PREFIX = "ui-app/src/";

export type TouchedSourceSurfaces = { orchestratorSrc: boolean; uiSrc: boolean };

/**
 * Ar `before..after` diff'as paliečia variklio ir/ar UI source. Neįrodomu atveju abu grąžina
 * `true`, kad pasenęs dist (variklio ar UI) neliktų nepastebėtas.
 */
export async function integrationTouchedSourceSurfaces(input: {
  projectRoot: string;
  before?: string;
  after: string;
}): Promise<TouchedSourceSurfaces> {
  if (!input.before) return { orchestratorSrc: true, uiSrc: true };
  const projectRoot = path.resolve(input.projectRoot);
  const result = await run("git", ["-C", projectRoot, "diff", "--name-only", `${input.before}..${input.after}`], {
    cwd: projectRoot,
  });
  if (result.code !== 0) return { orchestratorSrc: true, uiSrc: true };
  const files = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  return {
    orchestratorSrc: files.some((file) => file.startsWith(ORCHESTRATOR_SRC_PREFIX)),
    uiSrc: files.some((file) => file.startsWith(UI_SRC_PREFIX)),
  };
}
