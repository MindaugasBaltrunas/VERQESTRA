// Bootstrap ir operatoriaus atkūrimo klasterio adapteriai (manual DI, LAY-2): projekto režimo
// detekcija, šablonų diegimas, smoke patikra ir atkūrimas iš stable-ref.
//
// Atskiras modulis nuo `node-adapters.ts` dėl dydžio vartų ir dėl temos: šie adapteriai liečia
// PROCESUS (git, PATH) ir šablonų medį — paviršių, kurio kitos komandos neturi.

import path from "node:path";
import type { ProfileDetectionPorts } from "../application/project-bootstrap/detect-profile.js";
import type { ProjectModeDetectionPorts } from "../application/project-bootstrap/detect-mode.js";
import type { InstallPorts, TemplateEntry } from "../interfaces/cli/bootstrap/install.js";
import type { RestoreGitResult, RestoreStablePorts } from "../interfaces/cli/bootstrap/restore-stable.js";
import type { SmokePorts } from "../interfaces/cli/bootstrap/smoke.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { gitCommitExists, isGitRepository } from "../infrastructure/git/git-client.js";
import { loadStableRef } from "../infrastructure/git/stable-ref.js";
import { run } from "../infrastructure/process/run-process.js";
import { ensureRuntimeDirs } from "../infrastructure/state/runtime-dirs.js";

/** Produkto marker failai — tvarka pagal specifiškumą, kaip ir domain klasifikacijoje. */
const PRODUCT_MARKERS = [
  "package.json",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "composer.json",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Gemfile",
];

/** Katalogai, kurių skenuoti neverta: jie yra artefaktai, ne produkto šaltinis. */
const SKIPPED_SCAN_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", "target", "vq", "AG"]);

/**
 * Ribotas source failų skenas. Riba yra KONTRAKTAS, ne optimizacija: profilio detekcija yra
 * advisory seeding, o ne indeksas — neribotas skenas dideliame repo paverstų `project-mode`
 * komandą minučių trukmės operacija.
 */
async function findSourceFiles(projectRoot: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [projectRoot];

  while (queue.length > 0 && found.length < limit) {
    const dir = queue.shift();
    if (dir === undefined) break;
    for (const name of await nodeFsAdapter.listFiles(dir)) {
      if (found.length >= limit) break;
      if (name.startsWith(".")) continue;
      found.push(path.relative(projectRoot, path.join(dir, name)).split(path.sep).join("/"));
    }
    for (const name of await nodeFsAdapter.listSubdirectories(dir)) {
      if (name.startsWith(".") || SKIPPED_SCAN_DIRS.has(name)) continue;
      queue.push(path.join(dir, name));
    }
  }
  return found;
}

export const profileDetectionPorts: ProfileDetectionPorts = {
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  findProductMarkers: async (projectRoot) => {
    const present: string[] = [];
    for (const marker of PRODUCT_MARKERS) {
      if (await nodeFsAdapter.exists(path.join(projectRoot, marker))) present.push(marker);
    }
    return present;
  },
  findSourceFiles: (projectRoot, limit) => findSourceFiles(projectRoot, limit),
};

/** `project-mode`: profilio detekcija plius eilės ir spec medžio skaitymas. */
export const projectModePorts: ProjectModeDetectionPorts = {
  ...profileDetectionPorts,
  countMarkdownFiles: async (absoluteDir) => (await nodeFsAdapter.listMarkdownFiles(absoluteDir)).length,
  listSubdirectories: (absoluteDir) => nodeFsAdapter.listSubdirectories(absoluteDir),
  listFiles: (absoluteDir) => nodeFsAdapter.listFiles(absoluteDir),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
};

/**
 * Šablonų medžio enumeracija: katalogas visada PRIEŠ savo turinį, viskas rūšiuota pagal vardą.
 *
 * Tvarka yra kontraktas: diegimas kuria katalogus eilės tvarka, tad turinys prieš katalogą
 * reikštų rašymą į dar nesukurtą vietą. Nepalaikomas įrašo tipas (symlink, socket) META, o ne
 * tyliai praleidžiamas — nepastebėtas praleidimas duotų nepilną diegimą, atrodantį kaip sėkmė.
 */
async function listTemplateEntries(templatesRoot: string): Promise<TemplateEntry[]> {
  const entries: TemplateEntry[] = [];

  const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    const [directories, files, all] = await Promise.all([
      nodeFsAdapter.listSubdirectories(absoluteDir),
      nodeFsAdapter.listFiles(absoluteDir),
      nodeFsAdapter.listDirectory(absoluteDir),
    ]);
    const known = new Set([...directories, ...files]);
    for (const name of all) {
      if (!known.has(name)) {
        throw new Error(`Unsupported template entry: ${relativeDir === "" ? name : `${relativeDir}/${name}`}`);
      }
    }
    for (const name of [...directories, ...files].sort((a, b) => a.localeCompare(b))) {
      const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`;
      if (directories.includes(name)) {
        // Katalogas eina PRIEŠ savo turinį — diegimas kuria juos eilės tvarka.
        entries.push({ relativePath, kind: "directory" });
        await walk(path.join(absoluteDir, name), relativePath);
      } else {
        entries.push({ relativePath, kind: "file" });
      }
    }
  };

  await walk(templatesRoot, "");
  return entries;
}

/** `install`: šablonų medis, katalogų kūrimas ir kopijavimas be perrašymo. */
export const installPorts: InstallPorts = {
  listTemplateEntries: (templatesRoot) => listTemplateEntries(templatesRoot),
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  // Šablonai yra TEKSTAS (markdown, json, konfigai) — dvejetainių šablonų kontraktas neturi ir
  // etalone neturėjo. `writeFileExclusive` (`wx`): esamo operatoriaus failo diegimas NIEKADA
  // neperrašo, tad pakartotinis `install` yra saugus.
  copyFile: async (sourcePath, targetPath) => {
    const text = await nodeFsAdapter.readTextFile(sourcePath);
    await nodeFsAdapter.makeDirectory(path.dirname(targetPath));
    await nodeFsAdapter.writeFileExclusive(targetPath, text);
  },
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
};

/**
 * Ar vykdomasis failas randamas PATH'e. Naudojamas `where` (win32) / `command -v`.
 *
 * Nulinis exit kodas yra vienintelis „taip": tuščia išvestis su kodu 0 čia neįmanoma, o
 * nepavykęs paleidimas (nėra shell'o) reiškia „ne", ne klaidą — smoke patikra dėl savo
 * zondavimo įrankio negriūva.
 */
async function commandExists(command: string, projectRoot: string): Promise<boolean> {
  const probe = process.platform === "win32" ? { bin: "where", args: [command] } : { bin: "sh", args: ["-c", `command -v ${command}`] };
  try {
    const result = await run(probe.bin, probe.args, { cwd: projectRoot });
    return result.code === 0;
  } catch {
    return false;
  }
}

/** `smoke`: aplinkos ir eilės patikra; NIEKO nekeičia, išskyrus katalogų paruošimą. */
export function smokePorts(agRoot: string, runtimeRoot: string): SmokePorts {
  return {
    ensureDirs: () => ensureRuntimeDirs(agRoot, runtimeRoot),
    commandExists: (command) => commandExists(command, path.dirname(agRoot)),
    exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    countMarkdownFiles: async (absoluteDir) => (await nodeFsAdapter.listMarkdownFiles(absoluteDir)).length,
    isGitRepository: (projectRoot) => isGitRepository(projectRoot),
    gitCommitExists: (ref, projectRoot) => gitCommitExists(ref, projectRoot),
  };
}

/**
 * `restore-stable`: stable-ref skaitymas ir git vykdymas.
 *
 * `stderr` perduodamas TOLIAU: nepavykęs `git reset --hard` be git pranešimo paliktų operatorių
 * su „nepavyko" ir be priežasties — būtent tuo momentu, kai jis atkurinėja sugadintą medį.
 */
export const restoreStablePorts: RestoreStablePorts = {
  loadStableRef: (absolutePath) => loadStableRef(absolutePath),
  runGit: async (args, projectRoot): Promise<RestoreGitResult> => {
    const result = await run("git", ["-C", projectRoot, ...args], { cwd: projectRoot });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  },
};
