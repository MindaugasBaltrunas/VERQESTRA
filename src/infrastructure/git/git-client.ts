// Git skaitymo/užklausų klientas (etalonas: AG_loop core/git.ts) + E3 portų tiekėjai:
// currentAgCommit (suite-report-view/release-proof freshness), gitLogNumstat ir
// gitStatusPorcelain (ReliabilityPorts kontraktas 1:1).

import path from "node:path";
import { run, runWithInput } from "../process/run-process.js";

export type GitExecutor = (args: string[], root: string) => Promise<{ code: number; stdout: string }>;

const executeGit: GitExecutor = async (args, root) => await run("git", ["-C", root, ...args], { cwd: root });

/**
 * Kelių sąrašo dalijimas į git argv dalis. Windows `CreateProcess` komandinė eilutė ribota
 * (~32K simbolių), tad vienas `git add -- <keliai>` su šimtais kelių miršta
 * `spawn ENAMETOOLONG` ir nusineša visą Stop hook'o commit'ą. Biudžetas gerokai žemiau OS
 * ribos. `git check-ignore` dalijimo nenaudoja — keliai eina per `--stdin`.
 */
export const GIT_PATH_BATCH_MAX_PATHS = 50;
export const GIT_PATH_BATCH_MAX_CHARS = 4000;

export type GitPathBatchLimits = {
  maxPaths?: number;
  maxChars?: number;
};

/**
 * Skaido kelių sąrašą į dalis, telpančias į vieną git kvietimą. Tuščias sąrašas duoda
 * VIENĄ tuščią dalį (kvietimų skaičius nekinta). Kelias, vienas viršijantis simbolių
 * biudžetą, keliauja į savo dalį — niekada nepraleidžiamas. Tvarka išsaugoma.
 */
export function chunkPathArguments(paths: readonly string[], limits: GitPathBatchLimits = {}): string[][] {
  const maxPaths = Math.max(1, limits.maxPaths ?? GIT_PATH_BATCH_MAX_PATHS);
  const maxChars = Math.max(1, limits.maxChars ?? GIT_PATH_BATCH_MAX_CHARS);
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;

  for (const candidate of paths) {
    const cost = candidate.length + 1;
    if (current.length > 0 && (current.length >= maxPaths || chars + cost > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(candidate);
    chars += cost;
  }

  batches.push(current);
  return batches;
}

// Poaibis failų, kuriuos git ignoruoja — jie negali patekti į commit'ą, tad secret
// scan'ui tai lokalūs kredencialai, o ne nutekėjimo rizika.
export async function filterGitIgnored(files: string[], root = process.cwd()): Promise<Set<string>> {
  // Absoliutūs keliai išmetami iš anksto — check-ignore ant kelio už repo ribų miršta
  // fatal'u ir išjungtų visą filtrą.
  const candidates = files.filter((file) => file && !path.isAbsolute(file) && !/^[A-Za-z]:[\\/]/.test(file));
  if (candidates.length === 0) {
    return new Set();
  }
  const result = await runWithInput("git", ["-C", root, "check-ignore", "--stdin"], `${candidates.join("\n")}\n`, root);
  // exit 0 = bent vienas ignoruojamas, 1 = nė vieno; kita = klaida (saugiai: nieko neskipinam)
  if (result.code !== 0 && result.code !== 1) {
    return new Set();
  }
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

export async function gitStatus(root = process.cwd()): Promise<string> {
  // --untracked-files=all: išvardinti atskirus failus naujuose untracked kataloguose.
  const result = await run("git", ["-C", root, "status", "--short", "--untracked-files=all"], { cwd: root });
  return result.code === 0 ? result.stdout.trimEnd() : "";
}

/** ReliabilityPorts.gitStatusPorcelain tiekėjas: `undefined` — git neprieinamas. */
export async function gitStatusPorcelain(root = process.cwd()): Promise<string | undefined> {
  const result = await run("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { cwd: root });
  return result.code === 0 ? result.stdout : undefined;
}

/** ReliabilityPorts.gitLog tiekėjas: file-activity parserio laukiama forma 1:1. */
export async function gitLogNumstat(root = process.cwd(), sinceDays = 90): Promise<string | undefined> {
  const result = await run(
    "git",
    ["-C", root, "log", `--since=${sinceDays}.days`, "--date=iso-strict", "--pretty=format:@@%H|%aI|%s", "--name-status", "--no-merges"],
    { cwd: root },
  );
  return result.code === 0 ? result.stdout : undefined;
}

export async function gitHead(root = process.cwd(), execute: GitExecutor = executeGit): Promise<string | undefined> {
  const result = await execute(["rev-parse", "HEAD"], root);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** `currentAgCommit` resolveris freshness portams (suite-report-view, release-proof). */
export async function currentCommitResolver(projectRoot: string): Promise<string | undefined> {
  return await gitHead(projectRoot);
}

export async function gitHashObject(filePath: string, root = process.cwd()): Promise<string | undefined> {
  const result = await run("git", ["-C", root, "hash-object", filePath], { cwd: root });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function isGitRepository(root = process.cwd()): Promise<boolean> {
  const result = await run("git", ["-C", root, "rev-parse", "--git-dir"], { cwd: root });
  return result.code === 0;
}

export async function gitCommitExists(ref: string, root = process.cwd()): Promise<boolean> {
  const result = await run("git", ["-C", root, "rev-parse", "--verify", `${ref}^{commit}`], { cwd: root });
  return result.code === 0;
}

// Ref (šakos, tag'o) buvimas: tikrina PATĮ ref'ą, ne jo taikinį.
export async function gitRefExists(ref: string, root = process.cwd()): Promise<boolean> {
  const result = await run("git", ["-C", root, "show-ref", "--verify", "--quiet", ref], { cwd: root });
  return result.code === 0;
}

// Ref → commit SHA, arba undefined, jei ref'o nėra.
export async function gitResolveCommit(ref: string, root = process.cwd()): Promise<string | undefined> {
  const result = await run("git", ["-C", root, "rev-parse", "--verify", `${ref}^{commit}`], { cwd: root });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

// Dabartinės šakos vardas; tuščias detached HEAD atveju arba kai git komanda nepavyko.
export async function gitCurrentBranch(root = process.cwd()): Promise<string> {
  const result = await run("git", ["-C", root, "branch", "--show-current"], { cwd: root });
  return result.code === 0 ? result.stdout.trim() : "";
}

// Commit'o paliesti repo-relative keliai. undefined = git komanda nepavyko — tai nėra
// „commit'as nepalietė nė vieno failo".
export async function gitCommitFiles(sha: string, root = process.cwd()): Promise<string[] | undefined> {
  const result = await run("git", ["-C", root, "show", "--name-only", "--pretty=format:", sha], { cwd: root });
  if (result.code !== 0) {
    return undefined;
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// Commit'ai nuo ref iki HEAD — diagnozės įrodymas, kad darbas jau užcommitintas.
export async function gitLogSince(ref: string | undefined, root = process.cwd(), maxCount = 20): Promise<string> {
  if (!ref || !(await gitCommitExists(ref, root))) {
    return "";
  }
  const result = await run("git", ["-C", root, "log", "--oneline", `--max-count=${maxCount}`, `${ref}..HEAD`], { cwd: root });
  return result.code === 0 ? result.stdout.trimEnd() : "";
}

export async function hasNewHeadSince(ref: string | undefined, root = process.cwd()): Promise<boolean> {
  if (!ref) {
    return false;
  }

  const head = await gitHead(root);
  return Boolean(head && head !== ref);
}

// Vienas linked worktree, kaip jį aprašo `git worktree list --porcelain`. Laukai atspindi
// porcelain eilutes 1:1 — jokios interpretacijos: sprendimą priima worktree lifecycle (2/2).
export type GitWorktreeEntry = {
  /** Absoliutus kelias, kaip jį grąžina git (normalizuotas į OS separatorius). */
  path: string;
  head?: string;
  /** Pilnas ref (`refs/heads/x`), arba undefined kai HEAD detached. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lock_reason?: string;
  /** git mano, kad įrašas nebegalioja (dingęs katalogas ir pan.). */
  prunable: boolean;
  prunable_reason?: string;
};

// `--porcelain`: įrašai atskirti tuščia eilute, kiekviena eilutė — `raktas [reikšmė]`.
// Parse'as grynas ir eksportuojamas atskirai — būtent jį verta testuoti be realaus git.
export function parseWorktreePorcelain(stdout: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }

    const separator = line.indexOf(" ");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).trim();

    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: path.normalize(value), detached: false, bare: false, locked: false, prunable: false };
      continue;
    }
    if (!current) continue;

    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") {
      current.locked = true;
      if (value) current.lock_reason = value;
    } else if (key === "prunable") {
      current.prunable = true;
      if (value) current.prunable_reason = value;
    }
  }

  if (current) entries.push(current);
  return entries;
}

// Registruoti worktree'ai. Nesėkmė grąžina tuščią sąrašą — kvietėjas elgiasi, tarsi
// izoliuotų kopijų nebūtų, ir niekada nesikreipia į nepatikrintą kelią.
export async function gitWorktreeList(root = process.cwd(), execute: GitExecutor = executeGit): Promise<GitWorktreeEntry[]> {
  const result = await execute(["worktree", "list", "--porcelain"], root);
  return result.code === 0 ? parseWorktreePorcelain(result.stdout) : [];
}

// `runGitPlan` PAŠALINTAS 2026-08-24 (audito patikra). Jis vykdė `GitCommandPlan`, kurį sudarydavo
// `application/scheduling/worktree-policy` planuoklis — o tas planuoklis tą pačią dieną buvo
// ištrintas kaip pakeistas aktyviu keliu (`infrastructure/git/worktrees` argumentus statosi pats).
// Vykdytojas liko be nė vieno kvietėjo, tad kartu miršta ir pats `GitCommandPlan` tipas.
//
// PAMOKA: tada `GitCommandPlan` palikau PAGRINDĘS tuo, kad „jį naudoja `runGitPlan`" — ir
// nepatikrinau, ar `runGitPlan` pats turi kvietėjų. Grandinė nutraukta vienu nariu per anksti;
// „turi vartotoją" galioja tik tada, kai tas vartotojas pats gyvas.
