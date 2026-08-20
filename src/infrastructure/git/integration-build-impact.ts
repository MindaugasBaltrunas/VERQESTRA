// Ar integracija palietė variklio source (etalonas: AG_loop integration-build-impact.ts).
// VERQESTRA skirtumas: variklio source šaknis yra `src/` (ne AG/orchestrator/src/) —
// pakeitimas ten reiškia „dist gali būti pasenęs".

import path from "node:path";
import { run } from "../process/run-process.js";

/** Repo-relative prefiksas, kurio pakeitimas reiškia „dist gali būti pasenęs". */
export const ORCHESTRATOR_SRC_PREFIX = "src/";

/**
 * Ar `before..after` diff'as paliečia variklio source.
 * Neįrodomu atveju grąžina `true`, kad pasenęs dist neliktų nepastebėtas.
 */
export async function integrationTouchedOrchestratorSrc(input: {
  projectRoot: string;
  before?: string;
  after: string;
}): Promise<boolean> {
  if (!input.before) return true;
  const projectRoot = path.resolve(input.projectRoot);
  const result = await run("git", ["-C", projectRoot, "diff", "--name-only", `${input.before}..${input.after}`], {
    cwd: projectRoot,
  });
  if (result.code !== 0) return true;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((file) => file.replace(/\\/g, "/").startsWith(ORCHESTRATOR_SRC_PREFIX));
}
