// VQ-504 (47/N) testai — integracijos adapterių sprendimai ant tikros failų sistemos.
//
// Tikrinama ta dalis, kuri NEREIKALAUJA git medžio: kur adapteris mato task'ą ir kada jis
// atsisako jį judinti. Būtent čia gyvena taisyklė, kurią tyliai prarasti lengviausia —
// terminalinis bucket'as į `done` neperrašomas, nes tai panaikintų žmogaus sprendimą.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWaveIntegrationAdapters } from "../composition/wave-integration-adapters.js";
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
