// Task-scoped rollback IO pusė (etalonas: AG_loop orchestrator/git/rollback-scope.ts,
// task 890/1077). Grynas sprendimas — domain/git/rollback-rules; ownership filtruotas kelių
// rinkimas — application `taskScopeRestorePaths`. Čia lieka tik skaitymas: ledger'is,
// nuosavybės sidecar'as ir sesijos tapatybė.

import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pushedRollbackBlock, type PushedRollbackDecision } from "../../domain/git/rollback-rules.js";
import {
  sessionWriteOwnersPath,
  taskScopeRestorePaths,
  type SessionWriteOwners,
} from "../../application/task-execution/session-write-owners.js";
import { parseJsonStringArray, tryParseJson } from "../../shared/json.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { run, type CommandResult } from "../process/run-process.js";
import { gitCurrentBranch, gitHead } from "./git-client.js";

async function git(root: string, args: string[]): Promise<CommandResult> {
  return await run("git", ["-C", root, ...args]);
}

/** GC apsaugos ref'ų šaknis (žr. `preserveTaskScope`) — 075-a-02 retencijos modulis skaito šį patį prefiksą. */
export const PRESERVED_REF_PREFIX = "refs/verqestra/preserved/";

/** `rev-list --count` nesėkmė ant push'inimo varto yra fail-closed, ne tylus 0/NaN „leidžiama". */
function revListCountFailure(command: string, result: CommandResult): PushedRollbackDecision {
  const stderrSummary = (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
  return { blocked: true, detail: `unable to verify pushed rollback safety: ${command} failed (${stderrSummary})` };
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

  const totalArgs = ["rev-list", "--count", `${stableRef}..HEAD`];
  const total = await git(root, totalArgs);
  if (total.code !== 0) return revListCountFailure(`git ${totalArgs.join(" ")}`, total);
  const totalCommitsSince = Number(total.stdout.trim());
  if (!Number.isFinite(totalCommitsSince)) return revListCountFailure(`git ${totalArgs.join(" ")}`, total);

  const unpushedArgs = ["rev-list", "--count", `${stableRef}..HEAD`, "--not", upstream];
  const unpushed = await git(root, unpushedArgs);
  if (unpushed.code !== 0) return revListCountFailure(`git ${unpushedArgs.join(" ")}`, unpushed);
  const unpushedCommitsSince = Number(unpushed.stdout.trim());
  if (!Number.isFinite(unpushedCommitsSince)) return revListCountFailure(`git ${unpushedArgs.join(" ")}`, unpushed);

  return pushedRollbackBlock({
    head,
    stableRef,
    branch,
    upstreamExists,
    totalCommitsSince,
    unpushedCommitsSince,
  });
}

export type TaskScopeRestoreResult =
  | { ok: true; restored: string[]; preserved?: PreservedTaskScope }
  | { ok: false; failures: string[] };

export type PreservedTaskScope = {
  /** `refs/verqestra/preserved/<sha>` — GC nesušluos. */
  ref: string;
  /** To paties objekto sha (ref'as ir sha sutampa sąmoningai). */
  commit: string;
  /** Bazė, prieš kurią diffinasi išsaugotas darbas. */
  baseRef: string;
  /** Keliai, kurių turinys skyrėsi nuo `baseRef` ir buvo išsaugoti. */
  paths: string[];
};

type PreserveOutcome = { ok: true; preserved?: PreservedTaskScope } | { ok: false; failures: string[] };

/**
 * 021-a-02: prieš destruktyvų atstatymo kelią (žr. `restoreTaskScope`) nufotografuoja task'o
 * kelių DABARTINĮ (necommit'intą) turinį į git commit objektą po `stableRef` medžiu — plumbing
 * lygmeniu, per laikiną `GIT_INDEX_FILE`, kad realus `.git/index` ir worktree liktų neliesti.
 * `update-ref` privalomas: be jo commit'as būtų dangling ir `git gc` teisėtai jį sušluotų.
 * Bet kuri git nesėkmė šioje grandinėje yra fail-closed — kvietėjas gauna `ok:false` ir
 * atstatymo kilpa NEPALEIDŽIAMA, kad purvinas medis niekada netaptų tyliai sunaikintu.
 */
async function preserveTaskScope(root: string, stableRef: string, paths: readonly string[]): Promise<PreserveOutcome> {
  const indexPath = path.join(tmpdir(), `verqestra-preserve-${process.pid}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const runGit = async (args: string[]): Promise<CommandResult> => await run("git", ["-C", root, ...args], { env });
  const failure = (step: string, result: CommandResult): PreserveOutcome => ({
    ok: false,
    failures: [`preserve ${step}: ${(result.stderr || result.stdout).trim() || `code ${result.code}`}`],
  });

  try {
    const stableTree = await runGit(["rev-parse", `${stableRef}^{tree}`]);
    if (stableTree.code !== 0) return failure("rev-parse", stableTree);

    const readTree = await runGit(["read-tree", stableRef]);
    if (readTree.code !== 0) return failure("read-tree", readTree);

    const updateIndex = await runGit(["update-index", "--add", "--remove", "--", ...paths]);
    if (updateIndex.code !== 0) return failure("update-index", updateIndex);

    const writeTree = await runGit(["write-tree"]);
    if (writeTree.code !== 0) return failure("write-tree", writeTree);

    const tree = writeTree.stdout.trim();
    const stableTreeSha = stableTree.stdout.trim();
    if (tree === stableTreeSha) return { ok: true };

    const diff = await runGit(["diff", "--name-only", stableTreeSha, tree, "--", ...paths]);
    if (diff.code !== 0) return failure("diff", diff);
    const changedPaths = diff.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const commitTree = await runGit(["commit-tree", tree, "-p", stableRef, "-m", "verqestra: preserved task scope"]);
    if (commitTree.code !== 0) return failure("commit-tree", commitTree);
    const commit = commitTree.stdout.trim();
    const ref = `${PRESERVED_REF_PREFIX}${commit}`;

    const updateRef = await runGit(["update-ref", ref, commit]);
    if (updateRef.code !== 0) return failure("update-ref", updateRef);

    return { ok: true, preserved: { ref, commit, baseRef: stableRef, paths: changedPaths } };
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
}

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
  const preserve: PreserveOutcome = paths.length === 0 ? { ok: true } : await preserveTaskScope(root, stableRef, paths);
  if (!preserve.ok) return { ok: false, failures: preserve.failures };

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
  if (failures.length > 0) return { ok: false, failures };
  return preserve.preserved ? { ok: true, restored, preserved: preserve.preserved } : { ok: true, restored };
}

/**
 * `taskScopePaths` porto realizacija (VQ-501 rollback-stable laukė jos per portą).
 *
 * Tapatybė ta pati kaip Stop staging'e: dispatch nonce plius `current-task-id`. Be nonce
 * niekas negali būti įrodyta svetimu, tad interaktyvi sesija elgiasi kaip anksčiau — filtras
 * tada nieko nemeta.
 */
export async function readTaskScopePaths(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const stateDir = path.join(runtimeRoot, "state");
  const sessionWritesPath = path.join(stateDir, "session-writes.json");
  const sessionWrites = parseJsonStringArray(await nodeFsAdapter.readTextFileIfExists(sessionWritesPath));
  const ownersRaw = await nodeFsAdapter.readTextFileIfExists(sessionWriteOwnersPath(sessionWritesPath));
  const parsed = ownersRaw === undefined ? undefined : tryParseJson<unknown>(ownersRaw);
  const owners =
    parsed?.ok === true && parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value)
      ? (parsed.value as SessionWriteOwners)
      : {};

  return taskScopeRestorePaths(sessionWrites, owners, {
    session: (env["AG_DISPATCH_NONCE"] ?? "").trim(),
    taskId: ((await nodeFsAdapter.readTextFileIfExists(path.join(stateDir, "current-task-id"))) ?? "").trim(),
  });
}
