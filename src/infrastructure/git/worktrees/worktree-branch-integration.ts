// Worker'io sesijos šakos integracija į pirminę šaką TAME PAČIAME medyje ir šakos
// šalinimas po integracijos (etalonas: AG_loop worktree-branch-integration.ts, task 1226).
// VIENINTELĖ vieta, kuri pirminę šaką stumia PIRMYN — fast-forward arba merge commit'u,
// lokaliai ir tik ant švaraus medžio. Destruktyvių primityvų ir remote maršrutų nėra.

import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { run, type CommandResult } from "../../process/run-process.js";
import { nodeFsAdapter } from "../../fs/node-fs-adapter.js";
import {
  gitCurrentBranch,
  gitRefExists,
  gitResolveCommit,
  isGitRepository,
} from "../git-client.js";
import { nonRuntimeDirtyPaths } from "../integration-branch.js";

/**
 * `index.lock` kontencijos retry numatytieji. Pirminiame medyje git'ą lygiagrečiai naudoja
 * primary-tree slot'o sesija (stop hook commit'ai) — jos lock'as gyvena sekundes, o parkintas
 * task'as be retry kainuoja žmogaus peržiūrą (GeoGravity 2026-08-31: 1132/1154-b-03/1156 visi
 * trys parkinti per vieną index.lock langą ir atstatyti tik rankiniu unpark'u).
 */
export const INDEX_LOCK_RETRY_DEFAULTS = { attempts: 5, delayMs: 3_000 } as const;

/** Ar pirminio medžio `.git/index.lock` yra DABAR — faktinis kontencijos liudininkas. */
async function indexLockPresent(projectRoot: string): Promise<boolean> {
  return nodeFsAdapter.exists(path.join(projectRoot, ".git", "index.lock"));
}

/**
 * Ar nepavykęs merge atrodo kaip laikina `index.lock` kontencija. Pirmenybė FAKTUI (lock
 * failas egzistuoja patikros akimirką); teksto atpažinimas lieka kaip liudininkas atvejui,
 * kai kitas procesas lock'ą jau paleido — klaidingai teigiamas atsakymas kainuoja vieną
 * `delayMs` palaukimą, klaidingai neigiamas — parkintą task'ą.
 */
async function looksLikeIndexLockContention(projectRoot: string, failed: CommandResult): Promise<boolean> {
  if (await indexLockPresent(projectRoot)) return true;
  return /index\.lock/i.test(`${failed.stdout}\n${failed.stderr}`);
}

async function git(root: string, args: string[]): Promise<CommandResult> {
  return await run("git", ["-C", root, ...args], { cwd: root });
}

function gitFailure(result: CommandResult, args: readonly string[]): string {
  return `git ${args.join(" ")} failed (code ${result.code}): ${(result.stderr || result.stdout).trim()}`;
}

async function unmergedPaths(worktreePath: string): Promise<string[]> {
  const result = await git(worktreePath, ["ls-files", "--unmerged"]);
  if (result.code !== 0) return [];
  return [
    ...new Set(
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.split("\t")[1]?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();
}

/** Trailer'is, kuriuo integracinis merge commit'as neša savo sesijos šaką. */
export const WORKTREE_INTEGRATION_TRAILER = "AG-Worker-Branch";

export type WorktreeIntegrationRefusal =
  /** Pirminis medis yra detached HEAD — neaišku, į kurią šaką integruoti. */
  | "detached-head"
  /** Pirminiame medyje yra neužcommitinto (ne runtime) darbo, kurį merge perrašytų. */
  | "dirty-primary-tree";

export type WorktreeIntegrationResult =
  | { status: "integrated"; branch: string; into: string; mode: "fast-forward" | "merge-commit"; head: string }
  /** Šakos viršūnė jau pasiekiama iš pirminės šakos — pakartotinis kvietimas nieko nekeičia. */
  | { status: "already-integrated"; branch: string; into: string; head: string }
  /** Šakos nebėra: integracija jau įvyko ir po jos šaka pašalinta. */
  | { status: "absent"; branch: string }
  /** Turinys susikirto. Medis atsuktas (`merge --abort`), sprendimą priima žmogus. */
  | { status: "conflict"; branch: string; into: string; paths: string[] }
  | { status: "refused"; branch: string; reason: WorktreeIntegrationRefusal; detail: string }
  | { status: "infrastructure"; message: string };

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(root, ["merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
}

/** Ar medyje yra nebaigtas merge. Naudojama tik tam, kad `--abort` būtų kviečiamas turint ką atsukti. */
async function mergeInProgress(root: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).code === 0;
}

/**
 * Sulieja worker'io sesijos šaką į pirminę šaką TAME PAČIAME medyje.
 *
 * Kodėl realus `git merge`, o ne integration-branch plumbing grandinė: ten taikinys yra
 * ATSKIRAS verifikacijos ref'as, tad darbinio medžio liesti nereikia. Čia taikinys yra
 * pati pirminė šaka, kurią loop'as turi checkout'intą — ref'o pastūmimas be indekso ir
 * medžio atnaujinimo paliktų medį rodantį seną turinį.
 */
export async function integrateWorktreeBranch(input: {
  projectRoot: string;
  branch: string;
  /** Įrašomas į merge commit'o žinutę. Tik telemetrija — sprendimų nekeičia. */
  taskId?: string;
  /** `index.lock` kontencijos retry politika; testams — trumpesni intervalai. */
  indexLockRetry?: { attempts: number; delayMs: number };
}): Promise<WorktreeIntegrationResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const { branch } = input;
  const ref = `refs/heads/${branch}`;

  if (!(await isGitRepository(projectRoot))) {
    return { status: "infrastructure", message: `${projectRoot} is not a git repository` };
  }
  if (!(await gitRefExists(ref, projectRoot))) return { status: "absent", branch };

  const into = await gitCurrentBranch(projectRoot);
  if (!into) {
    return {
      status: "refused",
      branch,
      reason: "detached-head",
      detail: `${projectRoot} nestovi ant šakos — nėra taikinio, į kurį integruoti ${branch}`,
    };
  }

  const branchHead = await gitResolveCommit(ref, projectRoot);
  const primaryHead = await gitResolveCommit(into, projectRoot);
  if (!branchHead || !primaryHead) {
    return { status: "infrastructure", message: `cannot resolve ${branch} / ${into} to commits in ${projectRoot}` };
  }

  // Idempotencijos vartas PRIEŠ bet kokį medžio judesį: pakartotinis kvietimas po
  // restart'o negali sukurti antro tuščio merge commit'o.
  if (await isAncestor(projectRoot, branchHead, primaryHead)) {
    return { status: "already-integrated", branch, into, head: primaryHead };
  }

  // Merge rašo į indeksą ir medį, tad neužcommit'intas svetimas darbas būtų perrašytas.
  const dirty = await nonRuntimeDirtyPaths(projectRoot);
  if (dirty.length > 0) {
    return {
      status: "refused",
      branch,
      reason: "dirty-primary-tree",
      detail: dirty.slice(0, 10).join(", "),
    };
  }

  const message = [
    `integrate ${branch}`,
    "",
    ...(input.taskId ? [`AG-Worker-Task: ${input.taskId}`] : []),
    `${WORKTREE_INTEGRATION_TRAILER}: ${branch}`,
  ].join("\n");
  const mergeArgs = ["merge", "--no-ff", "--no-edit", "-m", message, ref];
  const retry = input.indexLockRetry ?? INDEX_LOCK_RETRY_DEFAULTS;

  // Bandymų ciklas dengia TIK laikiną `index.lock` kontenciją: turinio konfliktas ir tikros
  // infrastruktūros klaidos iš ciklo išeina pirmu bandymu, kaip ir anksčiau.
  for (let attempt = 1; ; attempt++) {
    // `--ff-only` atmetamas PRIEŠ liečiant medį, kai fast-forward neįmanomas — pirma pigus
    // ir be commit'o, tik paskui merge commit'as.
    const fastForward = await git(projectRoot, ["merge", "--ff-only", ref]);
    if (fastForward.code === 0) {
      return {
        status: "integrated",
        branch,
        into,
        mode: "fast-forward",
        head: (await gitResolveCommit(into, projectRoot)) ?? branchHead,
      };
    }

    const merged = await git(projectRoot, mergeArgs);
    if (merged.code === 0) {
      return {
        status: "integrated",
        branch,
        into,
        mode: "merge-commit",
        head: (await gitResolveCommit(into, projectRoot)) ?? branchHead,
      };
    }

    // Nesėkmė turi DVI skirtingas prasmes, ir jas skiria būtent nesulieti keliai: turinio
    // konfliktas (žmogaus sprendimas) prieš git/FS lygio klaidą (merge net neprasidėjo).
    const conflicts = await unmergedPaths(projectRoot);
    if (await mergeInProgress(projectRoot)) await git(projectRoot, ["merge", "--abort"]);
    if (conflicts.length > 0) return { status: "conflict", branch, into, paths: conflicts };

    if (attempt >= retry.attempts || !(await looksLikeIndexLockContention(projectRoot, merged))) {
      return { status: "infrastructure", message: gitFailure(merged, mergeArgs) };
    }
    // Lock'ą laiko trumpa lygiagreti git operacija (primary-tree slot'o stop hook commit) —
    // palaukiama ir bandoma iš naujo vietoj parkinimo.
    await sleep(retry.delayMs);
  }
}

export type DeleteWorktreeBranchResult =
  | { status: "deleted"; branch: string }
  | { status: "absent"; branch: string }
  /** Šakoje liko darbo, kurio pirminėje šakoje nėra. `-D` niekada nenaudojamas. */
  | { status: "unmerged"; branch: string; detail: string }
  | { status: "infrastructure"; message: string };

/**
 * Pašalina sesijos šaką PO integracijos. Naudojamas tik `git branch -d`: git pats
 * atsisako trinti nesulietą šaką, ir tas atsisakymas yra reikalinga savybė. Neišspręstas
 * atvejis grąžinamas įvardytas ir šaka lieka diske.
 */
export async function deleteWorktreeBranch(input: {
  projectRoot: string;
  branch: string;
}): Promise<DeleteWorktreeBranchResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const { branch } = input;
  const ref = `refs/heads/${branch}`;

  if (!(await isGitRepository(projectRoot))) {
    return { status: "infrastructure", message: `${projectRoot} is not a git repository` };
  }
  if (!(await gitRefExists(ref, projectRoot))) return { status: "absent", branch };

  const args = ["branch", "-d", branch];
  const deleted = await git(projectRoot, args);
  if (deleted.code === 0) return { status: "deleted", branch };

  // Atsisakymo priežastis nustatoma FAKTU, ne git teksto atpažinimu: jei šakos viršūnė
  // nėra pasiekiama iš HEAD, joje tikrai liko neintegruoto darbo.
  const branchHead = await gitResolveCommit(ref, projectRoot);
  const head = await gitResolveCommit("HEAD", projectRoot);
  if (branchHead && head && !(await isAncestor(projectRoot, branchHead, head))) {
    return { status: "unmerged", branch, detail: gitFailure(deleted, args) };
  }
  return { status: "infrastructure", message: gitFailure(deleted, args) };
}
