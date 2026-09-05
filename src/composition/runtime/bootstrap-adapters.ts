// Bootstrap ir operatoriaus atkūrimo klasterio adapteriai (manual DI, LAY-2): projekto režimo
// detekcija, šablonų diegimas, smoke patikra ir atkūrimas iš stable-ref.
//
// Atskiras modulis nuo `node-adapters.ts` dėl dydžio vartų ir dėl temos: šie adapteriai liečia
// PROCESUS (git, PATH) ir šablonų medį — paviršių, kurio kitos komandos neturi.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProfileDetectionPorts } from "../../application/project-bootstrap/detect-profile.js";
import type { ProjectModeDetectionPorts } from "../../application/project-bootstrap/detect-mode.js";
import type { BootstrapProjectPorts } from "../../interfaces/cli/bootstrap/bootstrap-project.js";
import type { CompoundInitPorts, WriteState } from "../../interfaces/cli/bootstrap/compound-init.js";
import type { InstallPorts, TemplateEntry } from "../../interfaces/cli/bootstrap/install.js";
import type {
  RollbackCommandResult,
  RollbackStablePorts,
  TaskScopeRestoreOutcome,
} from "../../interfaces/cli/bootstrap/rollback-stable.js";
import type { RestoreGitResult, RestoreStablePorts } from "../../interfaces/cli/bootstrap/restore-stable.js";
import type { SmokePorts } from "../../interfaces/cli/bootstrap/smoke.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { gitCommitExists, gitHead, gitStatus, isGitRepository } from "../../infrastructure/git/git-client.js";
import {
  committedTaskWorkSince,
  detectPushedRollback,
  readTaskScopePaths,
  restoreTaskScope,
} from "../../infrastructure/git/rollback-scope.js";
import { loadStableRef } from "../../infrastructure/git/stable-ref.js";
// `commandExists` — VIENA realizacija visam produktui. Lokali kopija čia zondavo per
// `sh -c "command -v ${command}"`, t. y. interpoliavo vardą į shell eilutę; bendroji paduoda jį
// atskiru argumentu (`command -v "$1"`), tad tarpas ar `;` komandos varde nebeįvykdo nieko.
import { commandExists, run } from "../../infrastructure/process/run-process.js";
import { ensureRuntimeDirs } from "../../infrastructure/state/runtime-dirs.js";
import { createBootstrapSpecPorts } from "../../infrastructure/bootstrap/bootstrap-spec-ports.js";
import { detectBootstrapEligibility } from "../../infrastructure/bootstrap/bootstrap-detector.js";
import { extractExplicitStackChoice } from "../../infrastructure/bootstrap/readme-intent.js";
import { parseEnvFile } from "../../interfaces/http/ui-port-store.js";
import { architectureWaveFs, architectureWavePorts } from "../quality/architecture-adapters.js";
import { resolveModelForTier } from "../quality/adapters.js";
import { appendLogLine } from "../loop/adapters.js";

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

/**
 * `compound-init`: profilio detekcija plius `writeTextIfMissing` semantika.
 *
 * Sprendimą „ar rašyti" priima ADAPTERIS, nes tik jis mato failų sistemos lenktynes:
 * `exists`-tada-`write` pora tarp dviejų procesų perrašytų svetimą ką tik sukurtą failą.
 * `wx` rašymas tą lenktynę uždaro vienu sisteminiu kvietimu.
 */
export const compoundInitPorts: CompoundInitPorts = {
  ...profileDetectionPorts,
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  writeTextIfMissing: async (absolutePath, content, options): Promise<WriteState> => {
    if (options.overwrite) {
      const existed = await nodeFsAdapter.exists(absolutePath);
      await nodeFsAdapter.writeTextFile(absolutePath, content);
      return existed ? "overwritten" : "created";
    }
    return (await nodeFsAdapter.writeFileExclusive(absolutePath, content)) === "created" ? "created" : "skipped";
  },
};

/**
 * Rekursyvi untracked įrašo kopija į snapshot katalogą.
 *
 * `wx`: snapshot'as NIEKADA neperrašo to, kas jame jau guli — pakartotinis rollback'as antrą
 * kartą nufotografuotų jau atkurtą (t. y. pasikeitusią) būseną ir sunaikintų vienintelį
 * originalo pėdsaką. Kopijuojamas TIK turinys: symlink'ai ir socket'ai praleidžiami, nes
 * snapshot'as saugo darbą, o ne failų sistemos nuorodas.
 */
async function snapshotCopy(source: string, destination: string): Promise<void> {
  const kind = await nodeFsAdapter.statKind(source);
  if (kind === "directory") {
    for (const name of await nodeFsAdapter.listDirectory(source)) {
      await snapshotCopy(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  if (kind !== "file") return;
  await nodeFsAdapter.makeDirectory(path.dirname(destination));
  await nodeFsAdapter.writeFileExclusive(destination, await nodeFsAdapter.readTextFile(source));
}

/** Ar `1`/`true`; bet kokia kita reikšmė (ir nesama) — „ne". */
function isEnabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * `vq/config/commands.env` turinys SINCHRONIŠKAI.
 *
 * Sinchroniškai, nes `rollbackStablePorts` yra sinchroninis konstruktorius, o `cleanUntracked`
 * porte yra reikšmė, ne funkcija (`interfaces/cli/bootstrap/rollback-stable.ts`). Neperskaitytas
 * failas duoda `undefined`, o ne klaidą: nesamas operatoriaus konfigas reiškia „nieko neįjungta",
 * ir atkūrimo kelias dėl jo negriūva.
 */
function readCommandsEnvSync(runtimeRoot: string): string | undefined {
  try {
    return readFileSync(path.join(runtimeRoot, "config", "commands.env"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * `AG_ROLLBACK_CLEAN` — ar po reset'o šalinti untracked failus.
 *
 * Default'as NE: `git clean -fd` naikina ir tai, ko niekas nefotografavo. Įjungiama tik
 * eksplicitiškai, ir tik reikšme `1`/`true` — bet kokia kita reikšmė laikoma „ne".
 *
 * Du šaltiniai, aplinka PIRMA: šablonas `templates/vq/config/commands.env` šį raktą vežė nuo
 * pradžių („set to 1"), bet iki šiol jį skaitė tik `process.env`, tad operatoriaus įrašas faile
 * nedarė NIEKO. TUŠČIA env reikšmė laikoma nenustatyta ir leidžia nuspręsti failui — kitaip
 * `AG_ROLLBACK_CLEAN=` shell'e tyliai anuliuotų konfigą.
 */
export function rollbackCleanUntracked(env: NodeJS.ProcessEnv = process.env, commandsEnvText?: string): boolean {
  const fromEnv = env["AG_ROLLBACK_CLEAN"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return isEnabled(fromEnv);
  return isEnabled(parseEnvFile(commandsEnvText ?? "")["AG_ROLLBACK_CLEAN"]);
}

/** `rollback-stable`: git, failai, untracked snapshot'as ir task scope atkūrimas. */
export function rollbackStablePorts(runtimeRoot: string, env: NodeJS.ProcessEnv = process.env): RollbackStablePorts {
  const agRoot = path.join(path.dirname(runtimeRoot), "AG");
  return {
    ensureDirs: () => ensureRuntimeDirs(agRoot, runtimeRoot),
    isGitRepository: (projectRoot) => isGitRepository(projectRoot),
    gitCommitExists: (ref, projectRoot) => gitCommitExists(ref, projectRoot),
    gitHead: (projectRoot) => gitHead(projectRoot),
    gitStatus: (projectRoot) => gitStatus(projectRoot),
    runGit: async (args, projectRoot): Promise<RollbackCommandResult> => {
      const result = await run("git", ["-C", projectRoot, ...args], { cwd: projectRoot });
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
    appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
    makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
    copyPath: (source, destination) => snapshotCopy(source, destination),
    taskScopePaths: () => readTaskScopePaths(runtimeRoot, env),
    detectPushedRollback: (projectRoot, ref) => detectPushedRollback(projectRoot, ref),
    committedTaskWorkSince: (projectRoot, baseRef, paths) => committedTaskWorkSince(projectRoot, baseRef, paths),
    restoreTaskScope: async (projectRoot, ref, paths): Promise<TaskScopeRestoreOutcome> =>
      await restoreTaskScope(projectRoot, ref, paths),
    agLog: (line) => appendLogLine(runtimeRoot, "orchestrator.log", line),
    cleanUntracked: rollbackCleanUntracked(env, readCommandsEnvSync(runtimeRoot)),
  };
}

/**
 * `bootstrap-project`: README intencija, architektūros grafas, tinkamumo detekcija ir eilės
 * sintezė.
 *
 * `writeQueueTaskIfMissing` naudoja `wx`: bootstrap'as gali būti paleistas ne kartą, ir
 * pakartotinis bėgimas NIEKADA neperrašo eilėje jau gulinčio (galbūt jau redaguoto ar net
 * pradėto) task'o. Grąžinama `false` yra normali baigtis, ne klaida.
 */
export function bootstrapProjectPorts(projectRoot: string, runtimeRoot: string): BootstrapProjectPorts {
  return {
    spec: createBootstrapSpecPorts({ runtimeRoot }),
    fs: architectureWaveFs(projectRoot),
    updateNodeProgress: (progressPath, nodeId, update, clearFields) =>
      architectureWavePorts(projectRoot).updateNodeProgress(progressPath, nodeId, update, clearFields),
    detectEligibility: (root) => detectBootstrapEligibility(root),
    // Application `ProductIntentSection.heading` yra OPCIONALUS, infra `ReadmeSection.heading` —
    // privalomas. Sekcijos be antraštės čia praleidžiamos, ir tai ne apkarpymas: stack sekcija
    // atpažįstama BŪTENT pagal antraštę (`## Stack`), tad beantraštė sekcija ja būti negali.
    extractExplicitStackChoice: (intent) =>
      extractExplicitStackChoice({
        kind: "intent",
        ...(intent.title === undefined ? {} : { title: intent.title }),
        sections: intent.sections.flatMap((section) =>
          section.heading === undefined ? [] : [{ ...section, heading: section.heading }],
        ),
      }),
    resolveModel: (tier) => resolveModelForTier(runtimeRoot, tier),
    writeQueueTaskIfMissing: async (absolutePath, markdown) =>
      (await nodeFsAdapter.writeFileExclusive(absolutePath, markdown)) === "created",
  };
}
