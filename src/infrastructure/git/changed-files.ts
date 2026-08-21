// Pakeistų PRODUKTO failų rinkinys: `git status` ∪ `vq/logs/changes.log` (etalonas: AG_loop
// core/changes.ts `collectChangedFiles`).
//
// Kodėl DVI šaltiniai, o ne vienas:
//   - `git status` yra tiesa apie darbo medį, bet ne-git projekte jo išvis nėra;
//   - `changes.log` yra hook'ų rašomas įrodymas, kuris pergyvena ne-git aplinką, BET Stop hook'as
//     jį valo po kiekvieno commit'o, tad vienas jis irgi nepakanka.
// Sąjunga atsako į klausimą „ką ši sesija realiai palietė" abiem atvejais.
//
// Taisyklės (kas yra produkto kelias) gyvena `domain/git/changes` — čia tik skaitymas ir sąjunga.

import path from "node:path";
import { isOutsideProjectPath, isRuntimePath, normalizeGitPath, parseDirtyEntries } from "../../domain/git/changes.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { gitStatusPorcelain, isGitRepository } from "./git-client.js";

/** `[stamp] MODIFIED: <path>` — vienintelė forma, kurią rašo PostToolUse hook'as. */
const CHANGES_LOG_LINE = /^\[[^\]]*\]\s*MODIFIED:\s*(.+)$/;

export function changesLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "changes.log");
}

/** Gryna dalis: log eilutės → repo-santykiniai keliai (be filtravimo). */
export function parseChangesLogPaths(content: string | undefined, projectRoot: string): string[] {
  const paths: string[] = [];
  for (const line of (content ?? "").split(/\r?\n/)) {
    const match = CHANGES_LOG_LINE.exec(line.trim());
    const raw = match?.[1]?.trim();
    if (!raw) continue;
    // Hook'as rašo tai, ką gavo payload'e: kelias gali būti absoliutus arba jau repo-santykinis.
    const relative = path.isAbsolute(raw) ? path.relative(projectRoot, raw) : raw;
    paths.push(normalizeGitPath(relative));
  }
  return paths;
}

/**
 * Produkto keliai, kuriuos palietė ši sesija. Runtime prefiksai ir keliai už repo ribų
 * atfiltruojami: pirmieji yra šio loop'o buhalterija, antrieji — ne produkto pakeitimai (pvz.
 * agento atminties failai vartotojo kataloge).
 */
export async function collectChangedFiles(projectRoot: string, runtimeRoot: string): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const [status, log] = await Promise.all([
    (await isGitRepository(root)) ? gitStatusPorcelain(root) : Promise.resolve(undefined),
    nodeFsAdapter.readTextFileIfExists(changesLogPath(runtimeRoot)),
  ]);

  const fromGit = parseDirtyEntries(status ?? "").map((entry) => entry.path);
  const fromLog = parseChangesLogPaths(log, root);

  const merged = [...new Set([...fromGit, ...fromLog])].filter(
    (file) => file.length > 0 && !isRuntimePath(file) && !isOutsideProjectPath(file),
  );
  return merged.sort();
}
