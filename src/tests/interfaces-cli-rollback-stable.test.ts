// VQ-501 (5/5-f) testai — rollback-stable vartai per fake portus. Svarbiausia, ką jie pin'ina:
// kiekvienas blokuotas kelias grąžina 1 IR nepaleidžia nė vieno destruktyvaus git veiksmo,
// task-scoped kelias niekada nekviečia `reset --hard`, o `clean -fd` be aiškaus leidimo
// nevykdomas.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  buildTaskStartStatus,
  resolveTaskScopedRollback,
  type TaskStartStatus,
} from "../domain/git/rollback-rules.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import {
  rollbackStableCommand,
  type RollbackCommandResult,
  type RollbackStablePorts,
} from "../interfaces/cli/bootstrap/rollback-stable.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const REF = "a".repeat(40);
const BASE_HEAD = "b".repeat(40);
const NOW = new Date("2026-08-21T12:00:00.000Z");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

// ---------------------------------------------------------------------------
// domain: task-scoped sprendimas
// ---------------------------------------------------------------------------

const VALID_BASELINE: TaskStartStatus = {
  task_id: "0042",
  base_head: BASE_HEAD,
  baseline_valid: true,
  non_runtime_dirty_entries: [],
};

test("resolveTaskScopedRollback: taikinys yra task'o base_head, ne stable-ref", () => {
  const decision = resolveTaskScopedRollback(VALID_BASELINE, "0042");
  assert.deepEqual(decision, { ok: true, targetRef: BASE_HEAD });
});

test("resolveTaskScopedRollback: trūkstamas task-id, svetimas baseline ir negaliojanti bazė — blokuoja", () => {
  const missingTaskId = resolveTaskScopedRollback(VALID_BASELINE, undefined);
  assert.equal(missingTaskId.ok, false);
  assert.match(missingTaskId.ok ? "" : missingTaskId.reason, /requires --task-id/);

  const foreign = resolveTaskScopedRollback({ ...VALID_BASELINE, task_id: "0099" }, "0042");
  assert.equal(foreign.ok, false);
  assert.match(foreign.ok ? "" : foreign.reason, /baseline_task=0099/);

  const invalid = resolveTaskScopedRollback({ baseline_valid: false, git_status_code: 128 }, "0042");
  assert.equal(invalid.ok, false);
  assert.match(invalid.ok ? "" : invalid.reason, /baseline_valid=false git_status_code=128/);

  const noHead = resolveTaskScopedRollback({ task_id: "0042", baseline_valid: true }, "0042");
  assert.equal(noHead.ok, false);
  assert.match(noHead.ok ? "" : noHead.reason, /no base_head recorded/);
});

test("resolveTaskScopedRollback: prieš task'ą buvę ne-runtime pakeitimai blokuoja ir prašo snapshot'o", () => {
  const decision = resolveTaskScopedRollback(
    { ...VALID_BASELINE, non_runtime_dirty_entries: [{ status: " M", path: "src/a.ts" }] },
    "0042",
  );
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.snapshotBaseline, true);
  assert.match(decision.reason, /existed before task start/);
});

// ---------------------------------------------------------------------------
// gamintojas ↔ vartotojas: SUJUNGIMAS, ne taisyklė
// ---------------------------------------------------------------------------

/**
 * Aukščiau esantys testai tikrina taisyklę su ranka sukonstruota fikstūra. Ši grupė tikrina tai,
 * kas 2026-08-24 ir buvo sugedę: ar TIKROJO gamintojo išvestis tenkina TIKRĄ vartotoją. Įrašas
 * keliauja per failą, tad ir čia jis pervaromas per JSON — praradus lauką serializacijoje
 * simptomas būtų identiškas.
 */
const roundTrip = (record: unknown): TaskStartStatus => JSON.parse(JSON.stringify(record)) as TaskStartStatus;

test("buildTaskStartStatus → resolveTaskScopedRollback: švarus medis LEIDŽIA rollback'ą", () => {
  const record = buildTaskStartStatus({
    taskId: "0042",
    baseHead: BASE_HEAD,
    startedAt: NOW.toISOString(),
    gitStatus: "",
  });

  assert.equal(record.baseline_valid, true);
  assert.deepEqual(resolveTaskScopedRollback(roundTrip(record), "0042"), { ok: true, targetRef: BASE_HEAD });
});

test("buildTaskStartStatus: neatsakęs git NEGALI atrodyti kaip švarus medis", () => {
  const record = buildTaskStartStatus({
    taskId: "0042",
    baseHead: BASE_HEAD,
    startedAt: NOW.toISOString(),
    gitStatus: undefined,
  });

  const decision = resolveTaskScopedRollback(roundTrip(record), "0042");
  assert.equal(decision.ok, false);
  assert.match(decision.ok ? "" : decision.reason, /baseline_valid=false git_status_code=1 error=git status failed/);
});

test("buildTaskStartStatus: runtime purvas rollback'o neblokuoja, produkto purvas — blokuoja", () => {
  const runtimeOnly = buildTaskStartStatus({
    taskId: "0042",
    baseHead: BASE_HEAD,
    startedAt: NOW.toISOString(),
    gitStatus: " M vq/state/task-ledger.json\n M vq/logs/orchestrator.log\n",
  });
  assert.deepEqual(runtimeOnly.non_runtime_dirty_entries, []);
  assert.equal(resolveTaskScopedRollback(roundTrip(runtimeOnly), "0042").ok, true);

  const withProduct = buildTaskStartStatus({
    taskId: "0042",
    baseHead: BASE_HEAD,
    startedAt: NOW.toISOString(),
    gitStatus: " M vq/logs/orchestrator.log\n M src/domain/git/changes.ts\n",
  });
  const blocked = resolveTaskScopedRollback(roundTrip(withProduct), "0042");
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok ? "" : blocked.reason, /src\/domain\/git\/changes\.ts/);
});

// ---------------------------------------------------------------------------
// komanda
// ---------------------------------------------------------------------------

type World = {
  ports: RollbackStablePorts;
  gitCalls: string[][];
  logs: string[];
  writes: Map<string, string>;
  appends: string[];
};

function world(
  input: {
    files?: Record<string, string>;
    statusOutput?: string;
    isRepo?: boolean;
    commitExists?: boolean;
    pushedBlocked?: string;
    committedPaths?: string[];
    restore?: { ok: true; restored: string[] } | { ok: false; failures: string[] };
    scopePaths?: string[];
    resetCode?: number;
    cleanUntracked?: boolean;
  } = {},
): World {
  const files = { ...(input.files ?? {}) };
  const gitCalls: string[][] = [];
  const logs: string[] = [];
  const writes = new Map<string, string>();
  const appends: string[] = [];

  const runGit = async (args: string[]): Promise<RollbackCommandResult> => {
    gitCalls.push(args);
    if (args[0] === "status") return { code: 0, stdout: input.statusOutput ?? "", stderr: "" };
    if (args[0] === "reset") return { code: input.resetCode ?? 0, stdout: "", stderr: "reset failed" };
    return { code: 0, stdout: "", stderr: "" };
  };

  return {
    gitCalls,
    logs,
    writes,
    appends,
    ports: {
      ensureDirs: async () => {},
      isGitRepository: async () => input.isRepo ?? true,
      gitCommitExists: async () => input.commitExists ?? true,
      gitHead: async () => "c".repeat(40),
      gitStatus: async () => "",
      runGit,
      readTextFileIfExists: async (p) => files[rel(p)],
      writeTextFile: async (p, text) => void writes.set(rel(p), text),
      appendTextFile: async (_p, text) => void appends.push(text),
      makeDirectory: async () => {},
      copyPath: async () => {},
      taskScopePaths: async () => input.scopePaths ?? ["src/a.ts"],
      detectPushedRollback: async () =>
        input.pushedBlocked === undefined ? { blocked: false } : { blocked: true, detail: input.pushedBlocked },
      committedTaskWorkSince: async () => input.committedPaths ?? [],
      restoreTaskScope: async () => input.restore ?? { ok: true, restored: ["src/a.ts"] },
      agLog: async (line) => void logs.push(line),
      now: () => NOW,
      ...(input.cleanUntracked === undefined ? {} : { cleanUntracked: input.cleanUntracked }),
    },
  };
}

const STABLE_FILES = { "vq/state/stable-ref": `${REF}\n` };

function gitVerbs(calls: string[][]): string[] {
  return calls.map((args) => args[0] ?? "");
}

test("rollbackStableCommand: ne git repo ir trūkstamas stable-ref — 1 be jokių git veiksmų", async () => {
  const notRepo = world({ isRepo: false });
  const first = captureIo();
  assert.equal(await rollbackStableCommand({ ports: notRepo.ports, projectRoot: ROOT, io: first.io }, []), 1);
  assert.deepEqual(notRepo.gitCalls, []);
  assert.ok(notRepo.logs.includes("ROLLBACK SKIPPED: not a git repository"));

  const noRef = world({});
  const second = captureIo();
  assert.equal(
    await rollbackStableCommand({ ports: noRef.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: second.io }, []),
    1,
  );
  assert.match(second.err[0] ?? "", /^No stable ref available: /);
  assert.ok(!gitVerbs(noRef.gitCalls).includes("reset"));
});

test("rollbackStableCommand: nešvarus medis blokuoja, nufotografuoja ir NEdaro reset'o", async () => {
  const dirty = world({ files: STABLE_FILES, statusOutput: " M src/a.ts\n?? src/new.ts\n" });
  const { io, err } = captureIo();
  const exit = await rollbackStableCommand({ ports: dirty.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, []);

  assert.equal(exit, 1);
  assert.ok(!gitVerbs(dirty.gitCalls).includes("reset"), "užblokuotas kelias niekada nereset'ina");
  assert.match(err[0] ?? "", /^ROLLBACK BLOCKED: non-runtime changes exist\. Snapshot: /);
  // Snapshot'as turi ir manifestą, ir patch'ą — kitaip užblokuotas darbas liktų neužfiksuotas.
  const written = [...dirty.writes.keys()].map(norm);
  assert.ok(written.some((p) => p.endsWith("manifest.txt")));
  assert.ok(written.some((p) => p.endsWith("changes.patch")));
  assert.ok(written.some((p) => p.includes("2026-08-21T12-00-00-000Z")));
});

test("rollbackStableCommand: push'inta istorija blokuoja reset kelią", async () => {
  const pushed = world({ files: STABLE_FILES, pushedBlocked: "2/3 commit(s) since stable-ref already pushed" });
  const { io, err } = captureIo();
  assert.equal(
    await rollbackStableCommand({ ports: pushed.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, []),
    1,
  );
  assert.match(err[0] ?? "", /already pushed.*Move the task to human-review/);
  assert.ok(!gitVerbs(pushed.gitCalls).includes("reset"));
});

test("rollbackStableCommand: švarus medis reset'ina, o clean be leidimo nevykdomas", async () => {
  const clean = world({ files: STABLE_FILES });
  const { io } = captureIo();
  assert.equal(
    await rollbackStableCommand({ ports: clean.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, []),
    0,
  );
  assert.deepEqual(clean.gitCalls.find((args) => args[0] === "reset"), ["reset", "--hard", REF]);
  assert.ok(!gitVerbs(clean.gitCalls).includes("clean"), "untracked failai nešalinami be aiškaus leidimo");
  assert.ok(clean.logs.some((line) => line.startsWith("ROLLBACK CLEAN SKIPPED")));
  assert.ok(clean.logs.includes(`ROLLBACK DONE: ${REF}`));
  assert.equal(clean.appends.length, 2, "prieš ir po būsena įrašoma į error.log");

  const withClean = world({ files: STABLE_FILES, cleanUntracked: true });
  const cleanIo = captureIo();
  assert.equal(
    await rollbackStableCommand(
      { ports: withClean.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: cleanIo.io },
      [],
    ),
    0,
  );
  assert.deepEqual(withClean.gitCalls.find((args) => args[0] === "clean"), ["clean", "-fd"]);
});

test("rollbackStableCommand: nepavykęs reset grąžina git kodą", async () => {
  const failing = world({ files: STABLE_FILES, resetCode: 128 });
  const { io, err } = captureIo();
  assert.equal(
    await rollbackStableCommand({ ports: failing.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, []),
    128,
  );
  assert.equal(err[0], "reset failed");
  assert.ok(failing.logs.includes(`ROLLBACK FAILED: ${REF}`));
});

test("rollbackStableCommand: task-scoped kelias atstato kelius ir NIEKADA nereset'ina", async () => {
  const scoped = world({
    files: { "vq/state/task-start-status.json": JSON.stringify(VALID_BASELINE) },
    scopePaths: ["src/a.ts", "src/b.ts"],
    restore: { ok: true, restored: ["src/a.ts", "src/b.ts"] },
  });
  const { io } = captureIo();
  const exit = await rollbackStableCommand({ ports: scoped.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, [
    "--allow-task-changes",
    "--task-id",
    "0042",
  ]);

  assert.equal(exit, 0);
  assert.ok(!gitVerbs(scoped.gitCalls).includes("reset"), "šakos rodyklė nejuda task-scoped kelyje");
  assert.ok(scoped.logs.some((line) => line.startsWith("ROLLBACK TASK-SCOPED: restored 2 task path(s)")));
  assert.ok(scoped.logs.includes(`ROLLBACK DONE: ${BASE_HEAD}`));
});

test("rollbackStableCommand: jau užcommitintas task'o kelias ir nepavykęs atstatymas — blokuoja", async () => {
  const committed = world({
    files: { "vq/state/task-start-status.json": JSON.stringify(VALID_BASELINE) },
    committedPaths: ["src/a.ts"],
  });
  const first = captureIo();
  assert.equal(
    await rollbackStableCommand(
      { ports: committed.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: first.io },
      ["--allow-task-changes", "--task-id", "0042"],
    ),
    1,
  );
  assert.match(first.err[0] ?? "", /already committed since base_head \(src\/a\.ts\)/);

  const failedRestore = world({
    files: { "vq/state/task-start-status.json": JSON.stringify(VALID_BASELINE) },
    restore: { ok: false, failures: ["checkout src/a.ts"] },
  });
  const second = captureIo();
  assert.equal(
    await rollbackStableCommand(
      { ports: failedRestore.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: second.io },
      ["--allow-task-changes", "--task-id", "0042"],
    ),
    1,
  );
  assert.match(second.err[0] ?? "", /task-scoped restore failed \(checkout src\/a\.ts\)/);
});

test("rollbackStableCommand: sugadintas task-start-status blokuoja, o ne krenta", async () => {
  const broken = world({ files: { "vq/state/task-start-status.json": "{ not json" } });
  const { io, err } = captureIo();
  assert.equal(
    await rollbackStableCommand({ ports: broken.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, [
      "--allow-task-changes",
      "--task-id",
      "0042",
    ]),
    1,
  );
  assert.match(err[0] ?? "", /ROLLBACK BLOCKED: invalid task baseline for task=0042/);
  assert.ok(!gitVerbs(broken.gitCalls).includes("reset"));
});
