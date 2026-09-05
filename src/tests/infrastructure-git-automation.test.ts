// clearStaleIndexLock lock'o kelio testai (task 196): REALUS git laikinose repozitorijose, be
// teksto mock'inimo. `.git/index.lock` kelias sprendžiamas per `git rev-parse
// --absolute-git-dir`, ne `path.join(projectRoot, ".git", "index.lock")` — linked worktree'e
// `.git` yra failas (gitdir rodyklė), o tikras lock'as gyvena
// `<main>/.git/worktrees/<name>/index.lock` (incidento reprodukcija čia yra 3-ias testas).

import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { clearStaleIndexLock, commitAndPush } from "../infrastructure/git/git-automation.js";

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
  await nodeFsAdapter.writeTextFile(path.join(dir, "src", "a.ts"), "pradinis\n");
  await git("add", "--all");
  await git("commit", "-m", "pradinis");
  return dir;
}

/** Lock'o failas — senas (pasenęs pagal STALE_INDEX_LOCK_MS) arba šviežias. */
async function writeLock(lockPath: string, stale: boolean): Promise<void> {
  await nodeFsAdapter.writeTextFile(lockPath, "");
  if (stale) {
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
  }
}

test("pagrindiniame repo: pasenęs index.lock pašalinamas, commitAndPush retry pavyksta", async () => {
  const dir = await initRepo("vq-gitauto-stale-");
  try {
    await nodeFsAdapter.writeTextFile(path.join(dir, "src", "b.ts"), "antras\n");
    await writeLock(path.join(dir, ".git", "index.lock"), true);

    const result = await commitAndPush(dir, "antras commit", undefined, { push: false, paths: ["src/b.ts"] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await nodeFsAdapter.exists(path.join(dir, ".git", "index.lock")), false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pagrindiniame repo: šviežias index.lock paliekamas, commit'as grąžina ok:false step:add", async () => {
  const dir = await initRepo("vq-gitauto-fresh-");
  try {
    await nodeFsAdapter.writeTextFile(path.join(dir, "src", "b.ts"), "antras\n");
    const lockPath = path.join(dir, ".git", "index.lock");
    await writeLock(lockPath, false);

    const result = await commitAndPush(dir, "antras commit", undefined, { push: false, paths: ["src/b.ts"] });
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.step, "add");
    assert.equal(await nodeFsAdapter.exists(lockPath), true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("linked worktree: pasenęs lock <main>/.git/worktrees/<name>/index.lock pašalinamas, commit'as kopijoje pavyksta", async () => {
  const dir = await initRepo("vq-gitauto-wt-");
  try {
    const wt = path.join(dir, ".ag", "copy");
    assert.equal((await run("git", ["-C", dir, "worktree", "add", "-b", "ag/test/196", wt, "HEAD"])).code, 0);

    const gitDirResult = await run("git", ["-C", wt, "rev-parse", "--absolute-git-dir"]);
    assert.equal(gitDirResult.code, 0);
    const worktreeGitDir = gitDirResult.stdout.trim();
    assert.notEqual(worktreeGitDir, path.join(dir, ".git"));

    await nodeFsAdapter.writeTextFile(path.join(wt, "src", "wt.ts"), "kopijos darbas\n");
    await writeLock(path.join(worktreeGitDir, "index.lock"), true);

    const result = await commitAndPush(wt, "kopijos commit", undefined, { push: false, paths: ["src/wt.ts"] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await nodeFsAdapter.exists(path.join(worktreeGitDir, "index.lock")), false);
    // Pagrindinio repo .git/index.lock niekada nebuvo — reprodukcijos esmė: seno kelio
    // rezoliucija čia visada grąžintų false, o teisinga rev-parse forma randa tikrą lock'ą.
    assert.equal(await nodeFsAdapter.exists(path.join(dir, ".git", "index.lock")), false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("clearStaleIndexLock: ne-git katalogas grąžina false, jokio rmSync", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vq-gitauto-nogit-"));
  try {
    assert.equal(await clearStaleIndexLock(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
