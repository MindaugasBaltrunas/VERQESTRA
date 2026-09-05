// `install` CLI adapteris (etalonas: interfaces/cli/install/index.ts): pofailinis,
// skip-if-exists šablonų kopijavimas į target projektą.
//
// Skip-if-exists yra saugos taisyklė, ne optimizacija: `install` paleidžiamas ir ant jau
// gyvo projekto, tad esamas failas NIEKADA neperrašomas — operatoriaus redaguotas
// `.claude/settings.json` ar `CLAUDE.md` privalo išlikti. Todėl versijos ataskaita ir sako
// „existing files were preserved", kai įdiegta versija atsilieka: naujesnių šablonų pokyčius
// operatorius sulieja pats.
//
// VERQESTRA skirtumas: katalogo skenas, kopijavimas ir failų skaitymas — per InstallPorts;
// versijos formos/palyginimo taisyklės — grynas domain/project/template-version.

import path from "node:path";
import { compareTemplateVersions, parseTemplateVersion } from "../../../domain/project/index.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type TemplateEntry = { relativePath: string; kind: "directory" | "file" };

export type InstallResult = {
  dryRun: boolean;
  createdDirectories: string[];
  copiedFiles: string[];
  skippedFiles: string[];
};

export type InstallPorts = {
  /**
   * Rekursyvus šablonų sąrašas, rūšiuotas pagal vardą, katalogas prieš savo turinį.
   * Nepalaikomas įrašo tipas (symlink, socket) — klaida, ne tylus praleidimas.
   */
  listTemplateEntries(templatesRoot: string): Promise<TemplateEntry[]>;
  exists(absolutePath: string): Promise<boolean>;
  makeDirectory(absoluteDir: string): Promise<void>;
  copyFile(sourcePath: string, targetPath: string): Promise<void>;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
};

export type InstallCommandDeps = {
  ports: InstallPorts;
  /** Šablonų katalogas su savo `VERSION` failu (paduoda kompozicija). */
  templatesRoot: string;
  /** Numatytasis taikinys, kai komanda paleidžiama be pozicinio argumento. */
  projectRoot: string;
  io?: CliIo;
};

export async function installTemplates(
  ports: InstallPorts,
  targetProjectDir: string,
  templatesRoot: string,
  dryRun = false,
): Promise<InstallResult> {
  const targetRoot = path.resolve(targetProjectDir);
  const result: InstallResult = { dryRun, createdDirectories: [], copiedFiles: [], skippedFiles: [] };

  for (const entry of await ports.listTemplateEntries(templatesRoot)) {
    const target = path.join(targetRoot, entry.relativePath);
    const displayPath = entry.relativePath.split(path.sep).join("/");

    if (entry.kind === "directory") {
      if (!(await ports.exists(target))) {
        result.createdDirectories.push(displayPath);
        if (!dryRun) await ports.makeDirectory(target);
      }
      continue;
    }

    if (await ports.exists(target)) {
      result.skippedFiles.push(displayPath);
      continue;
    }

    result.copiedFiles.push(displayPath);
    if (!dryRun) {
      await ports.makeDirectory(path.dirname(target));
      await ports.copyFile(path.join(templatesRoot, entry.relativePath), target);
    }
  }

  return result;
}

/**
 * Šablonų versijos būsena po diegimo. `null`, kai šablonai VERSION failo neturi — tada
 * eilutė praleidžiama, o ne verčiama klaida: versijos nebuvimas nėra diegimo problema.
 */
export async function describeTemplateVersionStatus(
  ports: InstallPorts,
  templatesRoot: string,
  targetRoot: string,
  dryRun: boolean,
): Promise<string | null> {
  const currentRaw = await ports.readTextFileIfExists(path.join(templatesRoot, "VERSION"));
  if (currentRaw === undefined) return null;
  const current = parseTemplateVersion(currentRaw);

  const installedRaw = await ports.readTextFileIfExists(path.join(targetRoot, "VERSION"));
  if (dryRun || installedRaw === undefined) {
    return `Template version: ${current.raw}`;
  }

  const comparison = compareTemplateVersions(installedRaw, current.raw);
  const relationText =
    comparison.relation === "current"
      ? "up to date"
      : comparison.relation === "behind"
        ? `behind current ${current.raw} (existing files were preserved; review template changes)`
        : `ahead of current ${current.raw}`;
  return `Template version: installed ${comparison.installed.raw}, current ${current.raw} — ${relationText}`;
}

export async function installCommand(deps: InstallCommandDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const dryRun = args.includes("--dry-run");
    const positional = args.filter((arg) => arg !== "--dry-run");
    if (positional.length > 1) {
      throw new Error("Usage: verqestra install [<target-project-dir>] [--dry-run]");
    }
    const target = positional[0] ?? deps.projectRoot;

    const targetRoot = path.resolve(target);
    const result = await installTemplates(deps.ports, target, deps.templatesRoot, dryRun);
    const prefix = dryRun ? "Would write" : "Wrote";
    for (const directory of result.createdDirectories) io.out(`${prefix} directory: ${directory}`);
    for (const file of result.copiedFiles) io.out(`${prefix} file: ${file}`);
    for (const file of result.skippedFiles) io.out(`Skipped existing file: ${file}`);

    const versionStatus = await describeTemplateVersionStatus(deps.ports, deps.templatesRoot, targetRoot, dryRun);
    if (versionStatus) io.out(versionStatus);
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
