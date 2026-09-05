// Izoliuotas bangos integration branch (etalonas: AG_loop infrastructure/git/
// integration-branch.ts; task 1114, IVER-1/IVER-2).
//
// Čia gyvena VIENINTELIS kelias, kuriuo `IntegrationPlan` virsta realiu git ref'u. Vienas
// kietas invariantas: **pagrindinė šaka niekada nejuda ir darbinis medis niekada
// neliečiamas** — commit'ai taikomi ne per `cherry-pick`/`merge` (abu perjungia HEAD ir
// rašo į medį), o per plumbing grandinę su LAIKINU indeksu:
//
//   read-tree -m -i --aggressive <parent> <branch> <commit>  (3-way, medis ignoruojamas)
//   ls-files --unmerged                                      (konfliktų įrodymas)
//   write-tree -> commit-tree -> update-ref                  (juda TIK integration ref)
//
// `update-ref` visada su senąja reikšme (compare-and-swap). Sąmoningi apribojimai:
// 3-way vyksta FAILO granuliarumu (konfliktas garsiai, ne spėjamas merge); nesėkmė
// NIEKADA negrąžina ref'o atgal ir netrina šakos (partial integration tęsiamas).
// Sprendimai — grynajame application/integration/create-integration-plan; čia tik git/FS.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRuntimePath, parseDirtyEntries } from "../../domain/git/changes.js";
import { isPathInScope, type IntegrationPlan } from "../../application/integration/create-integration-plan.js";
import { run, type CommandResult } from "../process/run-process.js";
import {
  gitCommitExists,
  gitCommitFiles,
  gitCurrentBranch,
  gitRefExists,
  gitResolveCommit,
  gitStatusResult,
  isGitRepository,
} from "./git-client.js";

/** Trailer'is, kuriuo integracinis commit'as neša savo šaltinį. Partial-recovery raktas. */
export const INTEGRATION_SOURCE_TRAILER = "AG-Integration-Source";

async function git(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return await run("git", ["-C", root, ...args], { cwd: root, ...(env ? { env } : {}) });
}

function gitFailure(result: CommandResult, args: readonly string[]): string {
  return `git ${args.join(" ")} failed (code ${result.code}): ${(result.stderr || result.stdout).trim()}`;
}

/** Kodėl planas atmestas PRIEŠ liečiant bet kokį ref'ą. */
export type IntegrationRejectionReason =
  | "plan-invalid"
  | "missing-base"
  | "stale-base"
  | "missing-commit"
  | "dirty-worktree"
  | "out-of-scope-commit";

export type AppliedIntegrationCommit = {
  task_id: string;
  /** Šaltinio commit'as iš plano. */
  source_sha: string;
  /** Jį atitinkantis commit'as integration šakoje. */
  integrated_sha: string;
  /** `true`, kai commit'as jau buvo pritaikytas ankstesniame (nutrūkusiame) bandyme. */
  reused: boolean;
};

export type IntegrationApplyResult =
  | { status: "applied"; branch: string; head: string; applied: AppliedIntegrationCommit[] }
  | {
      status: "conflict";
      branch: string;
      /** Šakos head TIES nutrūkimo momentu — banga lieka dalinai integruota, be rollback'o. */
      head: string;
      applied: AppliedIntegrationCommit[];
      conflict: { task_id: string; sha: string; paths: string[] };
    }
  | { status: "invalid"; reason: IntegrationRejectionReason; details: string[] }
  | { status: "infrastructure"; message: string };

export type ApplyIntegrationPlanOptions = {
  /** Praleisti dirty-medžio vartus (testams ir sąmoningam operatoriaus sprendimui). */
  allowDirtyWorktree?: boolean;
  /**
   * Commit'o žinutės kūrėjas. Numatytoji forma neša trailer'ius, iš kurių atkuriama, kas
   * jau pritaikyta — jų keitimas nutraukia partial-recovery.
   */
  messageFor?: (commit: IntegrationPlan["commits"][number], plan: IntegrationPlan) => string;
};

function defaultMessage(commit: IntegrationPlan["commits"][number], plan: IntegrationPlan): string {
  const subject = commit.subject?.trim() || `task ${commit.task_id}`;
  return [
    `integrate ${commit.task_id}: ${subject}`,
    "",
    `AG-Integration-Run: ${plan.run_id}`,
    `AG-Integration-Wave: ${plan.wave_id}`,
    `AG-Integration-Task: ${commit.task_id}`,
    `${INTEGRATION_SOURCE_TRAILER}: ${commit.sha}`,
  ].join("\n");
}

const SOURCE_TRAILER_PATTERN = new RegExp(`^${INTEGRATION_SOURCE_TRAILER}:\\s*([0-9a-f]{40}|[0-9a-f]{64})\\s*$`, "im");

/**
 * Šaltinio commit'as -> jį atitinkantis integracinis commit'as, atkurtas iš trailer'io.
 * Partial-recovery atmintis: nutrūkusi banga TĘSIAMA, ne pradedama iš naujo. Skaitomas tik
 * `base..branch` intervalas. Žinutės skaitomos po vieną (`show -s`) — daugiaeilių žinučių
 * parsinimas iš vieno srauto yra vieta, kur atsiranda tylus praleistas įrašas.
 */
export async function appliedSourceCommits(root: string, branch: string, baseHead: string): Promise<Map<string, string>> {
  const applied = new Map<string, string>();
  if (!(await gitRefExists(`refs/heads/${branch}`, root))) return applied;

  const log = await git(root, ["log", "--format=%H", `${baseHead}..refs/heads/${branch}`]);
  if (log.code !== 0) return applied;

  for (const integrated of log.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const body = await git(root, ["show", "-s", "--format=%B", integrated]);
    if (body.code !== 0) continue;
    const source = SOURCE_TRAILER_PATTERN.exec(body.stdout)?.[1];
    if (source) applied.set(source.toLowerCase(), integrated);
  }
  return applied;
}

/**
 * Sukuria izoliuotą šaką ties `plan.base_head`, jei jos dar nėra. `git branch` NEPERJUNGIA
 * HEAD ir neliečia medžio. Esama šaka niekada neperkeliama: nutrūkusi banga privalo likti
 * ten, kur sustojo.
 */
export async function createIntegrationBranch(
  root: string,
  plan: IntegrationPlan,
): Promise<{ status: "created" | "exists"; head: string } | { status: "infrastructure"; message: string }> {
  if (await gitRefExists(`refs/heads/${plan.branch}`, root)) {
    const head = await gitResolveCommit(`refs/heads/${plan.branch}`, root);
    if (!head) return { status: "infrastructure", message: `cannot resolve existing integration branch ${plan.branch}` };
    return { status: "exists", head };
  }

  const args = ["branch", plan.branch, plan.base_head];
  const created = await git(root, args);
  if (created.code !== 0) return { status: "infrastructure", message: gitFailure(created, args) };
  return { status: "created", head: plan.base_head };
}

/**
 * Ne-runtime dirty keliai: tik jie reiškia „yra neužcommitinto produkto darbo". `git status`
 * nesėkmė (index.lock, EPERM, ne repo) grąžina VIENĄ sentinel įrašą, kuris neatitinka jokio
 * runtime prefikso — kvietėjas mato ne-tuščią sąrašą ir atsisako, o ne tyliai praleidžia
 * (fail closed, `committedTaskWorkSince` etalonas rollback-scope.ts).
 */
export async function nonRuntimeDirtyPaths(root: string): Promise<string[]> {
  const status = await gitStatusResult(root);
  if (!status.ok) {
    return [`<git status failed: ${status.detail}>`];
  }
  return parseDirtyEntries(status.status)
    .map((entry) => entry.path)
    .filter((entry) => !isRuntimePath(entry));
}

/**
 * Apply laiko vartai. Kiekvienas tikrina faktą, kurio grynasis planas įrodyti negali, ir
 * grąžina struktūrizuotą atmetimą — niekada išimtį ir niekada dalinį taikymą.
 */
async function rejectBeforeApply(
  root: string,
  plan: IntegrationPlan,
  options: ApplyIntegrationPlanOptions,
): Promise<Extract<IntegrationApplyResult, { status: "invalid" | "infrastructure" }> | undefined> {
  if (!plan.ok) {
    return {
      status: "invalid",
      reason: "plan-invalid",
      details: plan.violations.filter((entry) => entry.severity === "error").map((entry) => entry.message),
    };
  }

  if (!(await gitCommitExists(plan.base_head, root))) {
    return { status: "invalid", reason: "missing-base", details: [`base head ${plan.base_head} is not a commit in ${root}`] };
  }

  // Stale base: pagrindinė šaka pajudėjo nuo plano sudarymo — planas aprašo kitą pasaulį.
  const baseBranch = plan.base_branch || (await gitCurrentBranch(root));
  if (baseBranch) {
    const branchHead = await gitResolveCommit(baseBranch, root);
    if (branchHead && branchHead.toLowerCase() !== plan.base_head.toLowerCase()) {
      return {
        status: "invalid",
        reason: "stale-base",
        details: [`${baseBranch} is at ${branchHead}, but the plan was built for base head ${plan.base_head}`],
      };
    }
  }

  if (!options.allowDirtyWorktree) {
    const dirty = await nonRuntimeDirtyPaths(root);
    if (dirty.length > 0) {
      return { status: "invalid", reason: "dirty-worktree", details: dirty };
    }
  }

  const missing: string[] = [];
  const outOfScope: string[] = [];
  for (const commit of plan.commits) {
    if (!(await gitCommitExists(commit.sha, root))) {
      missing.push(commit.sha);
      continue;
    }
    // Ribų patikra pakartojama prieš REALIUS commit'o failus: allowed_paths yra kieta riba.
    const files = await gitCommitFiles(commit.sha, root);
    if (files === undefined) {
      return { status: "infrastructure", message: `cannot read files of commit ${commit.sha}` };
    }
    for (const file of files) {
      if (!isPathInScope(file, plan.allowed_paths)) outOfScope.push(`${commit.sha}: ${file}`);
    }
  }
  if (missing.length > 0) {
    return { status: "invalid", reason: "missing-commit", details: missing.map((sha) => `commit ${sha} does not exist in ${root}`) };
  }
  if (outOfScope.length > 0) {
    return { status: "invalid", reason: "out-of-scope-commit", details: outOfScope };
  }

  return undefined;
}

type ApplyStep =
  | { status: "applied"; sha: string }
  | { status: "conflict"; paths: string[] }
  | { status: "infrastructure"; message: string };

async function resolveTree(root: string, commitish: string): Promise<string | undefined> {
  const result = await git(root, ["rev-parse", "--verify", `${commitish}^{tree}`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * Vienas commit'as ant `head`, per laikiną indeksą. Šaltinio autorystė perkeliama
 * nepakeista — integracija yra darbo perkėlimas, ne perrašymas; committer'iu lieka
 * procesą vykdanti tapatybė.
 */
async function applyCommit(root: string, head: string, sha: string, message: string): Promise<ApplyStep> {
  const parent = await gitResolveCommit(`${sha}^`, root);
  if (!parent) {
    return { status: "infrastructure", message: `commit ${sha} has no parent; a root commit cannot be integrated` };
  }

  const [baseTree, oursTree, theirsTree] = await Promise.all([
    resolveTree(root, parent),
    resolveTree(root, head),
    resolveTree(root, sha),
  ]);
  if (!baseTree || !oursTree || !theirsTree) {
    return { status: "infrastructure", message: `cannot resolve trees for ${sha} onto ${head}` };
  }

  const indexDir = await mkdtemp(path.join(os.tmpdir(), "ag-integration-index-"));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: path.join(indexDir, "index") };
  try {
    // `-i` = „nekreipk dėmesio į darbinį medį"; `-u` nenaudojamas, tad medis nerašomas:
    // merge'as vyksta tik objektų duomenų bazėje.
    const readTreeArgs = ["read-tree", "-m", "-i", "--aggressive", baseTree, oursTree, theirsTree];
    const readTree = await git(root, readTreeArgs, env);
    if (readTree.code !== 0) {
      return { status: "infrastructure", message: gitFailure(readTree, readTreeArgs) };
    }

    const unmerged = await git(root, ["ls-files", "--unmerged"], env);
    if (unmerged.code !== 0) {
      return { status: "infrastructure", message: gitFailure(unmerged, ["ls-files", "--unmerged"]) };
    }
    const conflictPaths = [
      ...new Set(
        unmerged.stdout
          .split(/\r?\n/)
          .map((line) => line.split("\t")[1]?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ].sort();
    if (conflictPaths.length > 0) {
      return { status: "conflict", paths: conflictPaths };
    }

    const writeTree = await git(root, ["write-tree"], env);
    if (writeTree.code !== 0) {
      return { status: "infrastructure", message: gitFailure(writeTree, ["write-tree"]) };
    }
    const tree = writeTree.stdout.trim();

    const author = await git(root, ["show", "-s", "--format=%an%n%ae%n%aI", sha]);
    const [authorName, authorEmail, authorDate] = author.code === 0 ? author.stdout.trim().split(/\r?\n/) : [];
    const commitEnv: NodeJS.ProcessEnv = {
      ...env,
      ...(authorName ? { GIT_AUTHOR_NAME: authorName } : {}),
      ...(authorEmail ? { GIT_AUTHOR_EMAIL: authorEmail } : {}),
      ...(authorDate ? { GIT_AUTHOR_DATE: authorDate } : {}),
    };
    const created = await git(root, ["commit-tree", tree, "-p", head, "-m", message], commitEnv);
    if (created.code !== 0) {
      return { status: "infrastructure", message: gitFailure(created, ["commit-tree", tree, "-p", head]) };
    }
    return { status: "applied", sha: created.stdout.trim() };
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

/**
 * Pritaiko visą planą į izoliuotą šaką. Rezultatai visiški ir struktūrizuoti; pagrindinė
 * šaka nė vienu atveju nejuda. Idempotentiškumas: jau pritaikyti commit'ai atpažįstami iš
 * trailer'io ir praleidžiami — pakartotinis kvietimas po nutrūkimo TĘSIA bangą.
 */
export async function applyIntegrationPlan(
  root: string,
  plan: IntegrationPlan,
  options: ApplyIntegrationPlanOptions = {},
): Promise<IntegrationApplyResult> {
  if (!(await isGitRepository(root))) {
    return { status: "infrastructure", message: `${root} is not a git repository` };
  }

  const rejection = await rejectBeforeApply(root, plan, options);
  if (rejection) return rejection;

  const branch = await createIntegrationBranch(root, plan);
  if (branch.status === "infrastructure") return branch;

  const alreadyApplied = await appliedSourceCommits(root, plan.branch, plan.base_head);
  const messageFor = options.messageFor ?? defaultMessage;
  const applied: AppliedIntegrationCommit[] = [];
  let head = branch.head;

  for (const commit of plan.commits) {
    const reused = alreadyApplied.get(commit.sha);
    if (reused) {
      applied.push({ task_id: commit.task_id, source_sha: commit.sha, integrated_sha: reused, reused: true });
      continue;
    }

    const step = await applyCommit(root, head, commit.sha, messageFor(commit, plan));
    if (step.status === "infrastructure") return { status: "infrastructure", message: step.message };
    if (step.status === "conflict") {
      return {
        status: "conflict",
        branch: plan.branch,
        head,
        applied,
        conflict: { task_id: commit.task_id, sha: commit.sha, paths: step.paths },
      };
    }

    // Compare-and-swap: ref juda tik tada, kai jis vis dar ten, kur jį palikome.
    const updateArgs = ["update-ref", `refs/heads/${plan.branch}`, step.sha, head];
    const updated = await git(root, updateArgs);
    if (updated.code !== 0) {
      return { status: "infrastructure", message: gitFailure(updated, updateArgs) };
    }

    head = step.sha;
    applied.push({ task_id: commit.task_id, source_sha: commit.sha, integrated_sha: step.sha, reused: false });
  }

  return { status: "applied", branch: plan.branch, head, applied };
}
