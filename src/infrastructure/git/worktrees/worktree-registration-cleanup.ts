// Git worktree registracijų valymas: pašalina negyvas `.git/worktrees/<name>/` registracijas ir
// jose likusius pasenusius `index.lock` failus (GeoGravity 1179 — pakibęs lock negyvoje
// registracijoje blokuoja kiekvieną vėlesnę vaiko git operaciją su
// `fatal: Unable to create '.git/worktrees/<name>/index.lock': File exists`).
//
// `git worktree prune` pats registraciją išvalo, bet nepaliečia `index.lock`, jei jis dar
// egzistuoja prune metu — todėl lock'as šalinamas PRIEŠ prune.
//
// Amžiaus semantika kartoja `clearStaleIndexLock` (`../git-automation.ts`): šviežias lock — gyvo
// git proceso žymė, paliekamas; senesnis už slenkstį — nulūžusio proceso palikimas. GYVOS
// registracijos (worktree katalogas tebeegzistuoja) lock'as niekada neliečiamas — konkuruojantis
// gyvos kopijos procesas yra kito sluoksnio problema (žr. task'o „Neįtraukta").
//
// Niekada nemeta: nepavykęs valymas grąžinamas kaip rezultato laukas, o ne throw.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { run, type CommandResult } from "../../process/run-process.js";

type GitRunner = typeof run;

/** Ta pati reikšmė ir idėja kaip `STALE_INDEX_LOCK_MS` (`../git-automation.ts`). */
const STALE_INDEX_LOCK_MS = 5_000;

export type WorktreeRegistrationCleanupInput = {
  projectRoot: string;
  runner?: GitRunner;
  now?: Date;
};

export type WorktreeRegistrationCleanupResult = {
  deadRegistrations: string[];
  removedLocks: string[];
  pruneResult: CommandResult;
  error?: string;
};

/** Registracijos vardas gyva, jei jos `gitdir` failas rodo į tebeegzistuojantį kelią. */
function isDeadRegistration(registrationDir: string): boolean {
  const gitdirFile = path.join(registrationDir, "gitdir");
  if (!existsSync(gitdirFile)) return false;
  const target = readFileSync(gitdirFile, "utf8").trim();
  if (target === "") return false;
  return !existsSync(target);
}

/** True tik kai realiai pasenęs lock'as pašalintas. */
function removeStaleLock(registrationDir: string, now: Date): boolean {
  const lockPath = path.join(registrationDir, "index.lock");
  if (!existsSync(lockPath)) return false;
  if (now.getTime() - statSync(lockPath).mtimeMs < STALE_INDEX_LOCK_MS) return false;
  rmSync(lockPath, { force: true });
  return true;
}

function scanRegistrations(
  worktreesDir: string,
  now: Date,
): { deadRegistrations: string[]; removedLocks: string[] } {
  const deadRegistrations: string[] = [];
  const removedLocks: string[] = [];
  if (!existsSync(worktreesDir)) {
    return { deadRegistrations, removedLocks };
  }
  for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const registrationDir = path.join(worktreesDir, entry.name);
    if (!isDeadRegistration(registrationDir)) continue;
    deadRegistrations.push(entry.name);
    if (removeStaleLock(registrationDir, now)) {
      removedLocks.push(entry.name);
    }
  }
  return { deadRegistrations, removedLocks };
}

/**
 * Suranda negyvas `.git/worktrees/<name>/` registracijas, pašalina jose likusį pasenusį
 * `index.lock` ir paleidžia `git worktree prune`.
 */
export async function cleanupWorktreeRegistrations(
  input: WorktreeRegistrationCleanupInput,
): Promise<WorktreeRegistrationCleanupResult> {
  const runner = input.runner ?? run;
  const now = input.now ?? new Date();
  const worktreesDir = path.join(path.resolve(input.projectRoot), ".git", "worktrees");

  let scan: { deadRegistrations: string[]; removedLocks: string[] };
  let error: string | undefined;
  try {
    scan = scanRegistrations(worktreesDir, now);
  } catch (caught: unknown) {
    scan = { deadRegistrations: [], removedLocks: [] };
    error = caught instanceof Error ? caught.message : String(caught);
  }

  let pruneResult: CommandResult;
  try {
    pruneResult = await runner("git", ["-C", input.projectRoot, "worktree", "prune"], {
      cwd: input.projectRoot,
    });
  } catch (caught: unknown) {
    pruneResult = {
      code: -1,
      stdout: "",
      stderr: caught instanceof Error ? caught.message : String(caught),
    };
  }

  return {
    ...scan,
    pruneResult,
    ...(error !== undefined ? { error } : {}),
  };
}
