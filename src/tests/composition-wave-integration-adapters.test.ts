// VQ-504 (47/N) testai — integracijos adapterių sprendimai ant tikros failų sistemos.
//
// Tikrinama ta dalis, kuri NEREIKALAUJA git medžio: kur adapteris mato task'ą ir kada jis
// atsisako jį judinti. Būtent čia gyvena taisyklė, kurią tyliai prarasti lengviausia —
// terminalinis bucket'as į `done` neperrašomas, nes tai panaikintų žmogaus sprendimą.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWaveIntegrationAdapters } from "../composition/loop/wave-integration-adapters.js";
import type { TaskStateStorePort } from "../application/task-execution/bucket-transition.js";

let root = "";
let agRoot = "";
const moves: { from: string; toDir: string }[] = [];

const taskStore: TaskStateStorePort = {
  moveTaskState: (from, toDir) => {
    moves.push({ from, toDir });
    return Promise.resolve(path.join(toDir, path.basename(from)));
  },
  finishTaskState: (from, toDir) => {
    moves.push({ from, toDir });
    return Promise.resolve(path.join(toDir, path.basename(from)));
  },
  activateTaskFile: (taskFile) => Promise.resolve(taskFile),
  readTaskText: () => Promise.resolve(undefined),
  writeTaskText: () => Promise.resolve(),
};

function adapters(): ReturnType<typeof createWaveIntegrationAdapters> {
  return createWaveIntegrationAdapters({
    projectRoot: root,
    agRoot,
    taskStore,
    leaseStore: { fs: {} as never },
    readWorkerLeases: () => Promise.resolve([]),
  });
}

async function placeTask(bucket: string, taskId: string): Promise<void> {
  const dir = path.join(agRoot, "tasks", bucket);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${taskId}.md`), `# ${taskId}\n`, "utf8");
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vq-504-int-"));
  agRoot = path.join(root, "AG");
  await placeTask("queue", "0001");
  await placeTask("active", "0002");
  await placeTask("done", "0003");
  await placeTask("human-review", "0004");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("task'o vieta atpažįstama pagal bucket'ą", async () => {
  const port = adapters();
  assert.equal(await port.locateTask("0001"), "queue");
  assert.equal(await port.locateTask("0002"), "active");
  assert.equal(await port.locateTask("0003"), "terminal-bucket");
  assert.equal(await port.locateTask("0004"), "terminal-bucket");
  // Nesantis task'as yra ATSAKYMAS, ne klaida: integracija iš jo sprendžia apie prarastą darbą.
  assert.equal(await port.locateTask("9999"), "absent");
});

test("jau `done` bucket'e esantis failas nejudinamas", async () => {
  moves.length = 0;
  assert.equal(await adapters().relocateTask("0003", "done"), "already");
  assert.deepEqual(moves, []);
});

test("`human-review` į `done` NEPERRAŠOMAS", async () => {
  moves.length = 0;
  // Kitaip integracija panaikintų žmogaus sprendimą, priimtą dėl to paties task'o.
  assert.equal(await adapters().relocateTask("0004", "done"), "kept");
  assert.deepEqual(moves, []);
});

test("aktyvus task'as perkeliamas į `done`", async () => {
  moves.length = 0;
  assert.equal(await adapters().relocateTask("0002", "done"), "moved");
  assert.equal(moves.length, 1);
  assert.ok(moves[0]?.toDir.endsWith(path.join("tasks", "done")));
});

test("nesantis failas grąžina `absent`, o ne meta", async () => {
  assert.equal(await adapters().relocateTask("9999", "done"), "absent");
});

test("esamas `done` failas laikomas atstatytu be git kvietimo", async () => {
  const restored = await adapters().restoreDoneCopy({ taskId: "0003", preMergeHead: undefined });
  assert.equal(restored.ok, true);
  assert.ok(restored.ok && restored.source.startsWith("already:"));
});

test("maketas grąžina santykinį kelią ir šaką", () => {
  const layout = adapters().resolveWorktreeLayout({ run_id: "r1", worker_id: "w2", task_id: "0002", attempt: 1 });
  assert.ok(layout.relativePath.includes("worktrees"));
  assert.ok(layout.branch.length > 0);
});

test("trūkstamas vaiko telemetrijos failas: appended=0 be klaidos", async () => {
  const harvested = await adapters().collectWorktreeTelemetry({ worktreePath: "no-such-worktree", task_id: "0005" });
  assert.deepEqual(harvested, { appended: 0, detail: "" });
});

test("vaiko telemetrija APPEND'inama į pagrindinio medžio žurnalą su dedup'u", async () => {
  const worktreeRel = "worktree-telemetry-a";
  const logsDir = path.join(root, worktreeRel, "vq", "logs");
  await mkdir(logsDir, { recursive: true });
  const line1 = JSON.stringify({ ts: "2026-09-02T10:00:00.000Z", task_id: "0005", attempt_id: "att-1", context_chars: 10 });
  const line2 = JSON.stringify({ ts: "2026-09-02T10:00:01.000Z", task_id: "0005", attempt_id: "att-1", context_chars: 20 });
  await writeFile(path.join(logsDir, "context-size.jsonl"), `${line1}\n${line2}\n`, "utf8");

  const first = await adapters().collectWorktreeTelemetry({ worktreePath: worktreeRel, task_id: "0005" });
  assert.equal(first.appended, 2);

  const mainLog = await readFile(path.join(root, "vq", "logs", "context-size.jsonl"), "utf8");
  assert.equal(mainLog.split("\n").filter((l) => l.trim() !== "").length, 2);

  // Pakartotinis kvietimas su tomis pačiomis eilutėmis: dedup'as neprideda nieko antrą kartą.
  const second = await adapters().collectWorktreeTelemetry({ worktreePath: worktreeRel, task_id: "0005" });
  assert.deepEqual(second, { appended: 0, detail: "" });
});

test("neparsinama eilutė praleidžiama tyliai, su detale žurnale", async () => {
  const worktreeRel = "worktree-telemetry-b";
  const logsDir = path.join(root, worktreeRel, "vq", "logs");
  await mkdir(logsDir, { recursive: true });
  const good = JSON.stringify({ ts: "2026-09-02T11:00:00.000Z", task_id: "0006", attempt_id: "att-1" });
  await writeFile(path.join(logsDir, "token-usage.jsonl"), `${good}\nnot-json\n`, "utf8");

  const harvested = await adapters().collectWorktreeTelemetry({ worktreePath: worktreeRel, task_id: "0006" });
  assert.equal(harvested.appended, 1);
  assert.ok(harvested.detail.includes("token-usage.jsonl"));
  assert.ok(harvested.detail.includes("1 neparsinama"));
});
