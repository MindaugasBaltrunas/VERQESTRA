// Guard hook'ų portų surišimas (VQ-504 65/N: VQ-502 paliktas wiring'as).
//
// Šeši guard'ai — secret-scan, package, migration, backend, frontend, mobile — dalijasi beveik
// tuo pačiu portų rinkiniu, tad jie surišami vienu pjūviu. Skirtis, kurią verta laikyti galvoje:
// PostToolUse režime NĖ VIENAS jų neblokuoja (grąžina 0 net radę problemų), o `stop` režime
// blokuoja secret-scan ir scope guard'ai. Adapteris to nesprendžia — jis tik tiekia įrodymus.
//
// Visi git skaitymai čia yra „nežinia = tuščia": `git diff` klaida virsta tuščiu sąrašu, o ne
// išimtimi. Priežastis viena visiems — guard'as, krentantis dėl savo telemetrijos, blokuotų
// darbą tada, kai apie patį darbą nieko nežino.

import path from "node:path";
import { loadSecurityPolicy } from "../application/policy-governance/security-spec-policies.js";
import { resolveGuardRootPaths, type GuardRootKey } from "../domain/project/guard-roots.js";
import type { ChangedFile } from "../domain/git/changes.js";
import { collectChangedFiles, collectChangedFilesWithStatus } from "../infrastructure/git/changed-files.js";
import { filterGitIgnored, isGitRepository } from "../infrastructure/git/git-client.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { commandExists, run, runShell } from "../infrastructure/process/run-process.js";
import type { PackageGuardPorts, PackageGuardProfileView } from "../interfaces/hooks/package-guard.js";
import type { MigrationGuardPorts } from "../interfaces/hooks/migration-guard.js";
import type { PostWriteGuardPorts } from "../interfaces/hooks/post-write-guards.js";
import type { ScopeGuardPorts, ShellCommandResult } from "../interfaces/hooks/scope-guards.js";
import type { SecretScanPorts } from "../interfaces/hooks/secret-scan.js";
import type { HookFsPort } from "../interfaces/hooks/protocol.js";
import { tryParseJson } from "../shared/json.js";
import { policyConfigFs } from "./node-adapters.js";
import { cliEntryPath, PROJECT_DIR_ENV } from "./runtime-context.js";

/** Guard'ams pakanka to paties siauro fs porto kaip hook protokolui. */
const guardFs: HookFsPort = {
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
  appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
};

/** Profilio vaizdas guard'ams: package manager, kalba ir source roots vienu skaitymu. */
type GuardProfileView = PackageGuardProfileView & { source_roots?: string[] | undefined };

async function loadGuardProfile(runtimeRoot: string): Promise<GuardProfileView | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "project", "profile.json"));
  if (raw === undefined) return undefined;
  const parsed = tryParseJson<GuardProfileView>(raw);
  return parsed.ok && parsed.value !== null && typeof parsed.value === "object" ? parsed.value : undefined;
}

/**
 * `no_secrets_in_repo` reikšmė. BET KOKS gedimas — nesamas, sugadintas ar schemos neatitinkantis
 * politikos failas — reiškia SKENUOTI (PC-SEC-01).
 *
 * Kryptis priešinga įprastam „trūkstamas konfigas = numatytieji": čia numatytasis yra griežtesnis
 * variantas, nes vienintelis būdas skenavimą išjungti privalo būti EKSPLICITINIS
 * `no_secrets_in_repo: false`. Priešingu atveju ištrintas politikos failas tyliai atrakintų repo
 * kredencialams.
 */
async function secretScanEnabled(runtimeRoot: string): Promise<boolean> {
  try {
    return (await loadSecurityPolicy(policyConfigFs, runtimeRoot)).no_secrets_in_repo;
  } catch {
    return true;
  }
}

/**
 * `git diff` eilutės šakniniam ir workspace package.json failams.
 *
 * Pathspec'as paduodamas ARGUMENTAIS, ne shell eilute: jame yra glob simbolis, o shell'as jį
 * išskleistų pagal darbinį katalogą, ne pagal git indeksą.
 */
async function packageJsonDiffLines(projectRoot: string): Promise<string[]> {
  if (!(await isGitRepository(projectRoot))) return [];
  const result = await run("git", ["-C", projectRoot, "diff", "--", "package.json", "*/package.json"], {
    cwd: projectRoot,
  });
  return result.code === 0 ? result.stdout.split(/\r?\n/) : [];
}

/** `git diff --cached --name-status` eilutės; ne git repo arba klaida → tuščia. */
async function stagedNameStatusLines(projectRoot: string): Promise<string[]> {
  if (!(await isGitRepository(projectRoot))) return [];
  const result = await run("git", ["-C", projectRoot, "diff", "--cached", "--name-status"], { cwd: projectRoot });
  return result.code === 0 ? result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0) : [];
}

async function guardRoots(runtimeRoot: string): Promise<Record<GuardRootKey, string>> {
  return resolveGuardRootPaths((await loadGuardProfile(runtimeRoot))?.source_roots);
}

/** `secret-scan` portai. */
export function secretScanPorts(runtimeRoot: string): SecretScanPorts {
  return {
    fs: guardFs,
    collectChangedFiles: (projectRoot) => collectChangedFiles(projectRoot, runtimeRoot),
    filterGitIgnored: (files, projectRoot) => filterGitIgnored([...files], projectRoot),
    secretScanEnabled: () => secretScanEnabled(runtimeRoot),
  };
}

/** `package-guard` portai. */
export function packageGuardPorts(runtimeRoot: string): PackageGuardPorts {
  return {
    fs: guardFs,
    collectChangedFilesWithStatus: (projectRoot): Promise<ChangedFile[]> =>
      collectChangedFilesWithStatus(projectRoot, runtimeRoot),
    loadProjectProfile: () => loadGuardProfile(runtimeRoot),
    isGitRepository: (projectRoot) => isGitRepository(projectRoot),
    packageJsonDiffLines: (projectRoot) => packageJsonDiffLines(projectRoot),
  };
}

/** `migration-guard` portai. */
export function migrationGuardPorts(runtimeRoot: string): MigrationGuardPorts {
  return {
    fs: guardFs,
    collectChangedFilesWithStatus: (projectRoot): Promise<ChangedFile[]> =>
      collectChangedFilesWithStatus(projectRoot, runtimeRoot),
    isGitRepository: (projectRoot) => isGitRepository(projectRoot),
    stagedNameStatusLines: (projectRoot) => stagedNameStatusLines(projectRoot),
    packageJsonDiffLines: (projectRoot) => packageJsonDiffLines(projectRoot),
  };
}

/**
 * `backend`/`frontend`/`mobile` guard'ų portai.
 *
 * `runShell` čia yra vienintelė vieta visame guard'ų rinkinyje, paleidžianti laisvos formos
 * komandą, ir ji gauna projekto šaknį kaip cwd. Pati komanda sudaroma interfaces sluoksnyje iš
 * SANITIZUOTO guard root (`resolveGuardRootPaths`), tad profilio redaguotojas negali jos
 * paversti injekcijos primityvu.
 */
/**
 * PostToolUse guard fan-out'o portai.
 *
 * Guard'as paleidžiamas ATSKIRU procesu, o ne kviečiamas funkcija: kiekvienas jų skaito savo
 * stdin ir turi savo exit kodo semantiką, o šeši tokie viename procese vienas kitam trukdytų.
 * Projekto šaknis keliauja per `CLAUDE_PROJECT_DIR`, nes vaikas savo cwd naudoja tik komandų
 * paleidimui — šaknį jis privalo gauti eksplicitiškai.
 *
 * Vaiko nesėkmė NIEKADA nekelia kvietėjo exit kodo: `runPostWriteGuards` jį tik įrašo į žurnalą.
 * Todėl ir čia neperduodama išimtis — nepaleistas guard'as grąžina non-zero kodą, o ne griūva.
 */
export function postWriteGuardPorts(runtimeRoot: string): PostWriteGuardPorts {
  return {
    fs: guardFs,
    guardRoots: () => guardRoots(runtimeRoot),
    runGuard: async (command, args, projectRoot) => {
      const result = await run(process.execPath, [cliEntryPath(), command, ...args], {
        cwd: projectRoot,
        env: { ...process.env, [PROJECT_DIR_ENV]: projectRoot },
      }).catch(() => undefined);
      return result?.code ?? 1;
    },
  };
}

export function scopeGuardPorts(runtimeRoot: string): ScopeGuardPorts {
  return {
    fs: guardFs,
    collectChangedFiles: (projectRoot) => collectChangedFiles(projectRoot, runtimeRoot),
    guardRoots: () => guardRoots(runtimeRoot),
    commandExists: (command) => commandExists(command),
    runShell: async (command, projectRoot): Promise<ShellCommandResult> => {
      const result = await runShell(command, projectRoot);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
  };
}
