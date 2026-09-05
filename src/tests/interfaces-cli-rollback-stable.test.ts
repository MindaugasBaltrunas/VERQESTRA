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
  type TaskScopeCandidates,
  type TaskScopeRestoreOutcome,
} from "../interfaces/cli/bootstrap/rollback-stable.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const REF = "a".repeat(40);
const EXPLICIT_REF = "e".repeat(40);
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
    restore?: TaskScopeRestoreOutcome;
    scopePaths?: string[] | TaskScopeCandidates;
    resetCode?: number;
    cleanUntracked?: boolean;
    gitCommonDir?: string;
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
    if (args[0] === "rev-parse" && input.gitCommonDir !== undefined) {
      return { code: 0, stdout: `${input.gitCommonDir}\n`, stderr: "" };
    }
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

// Bendras iškvietimo helperis: sutraukia captureIo() + rollbackStableCommand() į vieną eilutę.
async function run(ports: RollbackStablePorts, args: string[] = [], root = ROOT, runtimeRoot = RUNTIME_ROOT) {
  const { io, out, err } = captureIo();
  const exit = await rollbackStableCommand({ ports, projectRoot: root, runtimeRoot, io }, args);
  return { exit, out, err };
}

test("rollbackStableCommand: ne git repo ir trūkstamas stable-ref — 1 be jokių git veiksmų", async () => {
  const notRepo = world({ isRepo: false });
  const first = await run(notRepo.ports);
  assert.equal(first.exit, 1);
  assert.deepEqual(notRepo.gitCalls, []);
  assert.ok(notRepo.logs.includes("ROLLBACK SKIPPED: not a git repository"));

  const noRef = world({});
  const second = await run(noRef.ports);
  assert.equal(second.exit, 1);
  assert.match(second.err[0] ?? "", /^No stable ref available: /);
  assert.ok(!gitVerbs(noRef.gitCalls).includes("reset"));
});

test("rollbackStableCommand: nešvarus medis blokuoja, nufotografuoja ir NEdaro reset'o", async () => {
  const dirty = world({ files: STABLE_FILES, statusOutput: " M src/a.ts\n?? src/new.ts\n" });
  const { exit, err } = await run(dirty.ports);

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
  const { exit, err } = await run(pushed.ports);
  assert.equal(exit, 1);
  assert.match(err[0] ?? "", /already pushed.*Move the task to human-review/);
  assert.ok(!gitVerbs(pushed.gitCalls).includes("reset"));
});

test("rollbackStableCommand: švarus medis reset'ina, o clean be leidimo nevykdomas", async () => {
  const clean = world({ files: STABLE_FILES });
  const { exit } = await run(clean.ports);
  assert.equal(exit, 0);
  assert.deepEqual(clean.gitCalls.find((args) => args[0] === "reset"), ["reset", "--hard", REF]);
  assert.ok(!gitVerbs(clean.gitCalls).includes("clean"), "untracked failai nešalinami be aiškaus leidimo");
  assert.ok(clean.logs.some((line) => line.startsWith("ROLLBACK CLEAN SKIPPED")));
  assert.ok(clean.logs.includes(`ROLLBACK DONE: ${REF}`));
  assert.equal(clean.appends.length, 2, "prieš ir po būsena įrašoma į error.log");

  const withClean = world({ files: STABLE_FILES, cleanUntracked: true });
  const withCleanResult = await run(withClean.ports);
  assert.equal(withCleanResult.exit, 0);
  assert.deepEqual(withClean.gitCalls.find((args) => args[0] === "clean"), ["clean", "-fd"]);
});

test("rollbackStableCommand: nepavykęs reset grąžina git kodą", async () => {
  const failing = world({ files: STABLE_FILES, resetCode: 128 });
  const { exit, err } = await run(failing.ports);
  assert.equal(exit, 128);
  assert.equal(err[0], "reset failed");
  assert.ok(failing.logs.includes(`ROLLBACK FAILED: ${REF}`));
});

// ---------------------------------------------------------------------------
// 208: nežinomi argumentai atmetami, `--ref <sha>` įgyvendintas
// ---------------------------------------------------------------------------

test("rollbackStableCommand: argv validacija — nežinomas token'as, --task-scope, trūkstama vertė ir --ref+--allow-task-changes visada 2 be git veiksmo", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["--foo"], /^Usage: verqestra rollback-stable /],
    [["--task-scope"], /^Usage: verqestra rollback-stable /],
    [["--ref"], /^Usage: verqestra rollback-stable /],
    [
      ["--ref", EXPLICIT_REF, "--allow-task-changes", "--task-id", "0042"],
      /--ref cannot be combined with --allow-task-changes/,
    ],
  ];

  for (const [args, expected] of cases) {
    const w = world({ files: STABLE_FILES });
    const { exit, err } = await run(w.ports, args);
    assert.equal(exit, 2);
    assert.deepEqual(w.gitCalls, []);
    assert.match(err[0] ?? "", expected);
  }
});

test("rollbackStableCommand: --ref <sha> švariame medyje reset'ina Į NURODYTĄ ref'ą; neegzistuojantis commit'as, nešvarus medis ir push'inta istorija blokuoja be reset'o", async () => {
  const explicit = world({});
  const clean = await run(explicit.ports, ["--ref", EXPLICIT_REF]);
  assert.equal(clean.exit, 0);
  assert.deepEqual(explicit.gitCalls.find((args) => args[0] === "reset"), ["reset", "--hard", EXPLICIT_REF]);
  assert.ok(explicit.logs.includes(`ROLLBACK DONE: ${EXPLICIT_REF}`));

  const invalidRef = world({ commitExists: false });
  const invalid = await run(invalidRef.ports, ["--ref", EXPLICIT_REF]);
  assert.equal(invalid.exit, 1);
  assert.ok(!gitVerbs(invalidRef.gitCalls).includes("reset"));
  assert.match(invalid.err[0] ?? "", new RegExp(`Invalid ref: ${EXPLICIT_REF}`));
  assert.ok(invalidRef.logs.includes(`ROLLBACK SKIPPED: invalid ref=${EXPLICIT_REF}`));

  const dirtyRef = world({ statusOutput: " M src/a.ts\n" });
  const dirty = await run(dirtyRef.ports, ["--ref", EXPLICIT_REF]);
  assert.equal(dirty.exit, 1);
  assert.ok(!gitVerbs(dirtyRef.gitCalls).includes("reset"));
  assert.match(dirty.err[0] ?? "", /^ROLLBACK BLOCKED: non-runtime changes exist\. Snapshot: /);

  const pushedRef = world({ pushedBlocked: "1/1 commit(s) since ref already pushed" });
  const pushed = await run(pushedRef.ports, ["--ref", EXPLICIT_REF]);
  assert.equal(pushed.exit, 1);
  assert.ok(!gitVerbs(pushedRef.gitCalls).includes("reset"));
  assert.match(pushed.err[0] ?? "", /already pushed.*Move the task to human-review/);
});

test("rollbackStableCommand: task-scoped kelias atstato kelius ir NIEKADA nereset'ina", async () => {
  const scoped = world({
    files: { "vq/state/task-start-status.json": JSON.stringify(VALID_BASELINE) },
    scopePaths: ["src/a.ts", "src/b.ts"],
    restore: { ok: true, restored: ["src/a.ts", "src/b.ts"] },
  });
  const { exit } = await run(scoped.ports, ["--allow-task-changes", "--task-id", "0042"]);

  assert.equal(exit, 0);
  assert.ok(!gitVerbs(scoped.gitCalls).includes("reset"), "šakos rodyklė nejuda task-scoped kelyje");
  assert.ok(scoped.logs.some((line) => line.startsWith("ROLLBACK TASK-SCOPED: restored 2 task path(s)")));
  assert.ok(scoped.logs.includes(`ROLLBACK DONE: ${BASE_HEAD}`));
});

test("rollbackStableCommand: išsaugotas necommit'intas darbas matomas išvestyje ir būsenos įraše", async () => {
  const preserved = {
    ref: `refs/verqestra/preserved/${"d".repeat(40)}`,
    commit: "d".repeat(40),
    baseRef: BASE_HEAD,
    paths: ["src/a.ts", "src/b.ts"],
  };
  const scoped = world({
    files: { "vq/state/task-start-status.json": JSON.stringify(VALID_BASELINE) },
    scopePaths: ["src/a.ts", "src/b.ts"],
    restore: { ok: true, restored: ["src/a.ts", "src/b.ts"], preserved },
  });
  const { exit, out } = await run(scoped.ports, ["--allow-task-changes", "--task-id", "0042"]);

  assert.equal(exit, 0);
  const preservedLine = out.find((line) => line.startsWith("ROLLBACK PRESERVED: "));
  assert.ok(preservedLine, "operatorius turi pamatyti, kur guli išsaugotas darbas");
  assert.match(preservedLine ?? "", /task=0042 ref=refs\/verqestra\/preserved\/d{40} commit=d{40} paths=2 record=/);
  assert.ok(
    scoped.logs.some((line) => line.startsWith("ROLLBACK PRESERVED: ")),
    "ta pati eilutė turi eiti ir į agLog",
  );

  const preservedIndex = out.indexOf(preservedLine ?? "");
  const restoredLogIndex = scoped.logs.findIndex((line) => line.startsWith("ROLLBACK TASK-SCOPED: restored"));
  assert.ok(preservedIndex >= 0 && restoredLogIndex >= 0);
  assert.ok(
    scoped.logs.indexOf(preservedLine ?? "") < restoredLogIndex,
    "PRESERVED eilutė eina prieš TASK-SCOPED santrauką",
  );

  const recordEntry = [...scoped.writes.entries()].find(([key]) => norm(key).endsWith("rollback-preserved/0042.json"));
  assert.ok(recordEntry, "būsenos įrašas turi būti parašytas per writeTextFile portą");
  const record = JSON.parse(recordEntry?.[1] ?? "{}") as Record<string, unknown>;
  assert.equal(record["task_id"], "0042");
  assert.equal(record["ref"], preserved.ref);
  assert.equal(record["commit"], preserved.commit);
  assert.equal(record["base_ref"], BASE_HEAD);
  assert.deepEqual(record["paths"], preserved.paths);
  assert.equal(record["recorded_at"], NOW.toISOString());
  assert.equal(record["created_at"], NOW.toISOString());
  assert.equal(record["run_id"], undefined);
  assert.ok(scoped.logs.some((line) => line.startsWith("ROLLBACK PRESERVED ROOT FALLBACK: ")));
});

test("rollbackStableCommand: preserved įrašas eina į PIRMINIO medžio vq/ ir neša --run-id", async () => {
  const worktreeRoot = path.join(ROOT, "worktrees", "w1");
  const worktreeRuntimeRoot = path.join(worktreeRoot, "vq");
  const preserved = { ref: `refs/verqestra/preserved/${"d".repeat(40)}`, commit: "d".repeat(40), baseRef: BASE_HEAD, paths: ["src/a.ts"] };
  const scoped = world({
    files: { [rel(path.join(worktreeRuntimeRoot, "state", "task-start-status.json"))]: JSON.stringify(VALID_BASELINE) },
    scopePaths: ["src/a.ts"],
    restore: { ok: true, restored: ["src/a.ts"], preserved },
    gitCommonDir: path.join(ROOT, ".git"),
  });
  const args = ["--allow-task-changes", "--task-id", "0042", "--run-id", "run-777"];
  const { exit, out } = await run(scoped.ports, args, worktreeRoot, worktreeRuntimeRoot);

  assert.equal(exit, 0);
  const preservedLine = norm(out.find((line) => line.startsWith("ROLLBACK PRESERVED: ")) ?? "");
  const expectedRecordPath = norm(path.join(RUNTIME_ROOT, "state", "rollback-preserved", "0042.json"));
  assert.ok(preservedLine.includes(`record=${expectedRecordPath}`), "įrašas turi gulėti pirminio medžio vq/");
  const recordEntry = [...scoped.writes.entries()].find(([key]) => norm(key) === "vq/state/rollback-preserved/0042.json");
  assert.ok(recordEntry, "įrašas turi gulėti pirminio medžio vq/state/rollback-preserved/ kelyje");
  assert.equal((JSON.parse(recordEntry?.[1] ?? "{}") as Record<string, unknown>)["run_id"], "run-777");
});

test("rollbackStableCommand: kai išsaugojimo nėra, elgesys nesikeičia — jokios PRESERVED eilutės ar įrašo", async () => {
  const scoped = world({
    files: { "vq/state/task-start-status.json": JSON.stringify(VALID_BASELINE) },
    scopePaths: ["src/a.ts", "src/b.ts"],
    restore: { ok: true, restored: ["src/a.ts", "src/b.ts"] },
  });
  const { exit, out } = await run(scoped.ports, ["--allow-task-changes", "--task-id", "0042"]);

  assert.equal(exit, 0);
  assert.ok(!out.some((line) => line.startsWith("ROLLBACK PRESERVED:")));
  assert.ok(!scoped.logs.some((line) => line.startsWith("ROLLBACK PRESERVED:")));
  assert.ok(![...scoped.writes.keys()].some((key) => norm(key).includes("rollback-preserved")));
});

test("rollbackStableCommand: svetimas ir nenustatomos savininkystės keliai išvardyti ataskaitoje ir NEatstatyti", async () => {
  const candidates: TaskScopeCandidates = {
    paths: ["src/a.ts"],
    foreign: ["src/foreign.ts"],
    skipped: [{ path: "src/unknown.ts", reason: "no-ownership-record" }],
  };
  const scoped = world({
    files: { "vq/state/task-start-status.json": JSON.stringify(VALID_BASELINE) },
    scopePaths: candidates,
    restore: { ok: true, restored: ["src/a.ts"] },
  });
  const { exit, err } = await run(scoped.ports, ["--allow-task-changes", "--task-id", "0042"]);

  assert.equal(exit, 0, "geri keliai vis tiek atstatomi — praleidimas neblokuoja");
  assert.ok(!gitVerbs(scoped.gitCalls).includes("reset"));
  const message = err.find((line) => line.startsWith("ROLLBACK SKIPPED PATHS: "));
  assert.ok(message, "svetimi/nežinomi keliai turi pasiekti stderr");
  assert.match(message ?? "", /foreign=src\/foreign\.ts/);
  assert.match(message ?? "", /unknown-owner=src\/unknown\.ts \(no-ownership-record\)/);
  assert.ok(
    scoped.logs.some((line) => line.startsWith("ROLLBACK SKIPPED PATHS: ")),
    "ta pati eilutė turi eiti ir į AG žurnalą",
  );
  assert.ok(scoped.logs.some((line) => line.startsWith("ROLLBACK TASK-SCOPED: restored 1 task path(s)")));
});

test("rollbackStableCommand: be praleistų kelių — jokios ROLLBACK SKIPPED PATHS eilutės", async () => {
  const scoped = world({
    files: { "vq/state/task-start-status.json": JSON.stringify(VALID_BASELINE) },
    scopePaths: ["src/a.ts", "src/b.ts"],
    restore: { ok: true, restored: ["src/a.ts", "src/b.ts"] },
  });
  const { exit, err } = await run(scoped.ports, ["--allow-task-changes", "--task-id", "0042"]);

  assert.equal(exit, 0);
  assert.ok(!err.some((line) => line.startsWith("ROLLBACK SKIPPED PATHS:")));
  assert.ok(!scoped.logs.some((line) => line.startsWith("ROLLBACK SKIPPED PATHS:")));
});

test("rollbackStableCommand: jau užcommitintas task'o kelias ir nepavykęs atstatymas — blokuoja", async () => {
  const committed = world({
    files: { "vq/state/task-start-status.json": JSON.stringify(VALID_BASELINE) },
    committedPaths: ["src/a.ts"],
  });
  const first = await run(committed.ports, ["--allow-task-changes", "--task-id", "0042"]);
  assert.equal(first.exit, 1);
  assert.match(first.err[0] ?? "", /already committed since base_head \(src\/a\.ts\)/);

  const failedRestore = world({
    files: { "vq/state/task-start-status.json": JSON.stringify(VALID_BASELINE) },
    restore: { ok: false, failures: ["checkout src/a.ts"] },
  });
  const second = await run(failedRestore.ports, ["--allow-task-changes", "--task-id", "0042"]);
  assert.equal(second.exit, 1);
  assert.match(second.err[0] ?? "", /task-scoped restore failed \(checkout src\/a\.ts\)/);
});

test("rollbackStableCommand: sugadintas task-start-status blokuoja, o ne krenta", async () => {
  const broken = world({ files: { "vq/state/task-start-status.json": "{ not json" } });
  const { exit, err } = await run(broken.ports, ["--allow-task-changes", "--task-id", "0042"]);
  assert.equal(exit, 1);
  assert.match(err[0] ?? "", /ROLLBACK BLOCKED: invalid task baseline for task=0042/);
  assert.ok(!gitVerbs(broken.gitCalls).includes("reset"));
});
