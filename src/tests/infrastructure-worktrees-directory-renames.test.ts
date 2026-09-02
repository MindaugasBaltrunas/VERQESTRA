// Worker'io šakos integracija prieš git katalogų pervadinimo aptikimą (2026-09-01 merge-conflict
// klasė: 015-a-02, 103, 113, 125, 101, 105-a-02, 146 — septynios UŽBAIGTOS šakos parkintos
// human-review be jokios realios sankirtos). Mechanizmas: pirminis medis nuo šakos bazės ištuština
// `AG/tasks/delegated/` į `done/` (tai daro pati integracija — `relocateTask`), o šaka į
// `delegated/` atneša SAVO task failą; su git numatytuoju `merge.directoryRenames=conflict` git
// „perkelia" jį į `done/` ir skelbia CONFLICT (file location) ties `done/<task>.md`. Bucket'ai yra
// būsenos katalogai, ne pervadinami katalogai, tad integracija aptikimą išjungia. REALUS git.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run, type CommandResult } from "../infrastructure/process/run-process.js";
import {
  DIRECTORY_RENAMES_CONFIG,
  integrateWorktreeBranch,
} from "../infrastructure/git/worktrees/worktree-branch-integration.js";

const BRANCH = "ag/test/dir-rename";
const TASK = "146-task";
const TASK_FILE = `${TASK}.md`;

async function git(dir: string, ...args: string[]): Promise<CommandResult> {
  return await run("git", ["-C", dir, ...args]);
}

async function gitOk(dir: string, ...args: string[]): Promise<void> {
  const result = await git(dir, ...args);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

function bucketPath(root: string, bucket: string, name: string): string {
  return path.join(root, "AG", "tasks", bucket, name);
}

/**
 * Bazė: du svetimi task'ai `delegated/` (jų slot'ai dar integruojami), mūsų task'as `queue/`.
 * Šaka: mūsų task'as `queue -> delegated` su ataskaita + produkto failas — tiksliai tai, ką
 * worktree vaikas palieka savo šakoje. Pirminis medis tuo metu: svetimų slot'ų integracija
 * perkėlė VISUS `delegated/` failus į `done/` — katalogas ištuštėjo.
 */
async function initDivergedRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vq-wtdirren-"));
  await gitOk(dir, "init");
  await gitOk(dir, "config", "user.email", "test@example.com");
  await gitOk(dir, "config", "user.name", "Test");
  await gitOk(dir, "config", "commit.gpgsign", "false");
  await gitOk(dir, "config", "core.autocrlf", "false");
  await nodeFsAdapter.writeTextFile(path.join(dir, ".gitignore"), ".ag/\n");
  await nodeFsAdapter.writeTextFile(bucketPath(dir, "delegated", "104-kitas.md"), "# Task 104\n\n## Tikslas\nkitas slot'as\n");
  await nodeFsAdapter.writeTextFile(bucketPath(dir, "delegated", "133-kitas.md"), "# Task 133\n\n## Tikslas\nkitas slot'as\n");
  await nodeFsAdapter.writeTextFile(bucketPath(dir, "queue", TASK_FILE), "# Task\n\n## Tikslas\nmūsų task'as\n");
  await nodeFsAdapter.writeTextFile(path.join(dir, "src", "a.ts"), "pradinis\n");
  await gitOk(dir, "add", "--all");
  await gitOk(dir, "commit", "-m", "pradinis");

  const wt = path.join(dir, ".ag", "w1");
  await gitOk(dir, "worktree", "add", "-b", BRANCH, wt, "HEAD");
  await gitOk(wt, "mv", `AG/tasks/queue/${TASK_FILE}`, `AG/tasks/delegated/${TASK_FILE}`);
  await nodeFsAdapter.writeTextFile(bucketPath(wt, "delegated", TASK_FILE), "# Task\n\n## Tikslas\nmūsų task'as\n\n## Ataskaita\npadaryta\n");
  await nodeFsAdapter.writeTextFile(path.join(wt, "src", "darbas.ts"), "darbas\n");
  await gitOk(wt, "add", "--all");
  await gitOk(wt, "commit", "-m", "146 darbas");

  // `git mv` reikalauja egzistuojančio paskirties katalogo — bazėje `done/` dar tuščias.
  await nodeFsAdapter.makeDirectory(path.join(dir, "AG", "tasks", "done"));
  await gitOk(dir, "mv", "AG/tasks/delegated/104-kitas.md", "AG/tasks/done/104-kitas.md");
  await gitOk(dir, "mv", "AG/tasks/delegated/133-kitas.md", "AG/tasks/done/133-kitas.md");
  await gitOk(dir, "commit", "-m", "integracija: 104, 133 -> done");
  return dir;
}

test("katalogo pervadinimo aptikimas: git numatytasis skelbia CONFLICT ties done/, integracija praeina ir palieka failą delegated/", async () => {
  const dir = await initDivergedRepo();
  try {
    // KONTROLĖ su tuo pačiu raktu, tik git numatytąja reikšme: būtent taip 2026-09-01 krito 7 šakos.
    const control = await git(dir, "-c", `${DIRECTORY_RENAMES_CONFIG}=conflict`, "merge", "--no-ff", "--no-commit", BRANCH);
    const unmerged = await git(dir, "ls-files", "--unmerged");
    await git(dir, "merge", "--abort");
    assert.notEqual(control.code, 0, `kontrolinis merge turėjo kristi: ${control.stdout}\n${control.stderr}`);
    assert.match(unmerged.stdout, /AG\/tasks\/done\/146-task\.md/, unmerged.stdout);
    assert.equal((await git(dir, "ls-files", "--unmerged")).stdout.trim(), "", "abort turėjo išvalyti indeksą");

    const integrated = await integrateWorktreeBranch({ projectRoot: dir, branch: BRANCH, taskId: TASK });
    assert.equal(integrated.status, "integrated", JSON.stringify(integrated));
    if (integrated.status === "integrated") assert.equal(integrated.mode, "merge-commit");

    // Šakos task failas lieka TEN, kur šaka jį padėjo — `relocateTask` jį ras `delegated/`.
    assert.equal(await nodeFsAdapter.exists(bucketPath(dir, "delegated", TASK_FILE)), true);
    assert.equal(await nodeFsAdapter.exists(bucketPath(dir, "done", TASK_FILE)), false);
    assert.equal(await nodeFsAdapter.exists(bucketPath(dir, "queue", TASK_FILE)), false);
    assert.match(await nodeFsAdapter.readTextFile(bucketPath(dir, "delegated", TASK_FILE)), /## Ataskaita/);
    // Produkto darbas ir pirminio medžio judesys — abu medyje.
    assert.equal(await nodeFsAdapter.exists(path.join(dir, "src", "darbas.ts")), true);
    assert.equal(await nodeFsAdapter.exists(bucketPath(dir, "done", "104-kitas.md")), true);
    assert.equal(await nodeFsAdapter.exists(bucketPath(dir, "delegated", "104-kitas.md")), false);
    assert.equal((await git(dir, "ls-files", "--unmerged")).stdout.trim(), "");
    assert.equal((await git(dir, "status", "--porcelain")).stdout.trim(), "");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
