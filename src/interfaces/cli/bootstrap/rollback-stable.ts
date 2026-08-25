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
  /** Šios sesijos ledger keliai, jau filtruoti pagal nuosavybę (adapteris — VQ-502 hooks). */
  taskScopePaths(): Promise<string[]>;
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

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

async function resolveStableTarget(context: RollbackContext): Promise<{ targetRef: string } | { blocked: number }> {
  const stableRefPath = path.join(context.runtimeRoot, "state", "stable-ref");
  const stableRef = (await context.ports.readTextFileIfExists(stableRefPath))?.trim();
  if (!stableRef) {
    context.io.error(`No stable ref available: ${stableRefPath}`);
    await context.ports.agLog("ROLLBACK SKIPPED: no stable-ref");
    return { blocked: 1 };
  }
  if (!(await context.ports.gitCommitExists(stableRef, context.root))) {
    context.io.error(`Invalid stable ref: ${stableRef}`);
    await context.ports.agLog(`ROLLBACK SKIPPED: invalid stable-ref=${stableRef}`);
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
  const pushed = await context.ports.detectPushedRollback(context.root, stableRef);
  if (pushed.blocked) {
    return {
      blocked: await block(
        context,
        `ROLLBACK BLOCKED: ${pushed.detail}. Move the task to human-review instead of rewriting pushed history.`,
      ),
    };
  }

  return { targetRef: stableRef };
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
): Promise<void> {
  const recordPath = path.join(context.runtimeRoot, "state", "rollback-preserved", `${taskId}.json`);
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
        recorded_at: context.now().toISOString(),
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
): Promise<number> {
  const paths = await context.ports.taskScopePaths();

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
    await recordPreservedTaskScope(context, taskId ?? "", restore.preserved);
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
  const root = path.resolve(deps.projectRoot);
  const context: RollbackContext = {
    ports: deps.ports,
    root,
    runtimeRoot: deps.runtimeRoot ?? path.join(root, "vq"),
    io,
    now: deps.ports.now ?? ((): Date => new Date()),
  };

  await deps.ports.ensureDirs();
  const allowTaskChanges = args.includes("--allow-task-changes");
  const taskId = argValue(args, "--task-id");

  if (!(await deps.ports.isGitRepository(root))) {
    io.error(`Rollback requires a git repository: ${root}`);
    await deps.ports.agLog("ROLLBACK SKIPPED: not a git repository");
    return 1;
  }

  const target = allowTaskChanges
    ? await resolveTaskTarget(context, taskId)
    : await resolveStableTarget(context);
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
    ? await runTaskScopedRestore(context, targetRef, taskId)
    : await runHardReset(context, targetRef);
  if (exitCode !== 0) return exitCode;

  await deps.ports.appendTextFile(
    errorLog,
    [`head_after=${(await deps.ports.gitHead(root)) ?? ""}`, "", "status_after:", await deps.ports.gitStatus(root), ""].join("\n"),
  );
  await deps.ports.agLog(`ROLLBACK DONE: ${targetRef}`);
  return 0;
}
