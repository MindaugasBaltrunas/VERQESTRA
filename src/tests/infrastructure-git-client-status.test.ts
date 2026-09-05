// Task 201: `git status` nesėkmė (index.lock, EPERM, ne repo) neatskirta nuo tuščio statuso
// (docs/audits/full-audit-2026-09-05.md, P2 infrastructure F5). Šis testas dengia
// `gitStatusResult` ok:false formą ir `nonRuntimeDirtyPaths` fail-closed sentinel'į ne-git
// kataloge — tikras `index.lock` lenktynes su lygiagrečiu `git status` netestuojamas
// (nedeterministinis), pakanka ne-repo atvejo.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { gitStatus, gitStatusResult } from "../infrastructure/git/git-client.js";
import { nonRuntimeDirtyPaths } from "../infrastructure/git/integration-branch.js";

const nonRepoRoot = await mkdtemp(path.join(tmpdir(), "vq-git-status-nonrepo-"));
after(async () => {
  await rm(nonRepoRoot, { recursive: true, force: true }).catch(() => undefined);
});

test("gitStatusResult: ne-git kataloge grąžina ok:false su detail, ne tuščią statusą", async () => {
  const result = await gitStatusResult(nonRepoRoot);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.detail.length > 0);
});

test("gitStatus: ataskaitinė forma lieka \"\" nesėkmės atveju (senas kontraktas)", async () => {
  assert.equal(await gitStatus(nonRepoRoot), "");
});

test("nonRuntimeDirtyPaths: git status nesėkmė grąžina sentinel įrašą, ne tuščią sąrašą", async () => {
  const dirty = await nonRuntimeDirtyPaths(nonRepoRoot);
  assert.equal(dirty.length, 1);
  assert.match(dirty[0] ?? "", /^<git status failed: .+>$/);
});
