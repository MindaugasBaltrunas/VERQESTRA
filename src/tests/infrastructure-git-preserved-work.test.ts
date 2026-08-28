// 063: preserved darbo (`refs/verqestra/preserved/<sha>`) izoliuoto materializavimo testai —
// REALUS git laikinoje repozitorijoje, ta pati schema kaip infrastructure-git.test.ts /
// infrastructure-worktrees.test.ts (WORKTREE_ROOT_DIR turi būti gitignore'inta, kitaip
// `worktreeRootIsIgnored` blokuoja worktree kūrimą).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { gitHead } from "../infrastructure/git/git-client.js";
import { materializePreservedWork } from "../infrastructure/git/preserved-work.js";
import { restoreTaskScope } from "../infrastructure/git/rollback-scope.js";

const root = await mkdtemp(path.join(tmpdir(), "vq-preserved-work-"));
after(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function git(...args: string[]): Promise<{ code: number; stdout: string }> {
  const result = await run("git", ["-C", root, ...args]);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

await git("init");
await git("config", "user.email", "test@example.com");
await git("config", "user.name", "Test");
await git("config", "commit.gpgsign", "false");
await git("config", "core.autocrlf", "false");
// Task-scoped worktree'ai gyvena `.ag/worktrees/...` — be gitignore `worktreeRootIsIgnored`
// blokuoja bet kokį `git worktree add`, kad pagrindinis medis neliktų nešvarus.
await nodeFsAdapter.writeTextFile(path.join(root, ".gitignore"), ".ag/\n");
await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), "pradinis\n");
await git("add", "--all");
await git("commit", "-m", "pradinis");

const stable = await gitHead(root);
assert.ok(stable);

// Necommit'intas darbas: tracked failo edit + task'o sukurtas naujas failas — tiksliai tai,
// ką rollback'as užfiksuoja per `preserveTaskScope` prieš atstatymą.
await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), "necommitintas edit\n");
await nodeFsAdapter.writeTextFile(path.join(root, "src", "naujas.ts"), "task'o sukurtas\n");
const restored = await restoreTaskScope(root, stable, ["src/a.ts", "src/naujas.ts"]);
assert.equal(restored.ok, true, JSON.stringify(restored));
if (!restored.ok) throw new Error("unreachable");
assert.ok(restored.preserved, "preserve turėjo sukurti refs/verqestra/preserved/<sha>");
const preserved = restored.preserved;

test("egzistuojantis preserved ref: worktree gauna tikslų preserve'intą turinį, baseRef ir changedPaths", async () => {
  const result = await materializePreservedWork({ projectRoot: root, ref: preserved.ref });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;

  assert.equal(result.work.baseRef, stable);
  assert.deepEqual([...result.work.changedPaths].sort(), ["src/a.ts", "src/naujas.ts"]);
  assert.equal(await nodeFsAdapter.exists(result.work.worktreePath), true);
  assert.equal(
    await nodeFsAdapter.readTextFile(path.join(result.work.worktreePath, "src", "a.ts")),
    "necommitintas edit\n",
  );
  assert.equal(
    await nodeFsAdapter.readTextFile(path.join(result.work.worktreePath, "src", "naujas.ts")),
    "task'o sukurtas\n",
  );

  await result.work.dispose();
});

test("neegzistuojantis ref grąžina ref-not-found, jokio worktree nesukuria", async () => {
  const bogusRef = "refs/verqestra/preserved/" + "d".repeat(40);
  const result = await materializePreservedWork({ projectRoot: root, ref: bogusRef });
  assert.deepEqual(result, { ok: false, reason: "ref-not-found", ref: bogusRef });
});

test("tuščias diff (preserved commit medis == tėvo medis) grąžina empty-diff", async () => {
  const treeResult = await git("rev-parse", `${stable}^{tree}`);
  const commitTreeResult = await git("commit-tree", treeResult.stdout.trim(), "-p", stable, "-m", "verqestra: empty preserve");
  const emptyCommit = commitTreeResult.stdout.trim();
  const emptyRef = `refs/verqestra/preserved/${emptyCommit}`;
  await git("update-ref", emptyRef, emptyCommit);

  const result = await materializePreservedWork({ projectRoot: root, ref: emptyRef });
  assert.deepEqual(result, { ok: false, reason: "empty-diff", ref: emptyRef, baseRef: stable });
});

test("dispose išvalo worktree'ą — kelias dingsta ir git worktree list jo nebemato", async () => {
  const result = await materializePreservedWork({
    projectRoot: root,
    ref: preserved.ref,
    worktreePath: path.join(root, ".ag", "worktrees", "preserved-dispose-test"),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;

  const worktreePath = result.work.worktreePath;
  assert.equal(await nodeFsAdapter.exists(worktreePath), true);

  await result.work.dispose();

  assert.equal(await nodeFsAdapter.exists(worktreePath), false);
  const list = await run("git", ["-C", root, "worktree", "list", "--porcelain"]);
  assert.equal(list.stdout.includes(worktreePath), false);
});
