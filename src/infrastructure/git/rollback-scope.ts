// Task-scoped rollback IO pusė (etalonas: AG_loop orchestrator/git/rollback-scope.ts,
// task 890/1077). Grynas sprendimas — domain/git/rollback-rules. Ownership filtruotas
// kelių rinkimas (taskScopeRestorePaths) atvyks su E5 hooks dalimi — jam reikia
// session-write-owners protokolo, kuris gyvena hooks sluoksnyje.

import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pushedRollbackBlock, type PushedRollbackDecision } from "../../domain/git/rollback-rules.js";
import { run, type CommandResult } from "../process/run-process.js";
import { gitCurrentBranch, gitHead } from "./git-client.js";

async function git(root: string, args: string[]): Promise<CommandResult> {
  return await run("git", ["-C", root, ...args]);
}

/** Surenka git faktus {@link pushedRollbackBlock} sprendimui prieš realų repo. */
export async function detectPushedRollback(root: string, stableRef: string): Promise<PushedRollbackDecision> {
  const head = await gitHead(root);
  if (!head || head === stableRef) return { blocked: false };
  const branch = await gitCurrentBranch(root);
  if (!branch) return { blocked: false };
  const upstream = `origin/${branch}`;
  const upstreamExists = (await git(root, ["rev-parse", "--verify", `${upstream}^{commit}`])).code === 0;
  if (!upstreamExists) return { blocked: false };
  const total = await git(root, ["rev-list", "--count", `${stableRef}..HEAD`]);
  const unpushed = await git(root, ["rev-list", "--count", `${stableRef}..HEAD`, "--not", upstream]);
  return pushedRollbackBlock({
    head,
    stableRef,
    branch,
    upstreamExists,
    totalCommitsSince: Number(total.stdout.trim() || "0"),
    unpushedCommitsSince: Number(unpushed.stdout.trim() || "0"),
  });
}

export type TaskScopeRestoreResult =
  | { ok: true; restored: string[] }
  | { ok: false; failures: string[] };

/**
 * Task 1077 regresija: task-scoped rollback restauruodavo ledger kelius į `base_head` net
 * kai stop hook'as jau buvo UŽCOMMITINĘS to paties task'o darbą — indekse likdavo
 * commit'INTO darbo atšaukimas, kurį vėlesnis commit'as tyliai įamžindavo. Ši patikra
 * grąžina task'o kelius, kurių turinys tarp `baseRef` ir HEAD skiriasi — tokių kelių
 * content-revert'as draudžiamas: rollback'as tvarko tik NEcommitintą darbą. Nepavykęs
 * diff'as grąžina sentinel įrašą, kad kvietėjas blokuotų garsiai (fail closed).
 */
export async function committedTaskWorkSince(
  root: string,
  baseRef: string,
  paths: readonly string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  const diff = await git(root, ["diff", "--name-only", baseRef, "HEAD", "--", ...paths]);
  if (diff.code !== 0) {
    return [`<git diff failed: ${(diff.stderr || diff.stdout).trim() || `code ${diff.code}`}>`];
  }
  return diff.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Task-scoped rollback (task 890): restauruoja TIK bėgančio task'o failus į jų `stableRef`
 * būseną, kelias po kelio, niekada nejudinant šakos rodyklės — vėlesni svetimi commit'ai
 * struktūriškai negali būti išmesti (pilnas `git reset --hard` darė būtent tai —
 * regresija 875 / 884–893), o push'inta istorija neperrašoma. Kelias, esantis `stableRef`,
 * checkout'inamas iš jo; task'o sukurtas (nesantis `stableRef`) — unstage'inamas ir
 * šalinamas iš worktree. Bet kokia git nesėkmė nutraukia su `ok:false`, kad kvietėjas
 * eskaluotų į human-review, o ne griebtųsi repo-wide reset'o.
 */
export async function restoreTaskScope(
  root: string,
  stableRef: string,
  paths: readonly string[],
): Promise<TaskScopeRestoreResult> {
  const restored: string[] = [];
  const failures: string[] = [];
  for (const p of paths) {
    const inStable = await git(root, ["cat-file", "-e", `${stableRef}:${p}`]);
    if (inStable.code === 0) {
      const checkout = await git(root, ["checkout", stableRef, "--", p]);
      if (checkout.code !== 0) {
        failures.push(`${p}: ${(checkout.stderr || checkout.stdout).trim() || "checkout failed"}`);
        continue;
      }
      restored.push(p);
      continue;
    }
    // Task'o sukurtas failas (nėra stableRef): išmetamas iš indekso + worktree.
    // --ignore-unmatch niekada ne-stage'intam failui yra no-op; eksplicitinis fs remove
    // tada išvalo untracked likutį. Abu apriboti task'o ledger keliais.
    const removeIndex = await git(root, ["rm", "-f", "--ignore-unmatch", "--", p]);
    if (removeIndex.code !== 0) {
      failures.push(`${p}: ${(removeIndex.stderr || removeIndex.stdout).trim() || "rm failed"}`);
      continue;
    }
    const abs = path.resolve(root, p);
    const relative = path.relative(root, abs);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && existsSync(abs)) {
      try {
        await rm(abs, { force: true });
      } catch (error) {
        failures.push(`${p}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    restored.push(p);
  }
  return failures.length > 0 ? { ok: false, failures } : { ok: true, restored };
}
