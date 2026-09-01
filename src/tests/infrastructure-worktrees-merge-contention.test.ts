// w2 merge audito (2026-09-01) regresijos: (1) `index.lock` kontencija integracijoje gauna
// bounded retry vietoj merge-infrastructure parkinimo (GeoGravity 1132/1154-b-03/1156);
// (2) kopija, nešvari VIEN runtime šiukšlėmis, po integracijos pašalinama `--force` vietoj
// amžino RESIDUE (14/14 merge'ų iki audito), o realus neintegruotas kelias RESIDUE išlaiko.
// REALUS git laikinose repozitorijose — jokio teksto mock'inimo.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { integrateWorktreeBranch } from "../infrastructure/git/worktrees/worktree-branch-integration.js";
import { removeWorktreeDirectory } from "../infrastructure/git/worktrees/worktree-removal.js";

async function initRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  async function git(...args: string[]): Promise<void> {
    const result = await run("git", ["-C", dir, ...args]);
    assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  await git("init");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.autocrlf", "false");
  await nodeFsAdapter.writeTextFile(path.join(dir, ".gitignore"), ".ag/\n");
  await nodeFsAdapter.writeTextFile(path.join(dir, "src", "a.ts"), "pradinis\n");
  await git("add", "--all");
  await git("commit", "-m", "pradinis");
  return dir;
}

/** Worktree su vienu commit'u šakoje — integracijai paruošta kopija. */
async function addWorktreeWithCommit(dir: string, branch: string, name: string): Promise<string> {
  const wt = path.join(dir, ".ag", name);
  assert.equal((await run("git", ["-C", dir, "worktree", "add", "-b", branch, wt, "HEAD"])).code, 0);
  await nodeFsAdapter.writeTextFile(path.join(wt, "src", `${name}.ts`), "darbas\n");
  assert.equal((await run("git", ["-C", wt, "add", "--all"])).code, 0);
  assert.equal((await run("git", ["-C", wt, "commit", "-m", `${name} darbas`])).code, 0);
  return wt;
}

test("index.lock kontencija: laikinas lock'as -> retry integruoja, o ne parkina", async () => {
  const dir = await initRepo("vq-wtlock-");
  try {
    await addWorktreeWithCommit(dir, "ag/test/lock-transient", "lockt");

    const lockPath = path.join(dir, ".git", "index.lock");
    await nodeFsAdapter.writeTextFile(lockPath, "");
    // Lock'as paleidžiamas po ~2 retry langų — kaip trumpas primary-tree stop hook commit'as.
    const release = setTimeout(() => {
      void rm(lockPath, { force: true });
    }, 250);

    const integrated = await integrateWorktreeBranch({
      projectRoot: dir,
      branch: "ag/test/lock-transient",
      taskId: "lockt",
      indexLockRetry: { attempts: 8, delayMs: 100 },
    });
    clearTimeout(release);
    assert.equal(integrated.status, "integrated", JSON.stringify(integrated));
    assert.equal(await nodeFsAdapter.exists(path.join(dir, "src", "lockt.ts")), true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("index.lock kontencija: pastovus lock'as -> bounded bandymai baigiasi infrastructure", async () => {
  const dir = await initRepo("vq-wtlockp-");
  try {
    await addWorktreeWithCommit(dir, "ag/test/lock-stuck", "locks");

    const lockPath = path.join(dir, ".git", "index.lock");
    await nodeFsAdapter.writeTextFile(lockPath, "");
    const outcome = await integrateWorktreeBranch({
      projectRoot: dir,
      branch: "ag/test/lock-stuck",
      indexLockRetry: { attempts: 2, delayMs: 50 },
    });
    assert.equal(outcome.status, "infrastructure", JSON.stringify(outcome));
    // Darbas neintegruotas ir šaka gyva — parkinta baigtis lieka atstatoma.
    assert.equal(await nodeFsAdapter.exists(path.join(dir, "src", "locks.ts")), false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("runtime šiukšlės kopijoje: remove praeina su runtime-junk fallback'u", async () => {
  const dir = await initRepo("vq-wtjunk-");
  try {
    const wt = await addWorktreeWithCommit(dir, "ag/test/junk", "junk");
    assert.equal((await integrateWorktreeBranch({ projectRoot: dir, branch: "ag/test/junk" })).status, "integrated");

    // Runtime pėdsakai, kuriuos palieka orkestratorius/stop bridge — ne task'o darbas.
    await nodeFsAdapter.writeTextFile(path.join(wt, "vq", "logs", "orchestrator.log"), "log\n");
    await nodeFsAdapter.writeTextFile(path.join(wt, "AG", "state", "claude-stop-status.json"), "{}\n");
    await nodeFsAdapter.writeTextFile(path.join(wt, "logs", "tasks", "junk-commit-msg.md"), "msg\n");

    const removed = await removeWorktreeDirectory(run, dir, wt, undefined, { runtimeJunkForce: true });
    assert.equal(removed.status, "removed", JSON.stringify(removed));
    if (removed.status === "removed") assert.equal(removed.fallback, "runtime-junk");
    assert.equal(await nodeFsAdapter.exists(wt), false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("realus neintegruotas kelias kopijoje: remove atsisako (RESIDUE lieka)", async () => {
  const dir = await initRepo("vq-wtwork-");
  try {
    const wt = await addWorktreeWithCommit(dir, "ag/test/left", "left");
    assert.equal((await integrateWorktreeBranch({ projectRoot: dir, branch: "ag/test/left" })).status, "integrated");

    // Produkto kelias — galimai pamestas darbas; force čia niekada neleidžiamas.
    await nodeFsAdapter.writeTextFile(path.join(wt, "src", "liko.ts"), "neintegruota\n");

    const removed = await removeWorktreeDirectory(run, dir, wt, undefined, { runtimeJunkForce: true });
    assert.equal(removed.status, "infrastructure", JSON.stringify(removed));
    assert.equal(await nodeFsAdapter.exists(path.join(wt, "src", "liko.ts")), true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("mišrus nešvarumas (šiukšlės + produkto kelias): force nebandomas", async () => {
  const dir = await initRepo("vq-wtmix-");
  try {
    const wt = await addWorktreeWithCommit(dir, "ag/test/mixed", "mixed");
    assert.equal((await integrateWorktreeBranch({ projectRoot: dir, branch: "ag/test/mixed" })).status, "integrated");

    await nodeFsAdapter.writeTextFile(path.join(wt, "vq", "logs", "x.log"), "log\n");
    await nodeFsAdapter.writeTextFile(path.join(wt, "src", "liko.ts"), "neintegruota\n");

    const removed = await removeWorktreeDirectory(run, dir, wt, undefined, { runtimeJunkForce: true });
    assert.equal(removed.status, "infrastructure", JSON.stringify(removed));
    assert.equal(await nodeFsAdapter.exists(path.join(wt, "src", "liko.ts")), true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
