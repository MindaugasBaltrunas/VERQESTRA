// Stop hook'o commit/push automatika (etalonas: AG_loop orchestrator/git/git-automation.ts):
// scoped staging batch'ais (task 890 + 0047), stale index.lock valymas, push be jokio force.

import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { run, type CommandResult } from "../process/run-process.js";
import { chunkPathArguments } from "./git-client.js";

export type CommitAndPushOptions = {
  push?: boolean;
  /**
   * Aiškus pathspec vietoj viso worktree. Stop hook'as paduoda session-scoped +
   * lifecycle aibę (task 890), tad lygiagrečios sesijos svetimi produkto edit'ai niekada
   * nesušluodami į šio task'o commit'ą. Praleidus — `git add --all` (tik kvietėjams,
   * kurie tikrai nori visko).
   */
  paths?: readonly string[];
};

export type CommitAndPushResult =
  | { ok: true; branch: string; commit: CommandResult; push?: CommandResult }
  | { ok: false; step: "add" | "commit" | "branch" | "push"; branch?: string; result: CommandResult };

type GitRunner = typeof run;

/**
 * Pasenęs `.git/index.lock` valomas tik kai senesnis už šį slenkstį. Gyvas
 * `git add`/`commit` lock'ą laiko milisekundes, tad senesnis — nulūžusio ar nužudyto git
 * proceso palikimas.
 */
const STALE_INDEX_LOCK_MS = 5_000;

/** True, kai git rezultatas lūžo dėl jau egzistuojančio `.git/index.lock`. */
function isIndexLockError(result: CommandResult): boolean {
  return result.code !== 0 && /index\.lock/i.test(`${result.stdout}${result.stderr}`);
}

/**
 * Pašalina pasenusį `.git/index.lock`. True tik kai realiai pasenęs lock'as pašalintas —
 * tikrai lygiagreti git operacija niekada netrikdoma.
 */
export function clearStaleIndexLock(projectRoot: string): boolean {
  const lockPath = path.join(projectRoot, ".git", "index.lock");
  if (!existsSync(lockPath)) {
    return false;
  }
  if (Date.now() - statSync(lockPath).mtimeMs < STALE_INDEX_LOCK_MS) {
    return false;
  }
  rmSync(lockPath, { force: true });
  return true;
}

/**
 * `git add` argv dalys. Su aiškiu `paths` — scoped `git add -- <keliai>` batch'ais
 * (task 0047: šimtai kelių sprogdino Windows komandinę eilutę su spawn ENAMETOOLONG);
 * be jo — vienas `git add --all`.
 */
function addArgBatches(projectRoot: string, paths?: readonly string[]): string[][] {
  const base = ["-C", projectRoot, "add"];
  if (!paths) {
    return [[...base, "--all"]];
  }
  return chunkPathArguments(paths).map((batch) => [...base, "--", ...batch]);
}

/**
 * Kelių `git add` kvietimų rezultatai sujungiami į vieną: išvestys konkatenuojamos kvietimo
 * tvarka, kodas lieka 0 (ne-nulinis kodas čia niekada nepasiekia — pirma nesėkmė grąžinama
 * nepaliesta).
 */
function mergeAddResults(results: readonly CommandResult[]): CommandResult {
  const merged: CommandResult = {
    code: 0,
    stdout: results.map((result) => result.stdout).join(""),
    stderr: results.map((result) => result.stderr).join(""),
  };
  if (results.some((result) => result.stdoutTruncated)) merged.stdoutTruncated = true;
  if (results.some((result) => result.stderrTruncated)) merged.stderrTruncated = true;
  return merged;
}

/**
 * Vykdo kiekvieną `git add` batch'ą iš eilės. Grąžinama reikšmė elgiasi kaip vienas
 * kvietimas: pirma nesėkmė stabdo seką ir grąžinama nepakeista (ankstesnių batch'ų
 * stage'inti keliai lieka — kaip dalinai pritaikytas vienas `git add`).
 */
async function runAddBatches(projectRoot: string, paths: readonly string[] | undefined, runner: GitRunner): Promise<CommandResult> {
  const batches = addArgBatches(projectRoot, paths);
  const results: CommandResult[] = [];
  for (const args of batches) {
    const result = await runner("git", args);
    if (result.code !== 0) {
      return result;
    }
    results.push(result);
  }
  const [first, ...rest] = results;
  return first && rest.length === 0 ? first : mergeAddResults(results);
}

/**
 * Stage'ina pathspec'ą ir paleidžia `git commit`. Jei commit lūžta dėl pasenusio
 * `index.lock`, lock'as išvalomas kartą ir add+commit pakartojami — kitaip likęs lock'as
 * tyliai blokuotų kiekvieną commit'ą ir baigtą darbą stumtų į human-review. Re-staging
 * saugus: `git add` ant jau stage'intų kelių idempotentiškas.
 */
async function addAndCommit(
  projectRoot: string,
  commitMessage: string,
  runner: GitRunner,
  paths?: readonly string[],
): Promise<{ step: "add" | "commit"; result: CommandResult }> {
  let add = await runAddBatches(projectRoot, paths, runner);
  if (isIndexLockError(add) && clearStaleIndexLock(projectRoot)) {
    add = await runAddBatches(projectRoot, paths, runner);
  }
  if (add.code !== 0) return { step: "add", result: add };

  let commit = await runner("git", ["-C", projectRoot, "commit", "-m", commitMessage]);

  if (isIndexLockError(commit) && clearStaleIndexLock(projectRoot)) {
    add = await runAddBatches(projectRoot, paths, runner);
    if (add.code !== 0) return { step: "add", result: add };
    commit = await runner("git", ["-C", projectRoot, "commit", "-m", commitMessage]);
  }

  return { step: "commit", result: commit };
}

export async function commitAndPush(
  projectRoot: string,
  commitMessage: string,
  runner: GitRunner = run,
  options: CommitAndPushOptions = {},
): Promise<CommitAndPushResult> {
  const commitResult = await addAndCommit(projectRoot, commitMessage, runner, options.paths);
  if (commitResult.result.code !== 0) {
    return { ok: false, step: commitResult.step, result: commitResult.result };
  }
  const commit = commitResult.result;

  const branchResult = await runner("git", ["-C", projectRoot, "branch", "--show-current"]);
  const branch = branchResult.stdout.trim();
  if (branchResult.code !== 0 || !branch) {
    return { ok: false, step: "branch", result: branchResult };
  }
  if (options.push === false) {
    return { ok: true, branch, commit };
  }

  const pushed = await pushBranch(projectRoot, branch, runner);
  if (!pushed.ok) {
    return { ok: false, step: "push", branch, result: pushed.result };
  }

  return { ok: true, branch, commit, push: pushed.push };
}

export type PushBranchResult = { ok: true; push: CommandResult } | { ok: false; result: CommandResult };

/**
 * Stop-hook push primityvas atskirai nuo commit'o: `push origin <branch>` su vienkartiniu
 * `--set-upstream` fallback'u. Jokio force jokia forma — argv čia yra visas kontraktas,
 * todėl integracijos push jį PERNAUDOJA, o ne dubliuoja.
 */
export async function pushBranch(projectRoot: string, branch: string, runner: GitRunner = run): Promise<PushBranchResult> {
  let push = await runner("git", ["-C", projectRoot, "push", "origin", branch]);
  if (push.code !== 0) {
    push = await runner("git", ["-C", projectRoot, "push", "--set-upstream", "origin", branch]);
    if (push.code !== 0) {
      return { ok: false, result: push };
    }
  }
  return { ok: true, push };
}

export type PrimaryBranchPushOutcome = { ok: true; branch: string } | { ok: false; detail: string };

/**
 * Pirminės šakos push po sėkmingos worker integracijos: išsprendžia einamąją pirminio
 * medžio šaką ir pernaudoja tą patį push mechanizmą. Nesėkmė grąžinama reikšme, ne metimu —
 * integracijos baigties ji niekada nekeičia (lokalus merge lieka tiesos šaltinis).
 */
export async function pushPrimaryBranch(projectRoot: string, runner: GitRunner = run): Promise<PrimaryBranchPushOutcome> {
  const branchResult = await runner("git", ["-C", projectRoot, "branch", "--show-current"]);
  const branch = branchResult.stdout.trim();
  if (branchResult.code !== 0 || !branch) {
    const detail = (branchResult.stderr || branchResult.stdout).trim() || `exit=${branchResult.code}`;
    return { ok: false, detail: `branch resolution failed: ${detail}` };
  }
  const pushed = await pushBranch(projectRoot, branch, runner);
  if (!pushed.ok) {
    const detail = (pushed.result.stderr || pushed.result.stdout).trim() || `exit=${pushed.result.code}`;
    return { ok: false, detail: `${branch}: ${detail}` };
  }
  return { ok: true, branch };
}
