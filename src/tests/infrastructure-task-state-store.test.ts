// VQ-504 (5/N) testai — task būsenos saugykla ant REALIOS failų sistemos. Svarbiausia, ką jie
// pin'ina: kolizija gauna sufiksą (o ne perrašo svetimo failo), perkėlimas į `failed` nusileidžia
// į `human-review` (domain taisyklė), nuosavybės vartai stovi PRIEŠ bet kokį judinimą, o lock'as
// atlaisvinamas ir po klaidos.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTaskStateStore, taskMoveLockTiming } from "../infrastructure/state/task-state-store.js";

async function makeWorld(): Promise<{ root: string; agRoot: string; runtimeRoot: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "vq-task-state-"));
  const agRoot = path.join(root, "AG");
  const runtimeRoot = path.join(root, "vq");
  await mkdir(path.join(agRoot, "tasks", "queue"), { recursive: true });
  return { root, agRoot, runtimeRoot, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("taskMoveLockTiming: deadline PRIVALO viršyti stale ribą", () => {
  // Kitaip kritusio proceso lock'as išnaudotų mūsų deadline'ą dar nespėjus jo perimti.
  assert.ok(taskMoveLockTiming.timeoutMs > taskMoveLockTiming.staleMs);
});

test("moveTaskState: perkelia, atnaujina žymę ir kolizijai duoda sufiksą", async () => {
  const world = await makeWorld();
  try {
    const store = createTaskStateStore({ agRoot: world.agRoot, runtimeRoot: world.runtimeRoot });
    const source = path.join(world.agRoot, "tasks", "queue", "0042.md");
    const activeDir = path.join(world.agRoot, "tasks", "active");
    await writeFile(source, "# Task", "utf8");

    const moved = await store.moveTaskState(source, activeDir, "0042.md");
    assert.equal(moved, path.join(activeDir, "0042.md"));
    assert.equal(
      (await readFile(path.join(world.runtimeRoot, "state", "current-task-file"), "utf8")).trim(),
      moved,
    );

    // Antras to paties vardo perkėlimas NEPERRAŠO pirmojo.
    await writeFile(source, "# Kitas", "utf8");
    const second = await store.moveTaskState(source, activeDir, "0042.md", { updateCurrent: false });
    assert.equal(second, path.join(activeDir, "0042-2.md"));
    assert.equal(await readFile(path.join(activeDir, "0042.md"), "utf8"), "# Task");
  } finally {
    await world.cleanup();
  }
});

test("readTaskText/writeTaskText: apvalus ratas ir trūkstamas failas kaip atsakymas (092)", async () => {
  const world = await makeWorld();
  try {
    const store = createTaskStateStore({ agRoot: world.agRoot, runtimeRoot: world.runtimeRoot });
    const file = path.join(world.agRoot, "tasks", "queue", "0042.md");
    assert.equal(await store.readTaskText(file), undefined, "nebuvimas — atsakymas, ne klaida");
    await store.writeTaskText(file, "# Task\n");
    assert.equal(await store.readTaskText(file), "# Task\n");
  } finally {
    await world.cleanup();
  }
});

test("moveTaskState: `failed` nusileidžia į `human-review` (domain taisyklė)", async () => {
  const world = await makeWorld();
  try {
    const store = createTaskStateStore({ agRoot: world.agRoot, runtimeRoot: world.runtimeRoot });
    const source = path.join(world.agRoot, "tasks", "queue", "0042.md");
    await writeFile(source, "# Task", "utf8");

    const moved = await store.moveTaskState(source, path.join(world.agRoot, "tasks", "failed"), "0042.md");
    assert.equal(path.basename(path.dirname(moved)), "human-review");
  } finally {
    await world.cleanup();
  }
});

test("nuosavybės vartai stovi PRIEŠ judinimą — atmestas perkėlimas nieko nepajudina", async () => {
  const world = await makeWorld();
  try {
    const seen: string[] = [];
    const store = createTaskStateStore({
      agRoot: world.agRoot,
      runtimeRoot: world.runtimeRoot,
      assertAuthority: (taskId) => {
        seen.push(taskId);
        return Promise.reject(new Error("lease prarastas"));
      },
    });
    const source = path.join(world.agRoot, "tasks", "queue", "0042.md");
    await writeFile(source, "# Task", "utf8");

    await assert.rejects(
      () => store.moveTaskState(source, path.join(world.agRoot, "tasks", "active"), "0042.md"),
      /lease prarastas/,
    );
    assert.deepEqual(seen, ["0042"]);
    // Failas liko vietoje: failų sistema tokio sprendimo priimti negali, tad vartai eina pirmi.
    assert.equal(await readFile(source, "utf8"), "# Task");
  } finally {
    await world.cleanup();
  }
});

test("finishTaskState: išvalo palydovus, bet NIEKADA šaltinio ar taikinio", async () => {
  const world = await makeWorld();
  try {
    const store = createTaskStateStore({ agRoot: world.agRoot, runtimeRoot: world.runtimeRoot });
    const source = path.join(world.agRoot, "tasks", "active", "0042.md");
    const companion = path.join(world.runtimeRoot, "state", "0042.prompt.md");
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(companion), { recursive: true });
    await writeFile(source, "# Task", "utf8");
    await writeFile(companion, "prompt", "utf8");

    const done = await store.finishTaskState(source, path.join(world.agRoot, "tasks", "done"), "0042.md", [
      companion,
      source,
    ]);
    assert.equal(path.basename(path.dirname(done)), "done");
    assert.equal(await readFile(done, "utf8"), "# Task", "taikinys niekada nevalomas");
    await assert.rejects(() => readFile(companion, "utf8"));
  } finally {
    await world.cleanup();
  }
});

test("activateTaskFile: įrašo task id ir žymę, o lock'as lieka atlaisvintas", async () => {
  const world = await makeWorld();
  try {
    const store = createTaskStateStore({ agRoot: world.agRoot, runtimeRoot: world.runtimeRoot });
    const source = path.join(world.agRoot, "tasks", "queue", "0042.md");
    await writeFile(source, "# Task", "utf8");

    const active = await store.activateTaskFile(source, path.join(world.agRoot, "tasks", "active", "0042.md"), "0042");
    assert.equal(
      (await readFile(path.join(world.runtimeRoot, "state", "current-task-id"), "utf8")).trim(),
      "0042",
    );
    assert.equal(path.basename(active), "0042.md");

    // Lock'o katalogas neturi likti gulėti: kitaip kitas perkėlimas lauktų iki stale ribos.
    await assert.rejects(() => readFile(path.join(world.agRoot, "state", "task-move.lock", "owner.json"), "utf8"));
  } finally {
    await world.cleanup();
  }
});

test("nesamas šaltinis meta, o lock'as vis tiek atlaisvinamas", async () => {
  const world = await makeWorld();
  try {
    const store = createTaskStateStore({ agRoot: world.agRoot, runtimeRoot: world.runtimeRoot });
    await assert.rejects(
      () =>
        store.moveTaskState(
          path.join(world.agRoot, "tasks", "queue", "nera.md"),
          path.join(world.agRoot, "tasks", "active"),
          "nera.md",
        ),
      /source file does not exist/,
    );

    // Po klaidos lock'as privalo būti atlaisvintas — kitaip vienas gedimas užrakintų eilę.
    await assert.rejects(() => readFile(path.join(world.agRoot, "state", "task-move.lock", "owner.json"), "utf8"));
  } finally {
    await world.cleanup();
  }
});

test("lygiagretūs perkėlimai serializuojami: abu failai išlieka su skirtingais vardais", async () => {
  const world = await makeWorld();
  try {
    const store = createTaskStateStore({ agRoot: world.agRoot, runtimeRoot: world.runtimeRoot });
    const activeDir = path.join(world.agRoot, "tasks", "active");
    const first = path.join(world.agRoot, "tasks", "queue", "a.md");
    const second = path.join(world.agRoot, "tasks", "queue", "b.md");
    await writeFile(first, "# A", "utf8");
    await writeFile(second, "# B", "utf8");

    const [movedA, movedB] = await Promise.all([
      store.moveTaskState(first, activeDir, "0042.md", { updateCurrent: false }),
      store.moveTaskState(second, activeDir, "0042.md", { updateCurrent: false }),
    ]);

    assert.notEqual(movedA, movedB, "be serializacijos vienas perkėlimas prarastų kitą");
    assert.deepEqual(
      [await readFile(movedA, "utf8"), await readFile(movedB, "utf8")].sort(),
      ["# A", "# B"],
    );
  } finally {
    await world.cleanup();
  }
});
