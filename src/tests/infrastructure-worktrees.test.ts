// Worktree gyvavimo ciklo integraciniai testai (E4 VQ-402 2/2) — REALUS git laikinoje
// repozitorijoje: provision/reuse/karantinas, šakos integracija, šalinimas, orphan reap
// ir integration-branch plumbing kelias (pagrindinė šaka niekada nejuda).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { WorkerLease } from "../domain/scheduling/worker-lease-rules.js";
import type { IntegrationPlan } from "../application/integration/create-integration-plan.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { gitCurrentBranch, gitHead, gitResolveCommit } from "../infrastructure/git/git-client.js";
import { applyIntegrationPlan } from "../infrastructure/git/integration-branch.js";
import {
  planParallelWorktrees,
  worktreeLayout,
  WORKTREE_TASK_SEGMENT_MAX_LENGTH,
} from "../infrastructure/git/worktrees/worktree-layout.js";
import {
  deleteWorktreeBranch,
  integrateWorktreeBranch,
} from "../infrastructure/git/worktrees/worktree-branch-integration.js";
import { readWorktreeQuarantine, readWorktreeOwner } from "../infrastructure/git/worktrees/worktree-owner.js";
import { createTaskWorktree, inspectTaskWorktree } from "../infrastructure/git/worktrees/worktree-provision.js";
import { removeTaskWorktree } from "../infrastructure/git/worktrees/worktree-removal.js";
import { findOrphanWorktrees, reapOrphanWorktree } from "../infrastructure/git/worktrees/worktree-reaper.js";

const root = await mkdtemp(path.join(tmpdir(), "vq-wt-"));
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
// `.ag/` (ne `.ag/worktrees/`): dir-only šablonas su gale esančiu slash'u nesamo kelio
// check-ignore patikroje gali nesutapti — tėvinis prefiksas dengia visada.
await nodeFsAdapter.writeTextFile(path.join(root, ".gitignore"), ".ag/\n");
await nodeFsAdapter.writeTextFile(path.join(root, "src", "a.ts"), "pradinis\n");
await git("add", "--all");
await git("commit", "-m", "pradinis");

function lease(overrides: Partial<WorkerLease> = {}): WorkerLease {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  return {
    schema_version: 1,
    lease_id: "lease-1",
    status: "held",
    fencing_token: 1,
    owner_id: "owner-1",
    run_id: "r1",
    worker_id: "w1",
    task_id: "t1",
    attempt: 1,
    acquired_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    expires_at: future,
    ...overrides,
  };
}

const identity = { run_id: "r1", worker_id: "w1", task_id: "t1", attempt: 1 };

test("layout: per ilgas task segmentas gauna hash uodegą, lygiagretus planas mato kolizijas", () => {
  const long = worktreeLayout(root, { ...identity, task_id: "x".repeat(60) });
  const segment = path.basename(long.path).split("-").slice(1, -1).join("-");
  assert.ok(segment.length <= WORKTREE_TASK_SEGMENT_MAX_LENGTH);
  assert.match(path.basename(long.path), /-[0-9a-f]{8}-a1$/);

  const plan = planParallelWorktrees(root, [identity, identity]);
  assert.equal(plan.disjoint, false);
  assert.equal(plan.collisions.length, 1);
});

test("provision: created -> reused tam pačiam lease; owner žyma gyvena git admin kataloge", async () => {
  const created = await createTaskWorktree({ projectRoot: root, identity, lease: lease(), baseRef: "HEAD" });
  assert.equal(created.status, "created", JSON.stringify(created));
  if (created.status !== "created") return;
  assert.equal((await readWorktreeOwner(created.layout.path))?.lease_id, "lease-1");
  // Žyma neturi daryti darbinio medžio nešvaraus.
  const inspected = await inspectTaskWorktree({
    projectRoot: root,
    identity,
    claim: { lease_id: "lease-1", owner_id: "owner-1", fencing_token: 1 },
  });
  assert.equal(inspected.status, "reusable");

  const reused = await createTaskWorktree({ projectRoot: root, identity, lease: lease(), baseRef: "HEAD" });
  assert.equal(reused.status, "reused");
});

test("svetimas lease ant nešvarios kopijos -> karantinas su lock ir įrašu", async () => {
  const layout = worktreeLayout(root, identity);
  await nodeFsAdapter.writeTextFile(path.join(layout.path, "src", "nešvarus.ts"), "x\n");

  const foreign = await createTaskWorktree({
    projectRoot: root,
    identity,
    lease: lease({ lease_id: "lease-2", fencing_token: 2, owner_id: "owner-2" }),
    baseRef: "HEAD",
  });
  assert.equal(foreign.status, "quarantined", JSON.stringify(foreign));
  if (foreign.status !== "quarantined") return;
  assert.ok(foreign.reasons.includes("dirty-worktree"));
  assert.ok(foreign.reasons.includes("foreign-owner"));
  const record = await readWorktreeQuarantine(layout.path);
  assert.deepEqual(record?.reasons, foreign.reasons.slice().sort());
});

test("branch integracija: commit worktree'e -> integrated į pirminę šaką, idempotentiškas pakartojimas, remove + branch delete", async () => {
  const id2 = { ...identity, task_id: "t2" };
  const created = await createTaskWorktree({
    projectRoot: root,
    identity: id2,
    lease: lease({ lease_id: "lease-3", fencing_token: 3, task_id: "t2" }),
    baseRef: "HEAD",
  });
  assert.equal(created.status, "created");
  if (created.status !== "created") return;

  await nodeFsAdapter.writeTextFile(path.join(created.layout.path, "src", "t2.ts"), "darbas\n");
  const wt = created.layout.path;
  assert.equal((await run("git", ["-C", wt, "add", "--all"])).code, 0);
  assert.equal((await run("git", ["-C", wt, "commit", "-m", "t2 darbas"])).code, 0);

  const integrated = await integrateWorktreeBranch({ projectRoot: root, branch: created.layout.branch, taskId: "t2" });
  assert.equal(integrated.status, "integrated", JSON.stringify(integrated));
  assert.equal(await nodeFsAdapter.exists(path.join(root, "src", "t2.ts")), true);

  const again = await integrateWorktreeBranch({ projectRoot: root, branch: created.layout.branch });
  assert.equal(again.status, "already-integrated");

  const removed = await removeTaskWorktree({
    projectRoot: root,
    identity: id2,
    claim: { lease_id: "lease-3", owner_id: "owner-1", fencing_token: 3 },
    leases: [lease({ lease_id: "lease-3", fencing_token: 3, task_id: "t2" })],
  });
  assert.equal(removed.status, "removed", JSON.stringify(removed));

  const deleted = await deleteWorktreeBranch({ projectRoot: root, branch: created.layout.branch });
  assert.equal(deleted.status, "deleted");
});

test("orphan reap: švari, integruota kopija be gyvo lease pašalinama kartu su šaka", async () => {
  const id3 = { ...identity, task_id: "t3" };
  const created = await createTaskWorktree({
    projectRoot: root,
    identity: id3,
    lease: lease({ lease_id: "lease-4", fencing_token: 4, task_id: "t3" }),
    baseRef: "HEAD",
  });
  assert.equal(created.status, "created");
  if (created.status !== "created") return;

  // Jokių commit'ų šakoje: jos viršūnė == bazė, t. y. jau pasiekiama iš HEAD.
  const orphans = await findOrphanWorktrees({ projectRoot: root, leases: [] });
  const target = orphans.find((orphan) => path.resolve(orphan.entry.path) === path.resolve(created.layout.path));
  assert.ok(target, "orphan sąraše turi būti t3 kopija");
  assert.equal(target.reason, "lease-not-active");

  const reaped = await reapOrphanWorktree({ projectRoot: root, orphan: target, leases: [] });
  assert.equal(reaped.status, "reaped", JSON.stringify(reaped));
  assert.equal(await nodeFsAdapter.exists(created.layout.path), false);
});

test("integration-branch plumbing: planas taikomas į izoliuotą ref'ą, pirminė šaka nejuda, pakartojimas reuse'ina", async () => {
  const mainBranch = await gitCurrentBranch(root);
  const baseHead = await gitHead(root);
  assert.ok(baseHead);

  // Šaltinio commit'as gimsta izoliuotoje kopijoje, kad pirminis medis liktų švarus.
  const id4 = { ...identity, task_id: "t4" };
  const created = await createTaskWorktree({
    projectRoot: root,
    identity: id4,
    lease: lease({ lease_id: "lease-5", fencing_token: 5, task_id: "t4" }),
    baseRef: "HEAD",
  });
  assert.equal(created.status, "created");
  if (created.status !== "created") return;
  const wt = created.layout.path;
  await nodeFsAdapter.writeTextFile(path.join(wt, "src", "planas.ts"), "plano darbas\n");
  assert.equal((await run("git", ["-C", wt, "add", "--all"])).code, 0);
  assert.equal((await run("git", ["-C", wt, "commit", "-m", "plano commit"])).code, 0);
  const sourceSha = (await run("git", ["-C", wt, "rev-parse", "HEAD"])).stdout.trim();

  const plan: IntegrationPlan = {
    plan_version: 1,
    run_id: "r1",
    wave_id: "wave1",
    branch: "ag/integration/r1/wave1",
    base_head: baseHead,
    base_branch: mainBranch,
    commits: [{ task_id: "t4", sha: sourceSha, order: 1, files: ["src/planas.ts"], subject: "plano commit" }],
    allowed_paths: ["src/**"],
    risk: { verdict: "routine", signals: [] },
    violations: [],
    ok: true,
    plan_hash: "test-plan",
  };

  const applied = await applyIntegrationPlan(root, plan);
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  if (applied.status !== "applied") return;
  assert.equal(applied.applied[0]?.reused, false);
  // Pirminė šaka NEJUDA; integracijos ref'as turi naują commit'ą su plano failu.
  assert.equal(await gitHead(root), baseHead);
  const integrationHead = await gitResolveCommit(`refs/heads/${plan.branch}`, root);
  assert.equal(integrationHead, applied.head);
  const shown = await run("git", ["-C", root, "show", `${applied.head}:src/planas.ts`]);
  assert.equal(shown.stdout, "plano darbas\n");

  const rerun = await applyIntegrationPlan(root, plan);
  assert.equal(rerun.status, "applied");
  if (rerun.status === "applied") assert.equal(rerun.applied[0]?.reused, true);
});
