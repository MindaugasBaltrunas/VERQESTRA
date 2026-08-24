// Grynų git taisyklių testai (E4 VQ-402 1/2): domain/git + session staging + worktree policy.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedFilesFromStatus,
  isOutsideProjectPath,
  isRuntimePath,
  normalizeGitPath,
  parseDirtyEntries,
  sessionScopedChangedFiles,
} from "../domain/git/changes.js";
import { pushedRollbackBlock } from "../domain/git/rollback-rules.js";
import {
  honestAutoCommitFiles,
  sessionStagePlan,
  taskBaselineWasClean,
  unplannedProductPaths,
} from "../application/task-execution/session-staging.js";
import { parseWorktreePolicy } from "../application/scheduling/worktree-policy.js";

test("normalizeGitPath: quotePath oktaliniai escape'ai dekoduojami į UTF-8, separatoriai — į /", () => {
  assert.equal(normalizeGitPath('"AG/tasks/queue/u\\305\\276duotis.md"'), "AG/tasks/queue/užduotis.md");
  assert.equal(normalizeGitPath("src\\domain\\x.ts"), "src/domain/x.ts");
});

test("parseDirtyEntries: rename eilutė duoda abu kelius, statusas išsaugomas", () => {
  const entries = parseDirtyEntries("R  senas.ts -> naujas.ts\n?? naujas2.ts\n");
  assert.deepEqual(entries, [
    { status: "R ", path: "senas.ts" },
    { status: "R ", path: "naujas.ts" },
    { status: "??", path: "naujas2.ts" },
  ]);
});

test("changedFilesFromStatus: pervadinimas duoda TIK taikinį, katalogai ir runtime atkrenta", () => {
  const files = changedFilesFromStatus(
    ["R  senas.ts -> naujas.ts", "?? naujas-katalogas/", " M src/app.ts", "?? vq/logs/hooks.log", ""].join("\n"),
  );

  // Skirtumas nuo parseDirtyEntries yra sprendimas, ne formatavimas: guard'ui rūpi tik tai, kas
  // DABAR yra medyje, tad `senas.ts` čia nepasirodo.
  assert.deepEqual(files, [
    { status: "R ", file: "naujas.ts" },
    { status: " M", file: "src/app.ts" },
  ]);
});

test("isRuntimePath: vq/* ir AG/tasks bucket'ai — runtime; produkto src — ne", () => {
  assert.equal(isRuntimePath("vq/state/current-task-id"), true);
  assert.equal(isRuntimePath("vq/logs/orchestrator.log"), true);
  assert.equal(isRuntimePath("AG/tasks/queue/001-x.md"), true);
  assert.equal(isRuntimePath("AG/openspec/changes/x/tasks.md"), true);
  assert.equal(isRuntimePath("src/application/x.ts"), false);
});

test("sessionScopedChangedFiles: išmeta runtime, už-repo kelius ir dublikatus", () => {
  assert.equal(isOutsideProjectPath("C:/Users/x/.claude/memory/a.md"), true);
  const files = sessionScopedChangedFiles([
    "src/a.ts",
    "src\\a.ts",
    "vq/state/x.json",
    "../kitur/failas.ts",
    "C:/Users/x/.claude/memory/a.md",
  ]);
  assert.deepEqual(files, ["src/a.ts"]);
});

test("pushedRollbackBlock: blokuoja tik kai dalis commit'ų nuo stable jau upstream'e", () => {
  const base = { stableRef: "aaa", branch: "main", upstreamExists: true };
  assert.equal(pushedRollbackBlock({ ...base, head: "aaa", totalCommitsSince: 0, unpushedCommitsSince: 0 }).blocked, false);
  assert.equal(pushedRollbackBlock({ ...base, head: "bbb", upstreamExists: false, totalCommitsSince: 2, unpushedCommitsSince: 2 }).blocked, false);
  const blocked = pushedRollbackBlock({ ...base, head: "bbb", totalCommitsSince: 3, unpushedCommitsSince: 1 });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.detail ?? "", /2\/3 commit\(s\)/);
  assert.equal(pushedRollbackBlock({ ...base, head: "bbb", totalCommitsSince: 2, unpushedCommitsSince: 2 }).blocked, false);
});

test("sessionStagePlan: runtime + ledger stage'inami, svetimi — ne; clean baseline gelbėja su ledgerMisses", () => {
  const status = " M vq/state/x.json\n M src/mano.ts\n M src/svetimas.ts\n";
  const strict = sessionStagePlan(status, ["src/mano.ts"]);
  assert.deepEqual(strict.paths, ["vq/state/x.json", "src/mano.ts"]);
  assert.deepEqual(strict.ledgerMisses, []);

  const rescued = sessionStagePlan(status, ["src/mano.ts"], { baselineClean: true });
  assert.deepEqual(rescued.paths, ["vq/state/x.json", "src/mano.ts", "src/svetimas.ts"]);
  assert.deepEqual(rescued.ledgerMisses, ["src/svetimas.ts"]);

  assert.deepEqual(unplannedProductPaths(status, strict.paths), ["src/svetimas.ts"]);
  assert.deepEqual(honestAutoCommitFiles(strict.paths), ["src/mano.ts"]);
  assert.deepEqual(honestAutoCommitFiles(["vq/state/x.json"]), ["vq/state/x.json"]);
});

test("taskBaselineWasClean: reikalauja task-id atitikmens, validaus baseline ir nulinių dirty įrašų", () => {
  const clean = { task_id: "t1", baseline_valid: true, non_runtime_dirty_entries: [] };
  assert.equal(taskBaselineWasClean(clean, "t1"), true);
  assert.equal(taskBaselineWasClean(clean, "t2"), false);
  assert.equal(taskBaselineWasClean({ ...clean, baseline_valid: false }, "t1"), false);
  assert.equal(
    taskBaselineWasClean({ ...clean, non_runtime_dirty_entries: [{ status: " M", path: "x" }] }, "t1"),
    false,
  );
});

// 2026-08-24: planuoklio teiginiai (`planTaskWorktree`, `planWorktreeCleanup`) pašalinti kartu su
// pačiu planuokliu — jis buvo be produkcinio kvietėjo. Jo saugos savybė NEPRARASTA: gyvasis kelias
// (`infrastructure/git/worktrees/worktree-reaper`) prieš destruktyvų `remove` tikrina DVI ribas —
// projekto ir `WORKTREE_ROOT_DIR` — o planuoklis tikrino tik pirmąją. Politikos parse'as, kuris
// TURI kvietėją (`wave-scheduler-adapters#loadWorktreePolicy`), toliau tikrinamas čia.
test("worktree policy: parse atmeta nesaugias reikšmes", () => {
  assert.throws(() => parseWorktreePolicy({}), /enabled must be boolean/);
  assert.throws(() => parseWorktreePolicy({ enabled: true, root: "../pabėgimas" }), /safe relative path/);

  const policy = parseWorktreePolicy({ enabled: true, root: ".ag-worktrees", branchPrefix: "AG Task", pathPrefix: "task" });
  assert.equal(policy.branchPrefix, "ag-task");
  assert.equal(policy.root, ".ag-worktrees");
  assert.equal(policy.pathPrefix, "task");
});
