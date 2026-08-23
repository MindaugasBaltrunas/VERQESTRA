// VQ-303 (2 dalis): worker pool / rolling refill / integracijos plano unit testai —
// planWorkerPool paralelizmo sąlygos ir atmetimų vardai, provisioning adresatai,
// resolveWorkerOutcomes fail-closed, planSlotRefill epizodo tvarka ir tapatybė,
// integracijos tylos + inkrementinis keliai, parallel overhead apskaita.
// Store pusės (scope lock, lease store) testai — scheduling-stores.
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerLease } from "../domain/scheduling/index.js";
import {
  computeTaskWriteSet,
  createWorkerLease,
  evaluateIntegrationCheckpoint,
  measureParallelOverhead,
  planSlotProvisioning,
  planSlotRefill,
  planWorkerIntegration,
  planWorkerPool,
  resolveWorkerOutcomes,
  type LiveSlot,
  type WorkerCandidate,
} from "../application/scheduling/index.js";

const NOW = new Date("2026-08-19T10:00:00.000Z");

function lease(taskId: string, workerId: string, options: { worktreePath?: string } = {}): WorkerLease {
  return createWorkerLease(
    { owner_id: `pid-1-${taskId}`, run_id: "r1", worker_id: workerId, task_id: taskId, attempt: 1 },
    { now: NOW, fencingToken: 1, ...(options.worktreePath === undefined ? {} : { worktreePath: options.worktreePath }) },
  );
}

function candidate(taskId: string, scopeDir: string, options: { lease?: WorkerLease; worktree?: string; depth?: number } = {}): WorkerCandidate {
  return {
    task_id: taskId,
    file: `AG/tasks/queue/${taskId}.md`,
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    write_set: computeTaskWriteSet({ task_id: taskId, allowed_paths: [scopeDir] }),
    ...(options.lease ? { lease: options.lease } : {}),
    ...(options.worktree ? { worktree_path: options.worktree } : {}),
  };
}

function liveSlot(taskId: string, workerId: string, workerIndex: number, scopeDir: string, options: { lease?: WorkerLease; worktree?: string } = {}): LiveSlot {
  return {
    worker_id: workerId,
    worker_index: workerIndex,
    task_id: taskId,
    file: `AG/tasks/active/${taskId}.md`,
    attempt: 1,
    write_set: computeTaskWriteSet({ task_id: taskId, allowed_paths: [scopeDir] }),
    ...(options.lease ? { lease: options.lease } : {}),
    ...(options.worktree ? { worktree_path: options.worktree } : {}),
    started_at: NOW.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Worker pool: planas, provisioning, outcomes
// ---------------------------------------------------------------------------

test("planWorkerPool: parallel only with full proofs; conflicts and missing leases stay sequential", () => {
  const primary = candidate("0001", "src/a/", { lease: lease("0001", "w1", { worktreePath: "worktrees/w1" }), worktree: "worktrees/w1" });
  const independent = candidate("0002", "src/b/", { lease: lease("0002", "w2", { worktreePath: "worktrees/w2" }), worktree: "worktrees/w2" });

  const sequential = planWorkerPool({ run_id: "r1", candidates: [primary, independent], now: NOW });
  assert.equal(sequential.mode, "sequential");
  assert.equal(sequential.rejected[0]?.reason, "sequential-requested", "parallelism must be requested explicitly");

  const parallel = planWorkerPool({ run_id: "r1", candidates: [primary, independent], requested_workers: 2, now: NOW });
  assert.equal(parallel.mode, "parallel");
  assert.equal(parallel.slots.length, 2);
  assert.equal(parallel.slots[1]?.worker_id, "w2");
  assert.match(parallel.plan_hash, /^wp1:[0-9a-f]{16}$/);
  assert.equal(parallel.max_workers, 2);

  const overlapping = candidate("0003", "src/a/inner/", { lease: lease("0003", "w2", { worktreePath: "worktrees/w2" }), worktree: "worktrees/w2" });
  const conflicted = planWorkerPool({ run_id: "r1", candidates: [primary, overlapping], requested_workers: 2, now: NOW });
  assert.equal(conflicted.mode, "sequential");
  assert.equal(conflicted.rejected[0]?.reason, "write-set-conflict");
  assert.equal(conflicted.conflicts.length > 0, true);

  const bare = candidate("0004", "src/c/");
  const missingLease = planWorkerPool({ run_id: "r1", candidates: [primary, bare], requested_workers: 2, now: NOW });
  assert.equal(missingLease.mode, "sequential");
  assert.equal(missingLease.rejected[0]?.reason, "missing-lease");

  const sharedWorktree = candidate("0005", "src/d/", { lease: lease("0005", "w2", { worktreePath: "worktrees/w1" }), worktree: "worktrees/w1" });
  const shared = planWorkerPool({ run_id: "r1", candidates: [primary, sharedWorktree], requested_workers: 2, now: NOW });
  assert.equal(shared.rejected[0]?.reason, "shared-worktree");
});

test("planWorkerPool primary-tree mode: primary without lease/worktree is design, not a defect", () => {
  const primary = candidate("0001", "src/a/");
  const second = candidate("0002", "src/b/", { lease: lease("0002", "w2", { worktreePath: "worktrees/w2" }), worktree: "worktrees/w2" });

  const strict = planWorkerPool({ run_id: "r1", candidates: [primary, second], requested_workers: 2, now: NOW });
  assert.equal(strict.mode, "sequential", "default keeps the historical strict behavior");
  assert.equal(strict.rejected[0]?.reason, "missing-lease");

  const relaxed = planWorkerPool({
    run_id: "r1",
    candidates: [primary, second],
    requested_workers: 2,
    primary_claim_supported: false,
    now: NOW,
  });
  assert.equal(relaxed.mode, "parallel", "primary-tree exception admits the fully-proven second candidate");
});

test("planSlotProvisioning targets missing-lease rejections and names the primary exception", () => {
  const primary = candidate("0001", "src/a/");
  const second = candidate("0002", "src/b/");
  const plan = planWorkerPool({ run_id: "r1", candidates: [primary, second], requested_workers: 2, now: NOW });
  assert.equal(plan.rejected[0]?.reason, "missing-lease", "strict mode rejects the primary itself first");

  const provisioning = planSlotProvisioning({ plan, primary_claim_supported: false });
  const refusedPrimary = provisioning.refused.find((entry) => entry.task_id === "0001");
  assert.equal(refusedPrimary?.reason, "primary-claim-unsupported");

  const supported = planSlotProvisioning({ plan, primary_claim_supported: true });
  assert.deepEqual(
    supported.targets.map((target) => [target.task_id, target.worker_index]),
    [["0001", 1]],
    "primary asks for its own index when claims are supported",
  );
});

test("resolveWorkerOutcomes: a missing outcome means still running (fail-closed)", () => {
  const primary = candidate("0001", "src/a/", { lease: lease("0001", "w1", { worktreePath: "worktrees/w1" }), worktree: "worktrees/w1" });
  const second = candidate("0002", "src/b/", { lease: lease("0002", "w2", { worktreePath: "worktrees/w2" }), worktree: "worktrees/w2" });
  const plan = planWorkerPool({ run_id: "r1", candidates: [primary, second], requested_workers: 2, now: NOW });

  const partial = resolveWorkerOutcomes(plan, [{ worker_id: "w1", task_id: "0001", status: "succeeded" }]);
  assert.equal(partial.integration_ready, false);
  assert.deepEqual(partial.continuing.map((slot) => slot.worker_id), ["w2"]);

  const done = resolveWorkerOutcomes(plan, [
    { worker_id: "w1", task_id: "0001", status: "succeeded" },
    { worker_id: "w2", task_id: "0002", status: "failed" },
  ]);
  assert.equal(done.integration_ready, true);
  assert.deepEqual(done.succeeded_task_ids, ["0001"]);
  assert.deepEqual(done.failed_task_ids, ["0002"]);
  assert.equal(done.release_lease_ids.length, 2);
});

// ---------------------------------------------------------------------------
// Rolling slot refill + integracijos planas
// ---------------------------------------------------------------------------

test("planSlotRefill: hold and capacity precede candidate evaluation; grant fills the freed index", () => {
  const cand = candidate("0003", "src/c/", { lease: lease("0003", "w2", { worktreePath: "worktrees/w2" }), worktree: "worktrees/w2" });
  const live = [liveSlot("0001", "w1", 1, "src/a/", { lease: lease("0001", "w1", { worktreePath: "worktrees/w1" }), worktree: "worktrees/w1" })];
  const base = { run_id: "r1", episode: 1, freed_slot: { worker_id: "w2", worker_index: 2 }, candidates: [cand], live, granted_workers: 2, now: NOW };

  const held = planSlotRefill({ ...base, hold: { kind: "stop-requested", detail: "loop stop" } });
  assert.equal(held.slot, undefined);
  assert.equal(held.rejected[0]?.reason, "stop-requested");

  const capped = planSlotRefill({ ...base, granted_workers: 1, hold: { kind: "none" } });
  assert.equal(capped.rejected[0]?.reason, "hard-cap");

  const granted = planSlotRefill({ ...base, hold: { kind: "none" } });
  assert.equal(granted.slot?.worker_id, "w2");
  assert.equal(granted.slot?.task_id, "0003");
  assert.match(granted.episode_hash, /^sr1:[0-9a-f]{16}$/);
  assert.match(granted.reason, /^granted=0003 /);
  assert.deepEqual(granted.live_task_ids, ["0001"]);

  const rerun = planSlotRefill({ ...base, hold: { kind: "none" } });
  assert.equal(rerun.episode_hash, granted.episode_hash, "same inputs → same episode identity");
});

test("planSlotRefill: primary-tree occupant blocks by default and is exempted only by the shared flag", () => {
  const cand = candidate("0003", "src/c/", { lease: lease("0003", "w2", { worktreePath: "worktrees/w2" }), worktree: "worktrees/w2" });
  const primaryTreeLive = [liveSlot("0001", "w1", 1, "src/a/")];
  const base = {
    run_id: "r1",
    episode: 2,
    freed_slot: { worker_id: "w2", worker_index: 2 },
    candidates: [cand],
    live: primaryTreeLive,
    granted_workers: 2,
    hold: { kind: "none" } as const,
    now: NOW,
  };

  const strict = planSlotRefill(base);
  assert.equal(strict.slot, undefined);
  assert.equal(strict.rejected[0]?.reason, "missing-lease");
  assert.equal(strict.rejected[0]?.task_id, "0001", "occupant-attributed rejection names the occupant");

  const relaxed = planSlotRefill({ ...base, primary_claim_supported: false });
  assert.equal(relaxed.slot?.task_id, "0003", "primary-tree occupant is design, not a defect");
});

test("worker integration: quiescent full path parks failures and unowned copies, integrates the proven slot", () => {
  const checkpoint = evaluateIntegrationCheckpoint({ live: [] });
  assert.equal(checkpoint.tree_quiescent, true);

  const okLease = lease("0002", "w2", { worktreePath: "worktrees/w2" });
  const plan = planWorkerIntegration({
    checkpoint: { ...checkpoint, release_lease_ids: [okLease.lease_id] },
    finished: [
      { worker_id: "w1", worker_index: 1, task_id: "0001", file: "a.md", attempt: 1, succeeded: true },
      { worker_id: "w2", worker_index: 2, task_id: "0002", file: "b.md", attempt: 1, succeeded: true, worktree_path: "worktrees/w2", lease: okLease },
      { worker_id: "w2", worker_index: 2, task_id: "0003", file: "c.md", attempt: 1, succeeded: false, worktree_path: "worktrees/w3" },
      { worker_id: "w2", worker_index: 2, task_id: "0004", file: "d.md", attempt: 1, succeeded: true, worktree_path: "worktrees/w4" },
    ],
  });

  assert.equal(plan.mode, "quiescent");
  assert.deepEqual(plan.integrate.map((step) => step.task_id), ["0002"]);
  assert.deepEqual(
    plan.park.map((entry) => [entry.task_id, entry.reason]),
    [
      ["0003", "task-failed"],
      ["0004", "missing-lease"],
    ],
  );
  assert.deepEqual(plan.skipped.map((entry) => [entry.task_id, entry.reason]), [["0001", "primary-tree-slot"]]);
  assert.deepEqual(plan.release_lease_ids, [okLease.lease_id]);
});

test("worker integration: incremental merge needs a proven-disjoint write set against every live slot", () => {
  const live = [liveSlot("0001", "w1", 1, "src/a/", { lease: lease("0001", "w1", { worktreePath: "worktrees/w1" }), worktree: "worktrees/w1" })];
  const checkpoint = evaluateIntegrationCheckpoint({ live });
  assert.equal(checkpoint.tree_quiescent, false);

  const finishedDisjoint = {
    worker_id: "w2",
    worker_index: 2,
    task_id: "0002",
    file: "b.md",
    attempt: 1,
    succeeded: true,
    worktree_path: "worktrees/w2",
    lease: lease("0002", "w2", { worktreePath: "worktrees/w2" }),
    write_set: computeTaskWriteSet({ task_id: "0002", allowed_paths: ["src/b/"] }),
  };
  const incremental = planWorkerIntegration({ checkpoint, finished: [finishedDisjoint], live });
  assert.equal(incremental.mode, "incremental");
  assert.deepEqual(incremental.integrate.map((step) => step.task_id), ["0002"]);
  assert.deepEqual(incremental.release_lease_ids, [], "wave leases stay a quiescence decision");

  const conflicting = { ...finishedDisjoint, task_id: "0003", write_set: computeTaskWriteSet({ task_id: "0003", allowed_paths: ["src/a/x.ts"] }) };
  const waiting = planWorkerIntegration({ checkpoint, finished: [conflicting], live });
  assert.equal(waiting.mode, "waiting");
  assert.equal(waiting.ready, false);

  const noProjection = planWorkerIntegration({ checkpoint, finished: [finishedDisjoint] });
  assert.equal(noProjection.mode, "waiting", "callers that pass no live projection keep the pre-incremental behavior");
});

test("measureParallelOverhead basics", () => {
  const metric = measureParallelOverhead({
    sequential: { wall_clock_ms: 1000, tokens: 100 },
    parallel: { wall_clock_ms: 600, tokens: 110 },
  });
  assert.equal(metric.worthwhile, true);
  assert.equal(metric.token_overhead, 10);

  const noBase = measureParallelOverhead({ sequential: { wall_clock_ms: 0, tokens: 0 }, parallel: { wall_clock_ms: 1, tokens: 1 } });
  assert.equal(noBase.worthwhile, false, "no sequential baseline means no provable improvement");
});
