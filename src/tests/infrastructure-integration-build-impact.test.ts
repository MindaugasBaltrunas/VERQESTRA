// 161: ar `before..after` diff'as palietė variklio (`src/`) ir/ar UI (`ui-app/src/`) source —
// REALUS git laikinoje repozitorijoje (tas pats šablonas kaip `infrastructure-git.test.ts`).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { integrationTouchedSourceSurfaces } from "../infrastructure/git/integration-build-impact.js";

const root = await mkdtemp(path.join(tmpdir(), "vq-build-impact-"));
after(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function git(...args: string[]): Promise<void> {
  const result = await run("git", ["-C", root, ...args]);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function commit(relPath: string, message: string): Promise<string> {
  await nodeFsAdapter.writeTextFile(path.join(root, relPath), `${message}\n`);
  await git("add", relPath);
  await git("commit", "-m", message);
  const head = await run("git", ["-C", root, "rev-parse", "HEAD"]);
  return head.stdout.trim();
}

await git("init");
await git("config", "user.email", "test@example.com");
await git("config", "user.name", "Test");
await git("config", "commit.gpgsign", "false");
await git("config", "core.autocrlf", "false");

const base = await commit("README.md", "pradinis");

test("`src/` pakeitimas — orchestratorSrc=true, uiSrc=false", async () => {
  const after = await commit("src/a.ts", "variklio pakeitimas");
  const touched = await integrationTouchedSourceSurfaces({ projectRoot: root, before: base, after });
  assert.deepEqual(touched, { orchestratorSrc: true, uiSrc: false });
});

test("`ui-app/src/` pakeitimas — orchestratorSrc=false, uiSrc=true", async () => {
  const before = await run("git", ["-C", root, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());
  const after = await commit("ui-app/src/App.tsx", "ui pakeitimas");
  const touched = await integrationTouchedSourceSurfaces({ projectRoot: root, before, after });
  assert.deepEqual(touched, { orchestratorSrc: false, uiSrc: true });
});

test("abu paliesti viename diff'e — abu true", async () => {
  const before = await run("git", ["-C", root, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());
  await nodeFsAdapter.writeTextFile(path.join(root, "src", "b.ts"), "b\n");
  await nodeFsAdapter.writeTextFile(path.join(root, "ui-app", "src", "b.tsx"), "b\n");
  await git("add", "src/b.ts", "ui-app/src/b.tsx");
  await git("commit", "-m", "abu");
  const after = await run("git", ["-C", root, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());
  const touched = await integrationTouchedSourceSurfaces({ projectRoot: root, before, after });
  assert.deepEqual(touched, { orchestratorSrc: true, uiSrc: true });
});

test("nė vienas paliestas — abu false", async () => {
  const before = await run("git", ["-C", root, "rev-parse", "HEAD"]).then((r) => r.stdout.trim());
  const after = await commit("docs.md", "dokumentacija");
  const touched = await integrationTouchedSourceSurfaces({ projectRoot: root, before, after });
  assert.deepEqual(touched, { orchestratorSrc: false, uiSrc: false });
});

test("trūkstamas `before` — abu true (fail-safe)", async () => {
  const touched = await integrationTouchedSourceSurfaces({ projectRoot: root, after: "HEAD" });
  assert.deepEqual(touched, { orchestratorSrc: true, uiSrc: true });
});

test("git klaida (netinkamas ref'as) — abu true (fail-safe)", async () => {
  const touched = await integrationTouchedSourceSurfaces({ projectRoot: root, before: "nera-tokio-ref", after: "HEAD" });
  assert.deepEqual(touched, { orchestratorSrc: true, uiSrc: true });
});
