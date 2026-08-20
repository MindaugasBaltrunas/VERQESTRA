// Git adapterių integraciniai testai (E4 VQ-402 1/2) — REALUS git laikinoje
// repozitorijoje (be remote: push keliai netestuojami, jų argv kontraktą dengia
// git-rules/unit lygis; upstream nebuvimas — atskiras rollback atvejis).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { commitAndPush } from "../infrastructure/git/git-automation.js";
import {
  currentCommitResolver,
  gitCurrentBranch,
  gitHead,
  gitLogNumstat,
  gitStatusPorcelain,
  isGitRepository,
  parseWorktreePorcelain,
} from "../infrastructure/git/git-client.js";
import { committedTaskWorkSince, detectPushedRollback, restoreTaskScope } from "../infrastructure/git/rollback-scope.js";
import { checkpointStableRef, loadStableRef, saveStableRef, stableRefPath } from "../infrastructure/git/stable-ref.js";

const root = await mkdtemp(path.join(tmpdir(), "vq-git-"));
const runtimeRoot = path.join(root, "vq");
after(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function git(...args: string[]): Promise<void> {
  const result = await run("git", ["-C", root, ...args]);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

await git("init");
await git("config", "user.email", "test@example.com");
await git("config", "user.name", "Test");
await git("config", "commit.gpgsign", "false");
// Windows: globalus core.autocrlf=true checkout'e LF paverstų CRLF ir restore turinys
// nebesutaptų baitas į baitą — testo repo laiko failus tiksliai tokius, kokie įrašyti.
await git("config", "core.autocrlf", "false");

await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), "pradinis\n");

test("commitAndPush(push:false): scoped staging + commit; head ir šaka išsprendžiami", async () => {
  const result = await commitAndPush(root, "pradinis commit", undefined, { push: false, paths: ["src/a.ts"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.ok(result.branch.length > 0);

  assert.equal(await isGitRepository(root), true);
  const head = await gitHead(root);
  assert.ok(head && /^[0-9a-f]{40}$/.test(head));
  assert.equal(await currentCommitResolver(root), head);
  assert.equal(await gitCurrentBranch(root), result.branch);
  assert.equal(await gitStatusPorcelain(root), "");
});

test("stable-ref: checkpoint įrašo HEAD į vq/state/stable-ref, load jį grąžina", async () => {
  const checkpoint = await checkpointStableRef(root, stableRefPath(runtimeRoot));
  assert.equal(checkpoint.status, "ok");
  const loaded = await loadStableRef(stableRefPath(runtimeRoot));
  assert.equal(loaded.status, "ok");
  if (loaded.status === "ok" && checkpoint.status === "ok") {
    assert.equal(loaded.ref, checkpoint.ref);
  }
  assert.equal((await saveStableRef(stableRefPath(runtimeRoot), "ne-sha")).status, "invalid");
  assert.equal((await loadStableRef(path.join(runtimeRoot, "state", "nėra"))).status, "missing");
});

test("rollback scope: committedTaskWorkSince mato commit'intą darbą, restoreTaskScope tvarko tik necommit'intą", async () => {
  const stable = await gitHead(root);
  assert.ok(stable);

  // Commit'intas darbas ant a.ts — jo content-revert'as draudžiamas.
  await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), "užcommitintas pakeitimas\n");
  const committed = await commitAndPush(root, "antras commit", undefined, { push: false, paths: ["src/a.ts"] });
  assert.equal(committed.ok, true);
  assert.deepEqual(await committedTaskWorkSince(root, stable!, ["src/a.ts", "src/naujas.ts"]), ["src/a.ts"]);

  // Necommit'intas darbas: tracked failo edit + task'o sukurtas naujas failas.
  const head = await gitHead(root);
  await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), "necommitintas edit\n");
  await nodeFsAdapter.writeTextFile(path.join(root, "src", "naujas.ts"), "task'o sukurtas\n");
  const restore = await restoreTaskScope(root, head!, ["src/a.ts", "src/naujas.ts"]);
  assert.deepEqual(restore, { ok: true, restored: ["src/a.ts", "src/naujas.ts"] });
  assert.equal(await nodeFsAdapter.readTextFile(path.join(root, "src", "a.ts")), "užcommitintas pakeitimas\n");
  assert.equal(await nodeFsAdapter.exists(path.join(root, "src", "naujas.ts")), false);

  // Be upstream'o push'intos istorijos būti negali — rollback neblokuojamas.
  assert.deepEqual(await detectPushedRollback(root, stable!), { blocked: false });
});

test("gitLogNumstat: file-activity parserio laukiama forma (@@hash|iso|subject + name-status)", async () => {
  const log = await gitLogNumstat(root, 365);
  assert.ok(log !== undefined);
  assert.match(log!, /^@@[0-9a-f]{40}\|\d{4}-\d{2}-\d{2}T/m);
  assert.match(log!, /^A\tsrc\/a\.ts$/m);
});

test("parseWorktreePorcelain: porcelain įrašai skaitomi laukas į lauką", () => {
  const entries = parseWorktreePorcelain(
    ["worktree /repo", "HEAD abc", "branch refs/heads/main", "", "worktree /repo/.wt/x", "HEAD def", "detached", "locked užimtas", ""].join("\n"),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.branch, "refs/heads/main");
  assert.equal(entries[1]?.detached, true);
  assert.equal(entries[1]?.locked, true);
  assert.equal(entries[1]?.lock_reason, "užimtas");
});
