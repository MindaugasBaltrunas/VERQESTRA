// `rollback-stable` CLI adapteris (etalonas: interfaces/cli/rollback-stable/index.ts).
// Saugiausiai skaitoma komanda visame rinkinyje — ji vienintelė gali sunaikinti darbą, tad
// kiekvienas jos vartas yra fail-closed.
//
// Du režimai, ir jie NE tas pats:
//   • task-scoped (`--allow-task-changes --task-id <id>`) — atstato TIK šio task'o ledger
//     kelius į paties task'o `base_head`, kelias po kelio. Šakos rodyklė nejuda, tad vėlesni
//     svetimi commit'ai struktūriškai negali dingti (regresija 875 / 884–893), o push'inta
//     istorija neperrašoma. Todėl pushed-history vartas šiam keliui NETAIKOMAS.
//   • reset (be vėliavos) — sąmoningas žmogaus `git reset --hard` iki `stable-ref`. Čia
//     pushed-history vartas galioja, o nešvarus medis pirma nufotografuojamas į snapshot'ą.
//
// Užblokuotas rollback'as NIEKADA nenutyli: žinutė eina ir į stderr, ir į AG žurnalą, o
// exit kodas 1 nurodo operatoriui vesti task'ą į human-review.

import path from "node:path";
import { nonRuntimeDirtyEntriesFromStatus, type DirtyEntry } from "../../../domain/git/changes.js";
import {
  resolveTaskScopedRollback,
  type PushedRollbackDecision,
  type TaskStartStatus,
} from "../../../domain/git/rollback-rules.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type RollbackCommandResult = { code: number; stdout: string; stderr: string };

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

export type TaskScopeRestoreOutcome =
  | { ok: true; restored: string[]; preserved?: PreservedTaskScope }
  | { ok: false; failures: string[] };

/** Kelias, kurio savininkystė NEĮRODYTA mūsų — praleistas fail-closed, su priežastimi (etalonas: `RestoreSkipReason`). */
export type TaskScopeSkippedPath = { path: string; reason: string };

/**
 * `taskScopePaths()` praturtinta forma: nuosavi keliai PLIUS praleisti (076-a-02). Atskira nuo
 * `string[]`, o ne jį pakeičianti, nes producer'as (`rollback-scope.ts:readTaskScopePaths`) šiuo
 * metu grąžina tik plikus kelius — šis tipas jam lieka suderinamas be jokio pakeitimo.
 */
export type TaskScopeCandidates = {
  /** Keliai, kuriuos rollback'as turi teisę atstatyti. */
  paths: string[];
  /** Keliai, ĮRODYTAI priklausantys svetimai sesijai ar užduočiai. */
  foreign: string[];
  /** Keliai, kurių savininkystė nenustatoma. */
  skipped: TaskScopeSkippedPath[];
};

export type RollbackStablePorts = {
  ensureDirs(): Promise<void>;
  isGitRepository(projectRoot: string): Promise<boolean>;
  gitCommitExists(ref: string, projectRoot: string): Promise<boolean>;
  gitHead(projectRoot: string): Promise<string | undefined>;
  gitStatus(projectRoot: string): Promise<string>;
  /** `git -C <projectRoot> <args>`. */
  runGit(args: string[], projectRoot: string): Promise<RollbackCommandResult>;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  writeTextFile(absolutePath: string, text: string): Promise<void>;
  appendTextFile(absolutePath: string, text: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
  /** Untracked įrašo kopija į snapshot katalogą (etalono `cp` recursive, esamo neperrašo). */
  copyPath(source: string, destination: string): Promise<void>;
  /**
   * Šios sesijos ledger keliai, jau filtruoti pagal nuosavybę (adapteris — VQ-502 hooks).
   * Unija sąmoninga: dabartinis producer'as grąžina plikus kelius (`string[]`), o
   * `TaskScopeCandidates` yra praturtinta forma vėlesniam producer'iui, kuris kartu su
   * atstatomais keliais atskleistų praleistus (076-a-02) — abi formos suderinamos be jokio
   * pakeitimo šio porto realizacijoje.
   */
  taskScopePaths(): Promise<string[] | TaskScopeCandidates>;
  detectPushedRollback(projectRoot: string, ref: string): Promise<PushedRollbackDecision>;
  committedTaskWorkSince(projectRoot: string, baseRef: string, paths: readonly string[]): Promise<string[]>;
  restoreTaskScope(projectRoot: string, ref: string, paths: readonly string[]): Promise<TaskScopeRestoreOutcome>;
  agLog(line: string): Promise<void>;
  now?: () => Date;
  /**
   * Ar po reset'o šalinti untracked failus (etalone — `AG_ROLLBACK_CLEAN=1`). Env skaitymas
   * gyvena kompozicijoje; numatytai NEšalinama, nes `git clean -fd` naikina ir tai, ko
   * niekas nefotografavo.
   */
  cleanUntracked?: boolean;
};

export type RollbackStableDeps = {
  ports: RollbackStablePorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: CliIo;
};

const ROLLBACK_USAGE =
  "Usage: verqestra rollback-stable [--allow-task-changes --task-id <id> [--run-id <id>]] [--ref <sha>]";
type ParsedRollbackArgs =
  | { ok: true; allowTaskChanges: boolean; taskId: string | undefined; runId: string | undefined; ref: string | undefined }
  | { ok: false; message: string };

// Fail-closed argv parsinimas PRIEŠ bet kokį git veiksmą (208): nežinomas token'as niekada nepasiekia `runGit`.
function parseRollbackArgs(args: string[]): ParsedRollbackArgs {
  let allowTaskChanges = false;
  let taskId: string | undefined, runId: string | undefined, ref: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--allow-task-changes") {
      allowTaskChanges = true;
    } else if (token === "--task-id" || token === "--run-id" || token === "--ref") {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: ROLLBACK_USAGE };
      if (token === "--task-id") taskId = value;
      else if (token === "--run-id") runId = value;
      else ref = value;
      i += 1;
    } else {
      return { ok: false, message: ROLLBACK_USAGE };
    }
  }

  if (ref !== undefined && allowTaskChanges) {
    return {
      ok: false,
      message: `${ROLLBACK_USAGE} — --ref cannot be combined with --allow-task-changes: the task-scoped path targets the task's base_head.`,
    };
  }
  return { ok: true, allowTaskChanges, taskId, runId, ref };
}

function parseJsonOrEmpty<T>(raw: string | undefined): Partial<T> {
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed) : {};
  } catch {
    return {};
  }
}

type RollbackContext = {
  ports: RollbackStablePorts;
  root: string;
  runtimeRoot: string;
  io: CliIo;
  now: () => Date;
};

async function nonRuntimeDirtyEntries(context: RollbackContext): Promise<DirtyEntry[]> {
  const status = await context.ports.runGit(["status", "--porcelain", "--untracked-files=all"], context.root);
  // Neperskaitytas status yra NEŽINIA, ne švara: grąžinam sentinel įrašą, kad vartas blokuotų.
  if (status.code !== 0) return [{ status: "??", path: "<git status failed>" }];
  return nonRuntimeDirtyEntriesFromStatus(status.stdout);
}

/** Nufotografuoja ne-runtime pakeitimus prieš blokuojant; grąžina patch failo kelią. */
async function writeRollbackSnapshot(context: RollbackContext, entries: DirtyEntry[]): Promise<string> {
  const stamp = context.now().toISOString().replace(/[:.]/g, "-");
  const snapshotRoot = path.join(context.runtimeRoot, "state", "rollback-snapshots", stamp);
  const patchPath = path.join(snapshotRoot, "changes.patch");
  const paths = entries.map((entry) => entry.path);

  const diff = await context.ports.runGit(["diff", "--binary", "--", ...paths], context.root);
  const stagedDiff = await context.ports.runGit(["diff", "--binary", "--cached", "--", ...paths], context.root);

  await context.ports.makeDirectory(snapshotRoot);
  await copyUntrackedEntries(context, entries, snapshotRoot);
  await context.ports.writeTextFile(
    path.join(snapshotRoot, "manifest.txt"),
    [
      "Rollback blocked because non-runtime changes exist.",
      `date=${context.now().toISOString()}`,
      `patch=${patchPath}`,
      `untracked_copy_dir=${path.join(snapshotRoot, "untracked")}`,
      "",
      "files:",
      ...entries.map((entry) => `${entry.status} ${entry.path}`),
      "",
    ].join("\n"),
  );
  await context.ports.writeTextFile(
    patchPath,
    ["# unstaged diff", diff.stdout || "", "", "# staged diff", stagedDiff.stdout || "", ""].join("\n"),
  );

  return patchPath;
}

async function copyUntrackedEntries(
  context: RollbackContext,
  entries: DirtyEntry[],
  snapshotRoot: string,
): Promise<void> {
  for (const entry of entries) {
    // Tik untracked failai turi turinį, kurio nėra git objektuose — tracked pakeitimus jau
    // neša patch'as. Sentinel įrašai (`<...>`) ir keliai už repo ribų praleidžiami.
    if (entry.status.trim() !== "??" || entry.path.startsWith("<")) continue;
    const source = path.resolve(context.root, entry.path);
    if (!source.startsWith(context.root)) continue;
    await context.ports.copyPath(source, path.join(snapshotRoot, "untracked", entry.path));
  }
}

async function block(context: RollbackContext, message: string): Promise<number> {
  context.io.error(message);
  await context.ports.agLog(message);
  return 1;
}

function normalizeTaskScopeCandidates(result: string[] | TaskScopeCandidates): TaskScopeCandidates {
  return Array.isArray(result) ? { paths: result, foreign: [], skipped: [] } : result;
}

/**
 * P1 matomumas (076-a-02): tylus praleidimas yra tokia pat spraga kaip tylus revertas —
 * operatorius turi matyti, kad medyje liko neliestas svetimas ar nenustatomos savininkystės
 * necommit'intas darbas. Tas pats kanalas kaip užblokuoto rollback'o pranešimas (stderr + AG
 * žurnalas), bet NEblokuoja: geri keliai vis tiek atstatomi.
 */
async function reportSkippedTaskScopePaths(context: RollbackContext, candidates: TaskScopeCandidates): Promise<void> {
  if (candidates.foreign.length === 0 && candidates.skipped.length === 0) return;

  const parts: string[] = [];
  if (candidates.foreign.length > 0) {
    parts.push(`foreign=${candidates.foreign.join(", ")}`);
  }
  if (candidates.skipped.length > 0) {
    parts.push(`unknown-owner=${candidates.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`);
  }

  const message = `ROLLBACK SKIPPED PATHS: ${parts.join("; ")} — left untouched, not restored.`;
  context.io.error(message);
  await context.ports.agLog(message);
}

/** `undefined` — užblokuota (skambutis jau parašė žinutę); kitaip — atstatymo taikinys. */
async function resolveTaskTarget(
  context: RollbackContext,
  taskId: string | undefined,
): Promise<{ targetRef: string } | { blocked: number }> {
  const raw = await context.ports.readTextFileIfExists(
    path.join(context.runtimeRoot, "state", "task-start-status.json"),
  );
  const decision = resolveTaskScopedRollback(parseJsonOrEmpty<TaskStartStatus>(raw), taskId);

  if (decision.ok) {
    if (!(await context.ports.gitCommitExists(decision.targetRef, context.root))) {
      return {
        blocked: await block(
          context,
          `ROLLBACK BLOCKED: task base_head ${decision.targetRef} is not a known commit for task=${taskId}`,
        ),
      };
    }
    return { targetRef: decision.targetRef };
  }

  const snapshotSuffix = decision.snapshotBaseline
    ? ` Snapshot: ${await writeRollbackSnapshot(context, await nonRuntimeDirtyEntries(context))}.`
    : "";
  return { blocked: await block(context, `ROLLBACK BLOCKED: ${decision.reason}.${snapshotSuffix}`) };
}

// `explicitRef` (208, `--ref <sha>`) pakeičia stable-ref failo skaitymą; nuo šio taško abu
// keliai identiški — TA PATI dirty-snapshot ir `detectPushedRollback` apsauga.
async function resolveStableTarget(
  context: RollbackContext,
  explicitRef: string | undefined,
): Promise<{ targetRef: string } | { blocked: number }> {
  let candidate = explicitRef;
  if (candidate === undefined) {
    const stableRefPath = path.join(context.runtimeRoot, "state", "stable-ref");
    candidate = (await context.ports.readTextFileIfExists(stableRefPath))?.trim();
    if (!candidate) {
      context.io.error(`No stable ref available: ${stableRefPath}`);
      await context.ports.agLog("ROLLBACK SKIPPED: no stable-ref");
      return { blocked: 1 };
    }
  }
  const targetRef = candidate;
  if (!(await context.ports.gitCommitExists(targetRef, context.root))) {
    context.io.error(`Invalid ref: ${targetRef}`);
    await context.ports.agLog(`ROLLBACK SKIPPED: invalid ref=${targetRef}`);
    return { blocked: 1 };
  }

  const dirtyEntries = await nonRuntimeDirtyEntries(context);
  if (dirtyEntries.length > 0) {
    const snapshotPath = await writeRollbackSnapshot(context, dirtyEntries);
    const files = dirtyEntries.map((entry) => `${entry.status} ${entry.path}`).join(", ");
    return {
      blocked: await block(
        context,
        `ROLLBACK BLOCKED: non-runtime changes exist. Snapshot: ${snapshotPath}. Files: ${files}`,
      ),
    };
  }

  // Task 890: jau push'inta istorija neperrašoma — būtent tai leido repo-wide reset'ui
  // atskirti lokalią šaką nuo remote. Vietoj to eskaluojama į žmogaus peržiūrą.
  const pushed = await context.ports.detectPushedRollback(context.root, targetRef);
  if (pushed.blocked) {
    return {
      blocked: await block(
        context,
        `ROLLBACK BLOCKED: ${pushed.detail}. Move the task to human-review instead of rewriting pushed history.`,
      ),
    };
  }

  return { targetRef };
}

/**
 * 083: `context.runtimeRoot` gali būti worktree KOPIJOS `vq/` — kopijai dingus, ref'as lieka
 * beveidis (GeoGravity 2026-08-29: 15 ref'ų, 14 be įrašo). `git rev-parse --git-common-dir`
 * worktree'e grąžina PAGRINDINIO `.git` kelią (ne worktree-specifinį gitdir), tad jo tėvinis
 * katalogas yra pirminio medžio šaknis. Nepavykus — fail-closed grįžimas į `context.runtimeRoot`
 * su aiškia log eilute, kad operatorius matytų, jog įrašas gali dingti kartu su kopija.
 */
async function resolvePreservedRecordRoot(context: RollbackContext): Promise<string> {
  const result = await context.ports.runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    context.root,
  );
  const gitCommonDir = result.code === 0 ? result.stdout.trim() : "";
  if (gitCommonDir === "") {
    await context.ports.agLog(
      `ROLLBACK PRESERVED ROOT FALLBACK: git-common-dir lookup failed (code=${result.code}), using runtimeRoot=${context.runtimeRoot}`,
    );
    return context.runtimeRoot;
  }
  return path.join(path.dirname(gitCommonDir), "vq");
}

/**
 * 021-b-03: kai `restoreTaskScope` grąžina `preserved`, operatorius turi sužinoti, KUR
 * necommit'intas darbas guli, PRIEŠ pamatydamas, ką rollback'as atstatė — kitaip įrodymas apie
 * atkuriamą kopiją pasimeta už "restored N path(s)" eilutės. Būsenos įrašas leidžia `verify-task`
 * (021-c-04) pasiekti tą pačią vietą be stdout parsinimo iš naujo.
 */
async function recordPreservedTaskScope(
  context: RollbackContext,
  taskId: string,
  preserved: PreservedTaskScope,
  runId: string | undefined,
): Promise<void> {
  const recordRoot = await resolvePreservedRecordRoot(context);
  const recordPath = path.join(recordRoot, "state", "rollback-preserved", `${taskId}.json`);
  const timestamp = context.now().toISOString();
  await context.ports.makeDirectory(path.dirname(recordPath));
  await context.ports.writeTextFile(
    recordPath,
    JSON.stringify(
      {
        task_id: taskId,
        ref: preserved.ref,
        commit: preserved.commit,
        base_ref: preserved.baseRef,
        paths: preserved.paths,
        recorded_at: timestamp,
        created_at: timestamp,
        ...(runId === undefined ? {} : { run_id: runId }),
      },
      null,
      2,
    ),
  );

  const line = `ROLLBACK PRESERVED: task=${taskId} ref=${preserved.ref} commit=${preserved.commit} paths=${preserved.paths.length} record=${recordPath}`;
  context.io.out(line);
  await context.ports.agLog(line);
}

async function runTaskScopedRestore(
  context: RollbackContext,
  targetRef: string,
  taskId: string | undefined,
  runId: string | undefined,
): Promise<number> {
  const candidates = normalizeTaskScopeCandidates(await context.ports.taskScopePaths());
  const paths = candidates.paths;
  await reportSkippedTaskScopePaths(context, candidates);

  // Task 1077: jei dalis ledger kelių jau UŽCOMMITINTA nuo base_head (pvz. stop hook'as
  // sukommitino darbą prieš diagnozei nusprendžiant rollback'ą), content-revert'as
  // užstage'intų committed darbo atšaukimą, o kitas commit'as jį tyliai įamžintų.
  const committed = await context.ports.committedTaskWorkSince(context.root, targetRef, paths);
  if (committed.length > 0) {
    return await block(
      context,
      `ROLLBACK BLOCKED: task path(s) already committed since base_head (${committed.join(", ")}). Refusing to content-revert committed work — move the task to human-review.`,
    );
  }

  const restore = await context.ports.restoreTaskScope(context.root, targetRef, paths);
  if (!restore.ok) {
    return await block(
      context,
      `ROLLBACK BLOCKED: task-scoped restore failed (${restore.failures.join("; ")}). Move the task to human-review.`,
    );
  }

  if (restore.preserved) {
    await recordPreservedTaskScope(context, taskId ?? "", restore.preserved, runId);
  }

  await context.ports.agLog(`ROLLBACK TASK-SCOPED: restored ${restore.restored.length} task path(s) to ${targetRef}`);
  return 0;
}

async function runHardReset(context: RollbackContext, targetRef: string): Promise<number> {
  const reset = await context.ports.runGit(["reset", "--hard", targetRef], context.root);
  if (reset.code !== 0) {
    context.io.error(reset.stderr || reset.stdout || "git reset failed");
    await context.ports.agLog(`ROLLBACK FAILED: ${targetRef}`);
    return reset.code;
  }

  if (context.ports.cleanUntracked === true) {
    const clean = await context.ports.runGit(["clean", "-fd"], context.root);
    if (clean.code !== 0) {
      context.io.error(clean.stderr || clean.stdout || "git clean failed");
      return clean.code;
    }
    return 0;
  }

  await context.ports.agLog("ROLLBACK CLEAN SKIPPED: set AG_ROLLBACK_CLEAN=1 to remove untracked files");
  return 0;
}

export async function rollbackStableCommand(deps: RollbackStableDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;

  const parsed = parseRollbackArgs(args);
  if (!parsed.ok) {
    io.error(parsed.message);
    return 2;
  }
  const { allowTaskChanges, taskId, runId, ref } = parsed;

  const root = path.resolve(deps.projectRoot);
  const context: RollbackContext = {
    ports: deps.ports,
    root,
    runtimeRoot: deps.runtimeRoot ?? path.join(root, "vq"),
    io,
    now: deps.ports.now ?? ((): Date => new Date()),
  };

  await deps.ports.ensureDirs();

  if (!(await deps.ports.isGitRepository(root))) {
    io.error(`Rollback requires a git repository: ${root}`);
    await deps.ports.agLog("ROLLBACK SKIPPED: not a git repository");
    return 1;
  }

  const target = allowTaskChanges
    ? await resolveTaskTarget(context, taskId)
    : await resolveStableTarget(context, ref);
  if ("blocked" in target) return target.blocked;
  const targetRef = target.targetRef;

  const errorLog = path.join(context.runtimeRoot, "logs", "error.log");
  await deps.ports.appendTextFile(
    errorLog,
    [
      "=== ROLLBACK ===",
      `date=${context.now().toISOString()}`,
      `target=${targetRef}`,
      `mode=${allowTaskChanges ? "task-scoped" : "reset"}`,
      `head_before=${(await deps.ports.gitHead(root)) ?? ""}`,
      "",
      "status_before:",
      await deps.ports.gitStatus(root),
      "",
    ].join("\n"),
  );

  const exitCode = allowTaskChanges
    ? await runTaskScopedRestore(context, targetRef, taskId, runId)
    : await runHardReset(context, targetRef);
  if (exitCode !== 0) return exitCode;

  await deps.ports.appendTextFile(
    errorLog,
    [`head_after=${(await deps.ports.gitHead(root)) ?? ""}`, "", "status_after:", await deps.ports.gitStatus(root), ""].join("\n"),
  );
  await deps.ports.agLog(`ROLLBACK DONE: ${targetRef}`);
  return 0;
}
