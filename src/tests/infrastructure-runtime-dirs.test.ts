// VQ-504 (7/N) testai — runtime katalogų paruošimas. Pin'inama, kad task'ų bucket'ai lieka po
// `AG/tasks`, būsena keliauja į `vq/*`, o esamas `retry-counts.json` NIEKADA neperrašomas.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureRuntimeDirs, runtimeDirectories } from "../infrastructure/state/runtime-dirs.js";

test("runtimeDirectories: eilės po AG/tasks, būsena po vq", () => {
  const dirs = runtimeDirectories(path.join("/repo", "AG"), path.join("/repo", "vq"));
  assert.ok(dirs.includes(path.join("/repo", "AG", "tasks", "queue")));
  assert.ok(dirs.includes(path.join("/repo", "vq", "state")));
  assert.ok(
    !dirs.includes(path.join("/repo", "AG", "state")),
    "būsena į AG negrįžta — tai šio produkto runtime",
  );
});

test("ensureRuntimeDirs: sukuria katalogus ir pasėja retry skaitiklius", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vq-runtime-dirs-"));
  try {
    const agRoot = path.join(root, "AG");
    const runtimeRoot = path.join(root, "vq");
    await ensureRuntimeDirs(agRoot, runtimeRoot);

    assert.ok((await stat(path.join(agRoot, "tasks", "queue"))).isDirectory());
    assert.ok((await stat(path.join(runtimeRoot, "logs"))).isDirectory());
    assert.equal(await readFile(path.join(runtimeRoot, "state", "retry-counts.json"), "utf8"), "{}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureRuntimeDirs: esami retry skaitikliai NEPERRAŠOMI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vq-runtime-dirs-"));
  try {
    const runtimeRoot = path.join(root, "vq");
    await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
    const existing = JSON.stringify({ "0042": 3 });
    await writeFile(path.join(runtimeRoot, "state", "retry-counts.json"), existing, "utf8");

    await ensureRuntimeDirs(path.join(root, "AG"), runtimeRoot);

    // Perrašymas grąžintų jau išnaudotus retry biudžetus į nulį — task'as ciklintų amžinai.
    assert.equal(await readFile(path.join(runtimeRoot, "state", "retry-counts.json"), "utf8"), existing);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
