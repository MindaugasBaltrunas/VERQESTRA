// Worktree gyvavimo ciklo integraciniai testai (E4 VQ-402 2/2) — REALUS git laikinoje repozitorijoje:
// gitignore verdiktas, provision/reuse/karantinas, šakos integracija, šalinimas, orphan reap, plumbing.

import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
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
  worktreeLayout,
  worktreeRootIsIgnored,
  WORKTREE_ROOT_DIR,
  WORKTREE_TASK_SEGMENT_MAX_LENGTH,
} from "../infrastructure/git/worktrees/worktree-layout.js";
import {
  deleteWorktreeBranch,
  integrateWorktreeBranch,
} from "../infrastructure/git/worktrees/worktree-branch-integration.js";
import { readWorktreeOwner } from "../infrastructure/git/worktrees/worktree-owner.js";
import { createTaskWorktree, inspectTaskWorktree } from "../infrastructure/git/worktrees/worktree-provision.js";
import { removeTaskWorktree } from "../infrastructure/git/worktrees/worktree-removal.js";
import { findOrphanWorktrees, reapOrphanWorktree } from "../infrastructure/git/worktrees/worktree-reaper.js";
import { reapOrphanWorktrees } from "../infrastructure/git/worktrees/orphan-worktree-reaper.js";

const root = await mkdtemp(path.join(tmpdir(), "vq-wt-"));
after(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function gitIn(dir: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
  const result = await run("git", ["-C", dir, ...args]);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

/** Bendra pradinė būsena: repo su vienu commit'u ir `.ag/` gitignore eilute. */
async function seedRepo(dir: string): Promise<string> {
  await gitIn(dir, "init");
  await gitIn(dir, "config", "user.email", "test@example.com");
  await gitIn(dir, "config", "user.name", "Test");
  await gitIn(dir, "config", "commit.gpgsign", "false");
  await gitIn(dir, "config", "core.autocrlf", "false");
  await nodeFsAdapter.writeTextFile(path.join(dir, ".gitignore"), ".ag/\n");
  await nodeFsAdapter.writeTextFile(path.join(dir, "src", "a.ts"), "pradinis\n");
  await gitIn(dir, "add", "--all");
  await gitIn(dir, "commit", "-m", "pradinis");
  return dir;
}

await seedRepo(root);

/** Izoliuota repo laikinam kataloge, ta pati pradinė būsena kaip `root` — eskalacijos testams. */
async function initEphemeralRepo(prefix: string): Promise<string> {
  return seedRepo(await mkdtemp(path.join(tmpdir(), prefix)));
}

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

test("layout: per ilgas task segmentas gauna hash uodegą", () => {
  const long = worktreeLayout(root, { ...identity, task_id: "x".repeat(60) });
  const segment = path.basename(long.path).split("-").slice(1, -1).join("-");
  assert.ok(segment.length <= WORKTREE_TASK_SEGMENT_MAX_LENGTH);
  assert.match(path.basename(long.path), /-[0-9a-f]{8}-a1$/);
});

test("worktreeRootIsIgnored: dir-only eilutė atsako ir kai šaknies katalogo diske dar nėra", async () => {
  const fresh = await initEphemeralRepo("vq-wt-ignore-");
  const gitignore = path.join(fresh, ".gitignore");
  try {
    // Šviežias repo: `.ag/` sukuria tik pats provisioning'as, o jis laukia šio verdikto.
    await nodeFsAdapter.writeTextFile(gitignore, `${WORKTREE_ROOT_DIR}/\n`);
    assert.equal(await nodeFsAdapter.exists(path.join(fresh, ".ag")), false);
    assert.equal(await worktreeRootIsIgnored(fresh), true, "be katalogo, su eilute -> true");
    await nodeFsAdapter.makeDirectory(path.join(fresh, WORKTREE_ROOT_DIR));
    assert.equal(await worktreeRootIsIgnored(fresh), true, "su katalogu ir eilute -> true");
    await nodeFsAdapter.writeTextFile(gitignore, "node_modules/\n");
    assert.equal(await worktreeRootIsIgnored(fresh), false, "be eilutės -> false");
  } finally {
    await rm(fresh, { recursive: true, force: true }).catch(() => undefined);
  }
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

test("provision: negyva registracija isvaloma pries add - be kolizijos sufikso; gyva nesvari kopija vis dar karantinas", async () => {
  const id5 = { ...identity, task_id: "t5" };
  const created = await createTaskWorktree({
    projectRoot: root,
    identity: id5,
    lease: lease({ lease_id: "lease-6", fencing_token: 6, task_id: "t5" }),
    baseRef: "HEAD",
  });
  assert.equal(created.status, "created", JSON.stringify(created));
  if (created.status !== "created") return;
  const originalPath = created.layout.path;

  // Katalogas pašalinamas rankomis (ne "git worktree remove") — git registracija lieka, bet
  // katalogo nebėra: tiksliai ta situacija, kuri anksčiau versdavo kolizijos sufiksą.
  await rm(originalPath, { recursive: true, force: true });

  const inspectedDead = await inspectTaskWorktree({ projectRoot: root, identity: id5 });
  assert.equal(inspectedDead.status, "quarantine", JSON.stringify(inspectedDead));
  if (inspectedDead.status === "quarantine") assert.deepEqual(inspectedDead.reasons, ["prunable"]);

  const recreated = await createTaskWorktree({
    projectRoot: root,
    identity: id5,
    lease: lease({ lease_id: "lease-7", fencing_token: 7, task_id: "t5" }),
    baseRef: "HEAD",
  });
  assert.equal(recreated.status, "created", JSON.stringify(recreated));
  if (recreated.status !== "created") return;
  assert.equal(
    recreated.layout.path,
    originalPath,
    "negyva registracija turėjo išsivalyti prieš add — be kolizijos sufikso",
  );

  // Gyva nešvari kopija: katalogas egzistuoja, bet turi necommit'intą failą. Ji privalo likti
  // karantine, ne būti automatiškai išvalyta.
  await nodeFsAdapter.writeTextFile(path.join(recreated.layout.path, "src", "nesvarus5.ts"), "x\n");
  const dirtyAttempt = await createTaskWorktree({
    projectRoot: root,
    identity: id5,
    lease: lease({ lease_id: "lease-8", fencing_token: 8, owner_id: "owner-8", task_id: "t5" }),
    baseRef: "HEAD",
  });
  assert.equal(dirtyAttempt.status, "quarantined", JSON.stringify(dirtyAttempt));
  if (dirtyAttempt.status !== "quarantined") return;
  assert.ok(dirtyAttempt.reasons.includes("dirty-worktree"));
  assert.equal(await nodeFsAdapter.exists(dirtyAttempt.layout.path), true, "gyva nešvari kopija neturi būti ištrinta");
});

test("orphan reap eskalacija: negyva git worktree registracija su stale index.lock issivalo po reap'o, gyva islieka", async () => {
  const escRoot = await initEphemeralRepo("vq-wt-escalate-");
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "vq-wt-runtime-"));
  const agRoot = await mkdtemp(path.join(tmpdir(), "vq-wt-agroot-"));
  try {
    const escIdentity = { run_id: "r1", worker_id: "w1", task_id: "t-esc", attempt: 1 };
    const created = await createTaskWorktree({
      projectRoot: escRoot,
      identity: escIdentity,
      lease: lease({ lease_id: "lease-esc", fencing_token: 9, task_id: "t-esc" }),
      baseRef: "HEAD",
    });
    assert.equal(created.status, "created", JSON.stringify(created));
    if (created.status !== "created") return;

    // Necommit'intas failas -> "uncommitted-changes" kept priežastis, kuri YRA eskaluojama.
    await nodeFsAdapter.writeTextFile(path.join(created.layout.path, "src", "dirty.ts"), "darbas\n");

    // Negyva registracija su pasenusiu index.lock — ta pati grėsmė kaip GeoGravity 1179.
    const worktreesDir = path.join(escRoot, ".git", "worktrees");
    const deadDir = path.join(worktreesDir, "dead-registration");
    await nodeFsAdapter.makeDirectory(deadDir);
    await nodeFsAdapter.writeTextFile(path.join(deadDir, "gitdir"), path.join(escRoot, "gone", ".git"));
    const deadLockPath = path.join(deadDir, "index.lock");
    await nodeFsAdapter.writeTextFile(deadLockPath, "");
    const stale = new Date(Date.now() - 60_000);
    await utimes(deadLockPath, stale, stale);

    // Gyva registracija: jos lock privalo likti neliestas.
    const liveGitdirTarget = path.join(escRoot, "live-worktree", ".git");
    await nodeFsAdapter.makeDirectory(liveGitdirTarget);
    const liveDir = path.join(worktreesDir, "live-registration");
    await nodeFsAdapter.makeDirectory(liveDir);
    await nodeFsAdapter.writeTextFile(path.join(liveDir, "gitdir"), liveGitdirTarget);
    const liveLockPath = path.join(liveDir, "index.lock");
    await nodeFsAdapter.writeTextFile(liveLockPath, "");
    await utimes(liveLockPath, stale, stale);

    // Dirbtinai toli ateityje: amžiaus vartas (ORPHAN_ESCALATION_MIN_AGE_MS = 24h) praeina.
    const escalationNow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const lines = await reapOrphanWorktrees({ projectRoot: escRoot, runtimeRoot, agRoot, leases: [], now: escalationNow });

    assert.ok(
      lines.some((line) => line.startsWith("ORPHAN REAPED") && line.includes("branch=")),
      lines.join("\n"),
    );
    assert.equal(await nodeFsAdapter.exists(created.layout.path), false);
    assert.equal(await nodeFsAdapter.exists(deadLockPath), false, "negyvos registracijos lock privalo issivalyti");
    assert.equal(await nodeFsAdapter.exists(liveLockPath), true, "gyvos registracijos lock neturi buti liestas");
    assert.ok(!lines.some((line) => line.includes("REGISTRATION CLEANUP FAILED")), lines.join("\n"));
  } finally {
    await rm(escRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(agRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

// Integruotos šakos eskalacijos kelias (merge-base OK) yra "orphan reap eskalacija" testas
// aukščiau — jo dirty.ts niekada netampa commit'u, tad šaka jau pasiekiama iš HEAD ir ją
// eskalacija sėkmingai REAPina. Čia tikrinamas priešingas kelias: šaka SU commit'u ahead.
test("orphan reap eskalacija: saka su neintegruotu commit'u NEtrinama - parkuojama, saka islieka gyva", async () => {
  const parkRoot = await initEphemeralRepo("vq-wt-park-");
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "vq-wt-park-runtime-"));
  const agRoot = await mkdtemp(path.join(tmpdir(), "vq-wt-park-agroot-"));
  try {
    // Dirbtinai toli ateityje: amžiaus vartas (ORPHAN_ESCALATION_MIN_AGE_MS = 24h) praeina.
    const escalationNow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const unintegratedIdentity = { run_id: "r1", worker_id: "w1", task_id: "t-unint", attempt: 1 };
    const unintegrated = await createTaskWorktree({
      projectRoot: parkRoot,
      identity: unintegratedIdentity,
      lease: lease({ lease_id: "lease-unint", fencing_token: 30, task_id: "t-unint" }),
      baseRef: "HEAD",
    });
    assert.equal(unintegrated.status, "created", JSON.stringify(unintegrated));
    if (unintegrated.status !== "created") return;
    const unintegratedBranch = unintegrated.layout.branch;
    const unintWt = unintegrated.layout.path;
    await nodeFsAdapter.writeTextFile(path.join(unintWt, "src", "unint.ts"), "neintegruotas darbas\n");
    assert.equal((await run("git", ["-C", unintWt, "add", "--all"])).code, 0);
    assert.equal((await run("git", ["-C", unintWt, "commit", "-m", "neintegruotas commit"])).code, 0);

    const lines = await reapOrphanWorktrees({ projectRoot: parkRoot, runtimeRoot, agRoot, leases: [], now: escalationNow });

    const parkedLine = lines.find((line) => line.startsWith("ORPHAN INTEGRATION PARKED"));
    assert.ok(parkedLine, lines.join("\n"));
    assert.ok(parkedLine?.includes(`branch=${unintegratedBranch}`), parkedLine);
    assert.ok(!lines.some((line) => line.startsWith("ORPHAN KEPT") && line.includes(unintegratedBranch)), lines.join("\n"));

    // Šaka su neintegruotu darbu LIEKA git'e — `branch -D` niekada nebuvo pasiektas.
    const branchStillExists = await run("git", ["-C", parkRoot, "rev-parse", "--verify", `refs/heads/${unintegratedBranch}`]);
    assert.equal(branchStillExists.code, 0, "neintegruota saka neturi buti istrinta");
    assert.equal(await nodeFsAdapter.exists(unintWt), false, "worktree katalogas vis tiek turi buti pasalintas");
  } finally {
    await rm(parkRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(agRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("removeTaskWorktree: negyva registracija su stale index.lock issivalo po normalaus salinimo, gyva islieka", async () => {
  const remRoot = await initEphemeralRepo("vq-wt-remove-cleanup-");
  try {
    const remIdentity = { run_id: "r1", worker_id: "w1", task_id: "t-remove", attempt: 1 };
    const remLease = lease({ lease_id: "lease-remove", fencing_token: 20, task_id: "t-remove" });
    const created = await createTaskWorktree({
      projectRoot: remRoot,
      identity: remIdentity,
      lease: remLease,
      baseRef: "HEAD",
    });
    assert.equal(created.status, "created", JSON.stringify(created));
    if (created.status !== "created") return;

    const worktreesDir = path.join(remRoot, ".git", "worktrees");
    const deadDir = path.join(worktreesDir, "dead-registration");
    await nodeFsAdapter.makeDirectory(deadDir);
    await nodeFsAdapter.writeTextFile(path.join(deadDir, "gitdir"), path.join(remRoot, "gone", ".git"));
    const deadLockPath = path.join(deadDir, "index.lock");
    await nodeFsAdapter.writeTextFile(deadLockPath, "");
    const stale = new Date(Date.now() - 60_000);
    await utimes(deadLockPath, stale, stale);

    const liveGitdirTarget = path.join(remRoot, "live-worktree", ".git");
    await nodeFsAdapter.makeDirectory(liveGitdirTarget);
    const liveDir = path.join(worktreesDir, "live-registration");
    await nodeFsAdapter.makeDirectory(liveDir);
    await nodeFsAdapter.writeTextFile(path.join(liveDir, "gitdir"), liveGitdirTarget);
    const liveLockPath = path.join(liveDir, "index.lock");
    await nodeFsAdapter.writeTextFile(liveLockPath, "");
    await utimes(liveLockPath, stale, stale);

    const removed = await removeTaskWorktree({
      projectRoot: remRoot,
      identity: remIdentity,
      claim: { lease_id: remLease.lease_id, owner_id: remLease.owner_id, fencing_token: remLease.fencing_token },
      leases: [remLease],
    });
    assert.equal(removed.status, "removed", JSON.stringify(removed));

    assert.equal(await nodeFsAdapter.exists(deadDir), false, "negyva registracija po salinimo turi issivalyti");
    assert.equal(await nodeFsAdapter.exists(deadLockPath), false, "negyvos registracijos lock privalo issivalyti");
    assert.equal(await nodeFsAdapter.exists(liveDir), true, "gyva svetima registracija neturi buti paliesta");
    assert.equal(await nodeFsAdapter.exists(liveLockPath), true, "gyvos registracijos lock neturi buti liestas");
  } finally {
    await rm(remRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("reapOrphanWorktree: negyva registracija su stale index.lock issivalo po normalaus reap'o (ne eskalacija), gyva islieka", async () => {
  const reapRoot = await initEphemeralRepo("vq-wt-reap-cleanup-");
  try {
    const reapIdentity = { run_id: "r1", worker_id: "w1", task_id: "t-reap", attempt: 1 };
    const created = await createTaskWorktree({
      projectRoot: reapRoot,
      identity: reapIdentity,
      lease: lease({ lease_id: "lease-reap", fencing_token: 21, task_id: "t-reap" }),
      baseRef: "HEAD",
    });
    assert.equal(created.status, "created", JSON.stringify(created));
    if (created.status !== "created") return;

    const worktreesDir = path.join(reapRoot, ".git", "worktrees");
    const deadDir = path.join(worktreesDir, "dead-registration");
    await nodeFsAdapter.makeDirectory(deadDir);
    await nodeFsAdapter.writeTextFile(path.join(deadDir, "gitdir"), path.join(reapRoot, "gone", ".git"));
    const deadLockPath = path.join(deadDir, "index.lock");
    await nodeFsAdapter.writeTextFile(deadLockPath, "");
    const stale = new Date(Date.now() - 60_000);
    await utimes(deadLockPath, stale, stale);

    const liveGitdirTarget = path.join(reapRoot, "live-worktree", ".git");
    await nodeFsAdapter.makeDirectory(liveGitdirTarget);
    const liveDir = path.join(worktreesDir, "live-registration");
    await nodeFsAdapter.makeDirectory(liveDir);
    await nodeFsAdapter.writeTextFile(path.join(liveDir, "gitdir"), liveGitdirTarget);
    const liveLockPath = path.join(liveDir, "index.lock");
    await nodeFsAdapter.writeTextFile(liveLockPath, "");
    await utimes(liveLockPath, stale, stale);

    // Tuscias leases sarasas -> kopija be gyvo lease'o -> orphan; joks commit'as sakoje ->
    // virsune == baze -> reap'as praeina be eskalacijos (tryEscalate nekviecziamas).
    const orphans = await findOrphanWorktrees({ projectRoot: reapRoot, leases: [] });
    const target = orphans.find((orphan) => path.resolve(orphan.entry.path) === path.resolve(created.layout.path));
    assert.ok(target, "orphan sarase turi buti t-reap kopija");
    if (!target) return;

    const reaped = await reapOrphanWorktree({ projectRoot: reapRoot, orphan: target, leases: [] });
    assert.equal(reaped.status, "reaped", JSON.stringify(reaped));

    assert.equal(await nodeFsAdapter.exists(deadDir), false, "negyva registracija po reap'o turi issivalyti");
    assert.equal(await nodeFsAdapter.exists(deadLockPath), false, "negyvos registracijos lock privalo issivalyti");
    assert.equal(await nodeFsAdapter.exists(liveDir), true, "gyva svetima registracija neturi buti paliesta");
    assert.equal(await nodeFsAdapter.exists(liveLockPath), true, "gyvos registracijos lock neturi buti liestas");
  } finally {
    await rm(reapRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

// Task 079 (branch-blocked mirties spiralė, FS-lygio GC ir limito eilė) turi savo failą:
// src/tests/infrastructure-orphan-reaper.test.ts — šis failas jau buvo prie 500 eilučių ribos.
