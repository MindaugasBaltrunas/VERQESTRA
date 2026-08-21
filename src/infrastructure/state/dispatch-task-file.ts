// `resolveExistingDispatchTaskFile` (etalonas: AG_loop core/paths.ts) — GRYNOS adreso
// taisykles (domain/tasks/dispatch-paths) plius vienintelis failų sistemos patikrinimas.
//
// Domain antraštė šią funkciją sąmoningai atidėjo: adreso taisyklė yra gryna ir testuojama be
// medžio, o egzistavimo klausimas be failų sistemos neatsakomas. Skirtumas išlaikomas ir čia:
// šis modulis PATS jokių taisyklių neturi, tik uždeda `stat` ant jau išspręsto kelio.

import { resolveDispatchTaskFile } from "../../domain/tasks/dispatch-paths.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/**
 * Dispatch'inamo task failo kelias, patvirtintas failų sistemoje.
 *
 * Dvi ATSKIROS klaidos, o ne viena: „nėra" ir „ne failas" veda operatorių skirtingais keliais
 * (pirmu atveju jis ieško teisingo vardo, antru — supranta, kad nurodė katalogą). Sulietas
 * pranešimas tą skirtumą prarastų būtent tada, kai jis reikalingas.
 */
export async function resolveExistingDispatchTaskFile(
  projectRoot: string,
  candidate: string,
  label = "task file",
): Promise<string> {
  const resolved = resolveDispatchTaskFile(projectRoot, candidate, label);
  const kind = await nodeFsAdapter.statKind(resolved);
  if (kind === "absent") throw new Error(`${label} does not exist: ${candidate}`);
  if (kind !== "file") throw new Error(`${label} must be a file: ${candidate}`);
  return resolved;
}
