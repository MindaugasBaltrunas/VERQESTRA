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
import {
  changedFilesFromStatus,
  isOutsideProjectPath,
  isRuntimePath,
  normalizeGitPath,
  parseDirtyEntries,
  type ChangedFile,
} from "../../domain/git/changes.js";
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

/**
 * Tas pats rinkinys su GIT STATUSU — package/migration guard'ams (etalonas: core/changes.ts
 * `collectChangedFilesWithStatus`).
 *
 * Statusas yra sprendimo įvestis, ne dekoracija: package guard skiria ištrintą svetimą lockfile'ą
 * (teisingas veiksmas) nuo pridėto (rizika), o migration guard — pakeistą migraciją nuo
 * pervadintos. Todėl `changes.log` keliai, kurių git nemato, gauna TUŠČIĄ statusą, o ne spėjimą:
 * hook'as užfiksavo rašymą, bet medyje jo pėdsako nebėra (revertintas ar jau commit'intas), ir
 * apsimesti, kad žinome kuris, reikštų guard'ą, blokuojantį dėl savo telemetrijos.
 */
export async function collectChangedFilesWithStatus(projectRoot: string, runtimeRoot: string): Promise<ChangedFile[]> {
  const root = path.resolve(projectRoot);
  const [status, log] = await Promise.all([
    (await isGitRepository(root)) ? gitStatusPorcelain(root) : Promise.resolve(undefined),
    nodeFsAdapter.readTextFileIfExists(changesLogPath(runtimeRoot)),
  ]);

  const fromGit = changedFilesFromStatus(status ?? "");
  const inGit = new Set(fromGit.map((entry) => entry.file));
  const logOnly = parseChangesLogPaths(log, root)
    .filter((file) => file.length > 0 && !inGit.has(file) && !isRuntimePath(file) && !isOutsideProjectPath(file))
    .map((file) => ({ status: "", file }));

  return [...logOnly, ...fromGit];
}
