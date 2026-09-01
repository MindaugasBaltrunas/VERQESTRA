// VQ-303 (2 dalis): scheduling store pusės unit testai — scope lock registro
// all-or-nothing įgijimas ir rašymo vartas, worker lease store gyvavimo ciklas
// (acquire/reuse/conflict/takeover, heartbeat, release, reaper), claim'as iš env ir
// lease aprėptis iš task Markdown. Pool/refill/integracijos testai — scheduling-pool.
import assert from "node:assert/strict";
import test from "node:test";
import type { ScopeLockOwner, WorkerLease } from "../domain/scheduling/index.js";
import {
  acquireScopeLocks,
  acquireScopeLocksInStore,
  acquireWorkerLease,
  authorizeScopedWrite,
  authorizeWorkerRuntimeMutation,
  createWorkerLease,
  heartbeatWorkerLease,
  listWorkerLeases,
  reapDeadWorkerLeases,
  releaseScopeLocksInStore,
  releaseWorkerLease,
  resolveWorkerLeaseClaim,
  resolveWorkerLeaseScope,
  scopeLockFile,
  WorkerLeaseClaimError,
  type SchedulingFileSystemPort,
} from "../application/scheduling/index.js";
import { memorySchedulingFs as memorySchedulingFsHelper } from "./helpers/memory-scheduling-fs.js";

const NOW = new Date("2026-08-19T10:00:00.000Z");
const ROOT = "D:/tmp/vq-scheduling-tests";

function memorySchedulingFs(): { files: Map<string, string>; port: SchedulingFileSystemPort } {
  return memorySchedulingFsHelper(NOW.getTime());
}

function owner(leaseId: string, taskId: string): ScopeLockOwner {
  return { lease_id: leaseId, owner_id: `pid-1-${leaseId}`, run_id: "r1", worker_id: "w1", task_id: taskId, attempt: 1, fencing_token: 1 };
}

function lease(taskId: string, workerId: string, options: { ownerId?: string; worktreePath?: string } = {}): WorkerLease {
  return createWorkerLease(
    { owner_id: options.ownerId ?? `pid-1-${taskId}`, run_id: "r1", worker_id: workerId, task_id: taskId, attempt: 1 },
    { now: NOW, fencingToken: 1, ...(options.worktreePath === undefined ? {} : { worktreePath: options.worktreePath }) },
  );
}

// ---------------------------------------------------------------------------
// Scope lock: all-or-nothing + store + rašymo vartas
// ---------------------------------------------------------------------------

test("acquireScopeLocks: all-or-nothing, re-acquire refreshes instead of duplicating", () => {
  const empty = { schema_version: 1, locks: [] };
  const first = acquireScopeLocks(empty, [{ kind: "directory", scope: "src/moduleA" }], owner("lease-a", "0001"), { now: NOW });
  assert.equal(first.status, "acquired");
  if (first.status !== "acquired") return;

  const conflicting = acquireScopeLocks(
    first.registry,
    [
      { kind: "file", scope: "src/moduleA/inner.ts" },
      { kind: "directory", scope: "docs" },
    ],
    owner("lease-b", "0002"),
    { now: NOW },
  );
  assert.equal(conflicting.status, "conflict", "one overlapping request poisons the whole set (all-or-nothing)");
  if (conflicting.status === "conflict") {
    assert.equal(conflicting.conflicts[0]?.holder.owner.lease_id, "lease-a");
  }

  const refreshed = acquireScopeLocks(first.registry, [{ kind: "directory", scope: "src/moduleA" }], owner("lease-a", "0001"), {
    now: NOW,
  });
  assert.equal(refreshed.status, "acquired");
  if (refreshed.status === "acquired") {
    assert.equal(refreshed.registry.locks.length, 1, "same lease re-acquire refreshes, never accumulates");
  }

  assert.throws(() => acquireScopeLocks(empty, [], owner("lease-a", "0001"), { now: NOW, ttlMs: 0 }));
});

test("scope lock store: acquire persists, conflict leaves registry untouched, release frees the path", async () => {
  const { files, port } = memorySchedulingFs();
  const deps = { fs: port };

  const acquired = await acquireScopeLocksInStore({
    fs: port,
    projectRoot: ROOT,
    requests: [{ kind: "directory", scope: "src/moduleA" }],
    owner: owner("lease-a", "0001"),
    now: NOW,
  });
  assert.equal(acquired.status, "acquired");
  assert.ok(files.get(scopeLockFile(ROOT).replace(/\\/g, "/"))?.includes("lease-a"), "registry written to vq/state");

  const conflict = await acquireScopeLocksInStore({
    fs: port,
    projectRoot: ROOT,
    requests: [{ kind: "file", scope: "src/moduleA/x.ts" }],
    owner: owner("lease-b", "0002"),
    now: NOW,
  });
  assert.equal(conflict.status, "conflict");
  assert.ok(!files.get(scopeLockFile(ROOT).replace(/\\/g, "/"))?.includes("lease-b"), "conflict does not mutate the registry");

  const owned = await authorizeScopedWrite({ fs: port, projectRoot: ROOT, repoRelativePath: "src/moduleA/x.ts", leaseId: "lease-a", now: NOW });
  assert.equal(owned.status, "owned");
  const foreign = await authorizeScopedWrite({ fs: port, projectRoot: ROOT, repoRelativePath: "src/moduleA/x.ts", leaseId: "lease-b", now: NOW });
  assert.equal(foreign.status, "locked-by-other");
  assert.equal(foreign.ok, false);
  const unlocked = await authorizeScopedWrite({ fs: port, projectRoot: ROOT, repoRelativePath: "docs/readme.md", leaseId: "lease-b", now: NOW });
  assert.equal(unlocked.status, "unlocked");

  const released = await releaseScopeLocksInStore(deps, ROOT, "lease-a");
  assert.equal(released, 1);
  const afterRelease = await authorizeScopedWrite({ fs: port, projectRoot: ROOT, repoRelativePath: "src/moduleA/x.ts", leaseId: "lease-b", now: NOW });
  assert.equal(afterRelease.status, "unlocked");
});

test("authorizeScopedWrite fails closed on a corrupted registry", async () => {
  const { files, port } = memorySchedulingFs();
  files.set(scopeLockFile(ROOT).replace(/\\/g, "/"), "{ not json");
  const verdict = await authorizeScopedWrite({ fs: port, projectRoot: ROOT, repoRelativePath: "src/x.ts", now: NOW });
  assert.equal(verdict.status, "locked-by-other");
  assert.match(verdict.reason, /neperskaitomas/);
});

// ---------------------------------------------------------------------------
// Worker lease store: gyvavimo ciklas
// ---------------------------------------------------------------------------

test("worker lease store: acquire, idempotent reuse, foreign conflict, takeover with monotonic fencing", async () => {
  const { port } = memorySchedulingFs();
  const deps = { fs: port };
  const identity = { owner_id: "loop-100", run_id: "r1", worker_id: "w1", task_id: "0001", attempt: 1 };

  const acquired = await acquireWorkerLease({ deps, projectRoot: ROOT, identity, now: NOW });
  assert.equal(acquired.status, "acquired");
  if (acquired.status !== "acquired") return;
  assert.equal(acquired.lease.fencing_token, 1);
  assert.equal(acquired.takeover, false);

  const reused = await acquireWorkerLease({ deps, projectRoot: ROOT, identity, now: new Date(NOW.getTime() + 1000) });
  assert.equal(reused.status, "reused", "same owner while active renews idempotently");

  const foreign = await acquireWorkerLease({
    deps,
    projectRoot: ROOT,
    identity: { ...identity, owner_id: "loop-200" },
    now: new Date(NOW.getTime() + 2000),
  });
  assert.equal(foreign.status, "conflict", "a live foreign lease is never torn down here");

  const afterExpiry = new Date(NOW.getTime() + 30 * 60 * 1000);
  const takeover = await acquireWorkerLease({
    deps,
    projectRoot: ROOT,
    identity: { ...identity, owner_id: "loop-200", task_id: "0002" },
    now: afterExpiry,
  });
  assert.equal(takeover.status, "acquired");
  if (takeover.status === "acquired") {
    assert.equal(takeover.takeover, true, "expired held lease is taken over, not reused");
    assert.equal(takeover.lease.fencing_token, 2, "fencing token grows monotonically across takeover");
    assert.equal(takeover.superseded?.lease_id, acquired.lease.lease_id);
  }
});

test("heartbeat and release enforce ownership via the claim", async () => {
  const { port } = memorySchedulingFs();
  const deps = { fs: port };
  const identity = { owner_id: "loop-100", run_id: "r1", worker_id: "w1", task_id: "0001", attempt: 1 };
  const acquired = await acquireWorkerLease({ deps, projectRoot: ROOT, identity, now: NOW });
  assert.equal(acquired.status, "acquired");
  if (acquired.status !== "acquired") return;
  const claim = { lease_id: acquired.lease.lease_id, owner_id: identity.owner_id, fencing_token: 1 };

  const stale = await heartbeatWorkerLease({ deps, projectRoot: ROOT, claim: { ...claim, fencing_token: 99 }, workerId: "w1", now: NOW });
  assert.equal(stale.status, "denied");
  if (stale.status === "denied") assert.equal(stale.authority.status, "stale-fencing-token");

  const beat = await heartbeatWorkerLease({ deps, projectRoot: ROOT, claim, workerId: "w1", now: new Date(NOW.getTime() + 1000) });
  assert.equal(beat.status, "ok");

  const released = await releaseWorkerLease({ deps, projectRoot: ROOT, claim, workerId: "w1", now: new Date(NOW.getTime() + 2000) });
  assert.equal(released.status, "ok");
  const afterRelease = await heartbeatWorkerLease({ deps, projectRoot: ROOT, claim, workerId: "w1", now: new Date(NOW.getTime() + 3000) });
  assert.equal(afterRelease.status, "denied");
  if (afterRelease.status === "denied") assert.equal(afterRelease.authority.status, "lease-released");

  const leases = await listWorkerLeases(port, ROOT);
  assert.equal(leases.length, 1, "released lease record is kept — fencing counter memory");
  assert.equal(leases[0]?.status, "released");
});

test("release: scope lock valymo klaida lieka best-effort, bet nebetyli", async () => {
  // 2026-09-01 (auditas): klaida buvo ryjama `catch(() => 0)` BE jokios eilutės — lock'ai kabo
  // iki TTL (15 min), o operatoriui tai atrodo kaip nepaaiškinamai lėtas loop'as.
  const { files, port } = memorySchedulingFs();
  const lines: string[] = [];
  const deps = {
    fs: port,
    log: async (line: string): Promise<void> => {
      lines.push(line);
    },
  };
  const identity = { owner_id: "loop-100", run_id: "r1", worker_id: "w1", task_id: "0001", attempt: 1 };
  const acquired = await acquireWorkerLease({ deps, projectRoot: ROOT, identity, now: NOW });
  assert.equal(acquired.status, "acquired");
  if (acquired.status !== "acquired") return;

  // Sugadintas registras — deterministinis būdas priversti valymą mesti (skaitytojas fail-closed).
  files.set(scopeLockFile(ROOT).replace(/\\/g, "/"), "{ not json");
  const claim = { lease_id: acquired.lease.lease_id, owner_id: identity.owner_id, fencing_token: 1 };
  const released = await releaseWorkerLease({ deps, projectRoot: ROOT, claim, workerId: "w1", now: new Date(NOW.getTime() + 1000) });

  assert.equal(released.status, "ok", "pakibęs lease būtų blogiau nei pakibęs lock'as — verdiktas nesikeičia");
  assert.equal(lines.length, 1, "tyla nėra best-effort dalis");
  assert.match(lines[0] ?? "", /^SCOPE LOCK RELEASE FAILED: lease_id=/);
  assert.match(lines[0] ?? "", /worker_id=w1/);
});

test("resolveWorkerLeaseClaim: partial env claim is an error, never 'no claim'", () => {
  assert.equal(resolveWorkerLeaseClaim({}), undefined);
  assert.throws(() => resolveWorkerLeaseClaim({ AG_WORKER_LEASE_ID: "x" }), WorkerLeaseClaimError);
  const claim = resolveWorkerLeaseClaim({
    AG_WORKER_LEASE_ID: "lease-1",
    AG_WORKER_OWNER_ID: "loop-100",
    AG_WORKER_FENCING_TOKEN: "3",
    AG_WORKER_TASK_ID: "0007",
  });
  assert.deepEqual(claim, { lease_id: "lease-1", owner_id: "loop-100", fencing_token: 3, task_id: "0007" });
});

test("lease scope from task Markdown narrows the claimless guard to the declared paths", async () => {
  const { files, port } = memorySchedulingFs();
  const deps = { fs: port };
  files.set(
    `${ROOT}/AG/tasks/queue/0001.md`,
    "# Task 0001\n\n## Failai\nLeidžiama:\n- `src/a/**`\n\n## Patikra\n- `pnpm test`\n",
  );
  const held = lease("0001", "w1", { ownerId: "loop-100" });
  await acquireWorkerLease({
    deps,
    projectRoot: ROOT,
    identity: { owner_id: "loop-100", run_id: "r1", worker_id: "w1", task_id: "0001", attempt: 1 },
    now: NOW,
  });

  const scope = await resolveWorkerLeaseScope(port, ROOT, held);
  assert.deepEqual(scope.allowedPaths, ["src/a/**"]);

  const inScope = await authorizeWorkerRuntimeMutation({
    deps,
    projectRoot: ROOT,
    env: {},
    now: NOW,
    isOwnerAlive: () => true,
    guardedPath: "src/a/inner.ts",
  });
  assert.equal(inScope.status, "foreign-lease", "guarded path inside the lease scope blocks a claimless writer");

  const outOfScope = await authorizeWorkerRuntimeMutation({
    deps,
    projectRoot: ROOT,
    env: {},
    now: NOW,
    isOwnerAlive: () => true,
    guardedPath: "src/b/other.ts",
  });
  assert.equal(outOfScope.status, "unmanaged", "path outside every lease scope stays writable");
  assert.match(outOfScope.reason, /gina kitą aprėptį/);

  const wholeTree = await authorizeWorkerRuntimeMutation({ deps, projectRoot: ROOT, env: {}, now: NOW, isOwnerAlive: () => true });
  assert.equal(wholeTree.status, "foreign-lease", "without guardedPath any live lease guards the whole tree");
});

test("reaper releases dead-owner and expired leases, never live ones", async () => {
  const { port } = memorySchedulingFs();
  const deps = { fs: port };
  await acquireWorkerLease({
    deps,
    projectRoot: ROOT,
    identity: { owner_id: "loop-100", run_id: "r1", worker_id: "w1", task_id: "0001", attempt: 1 },
    now: NOW,
  });
  await acquireWorkerLease({
    deps,
    projectRoot: ROOT,
    identity: { owner_id: "loop-200", run_id: "r1", worker_id: "w2", task_id: "0002", attempt: 1 },
    now: NOW,
  });

  const lines = await reapDeadWorkerLeases(deps, ROOT, { now: NOW, isOwnerAlive: (pid) => pid === 200 });
  assert.equal(lines.length, 1, "only the dead-owner lease is reaped");
  assert.match(lines[0] ?? "", /^LEASE REAPED: worker=w1/);
  const statuses = new Map((await listWorkerLeases(port, ROOT)).map((entry) => [entry.worker_id, entry.status]));
  assert.equal(statuses.get("w1"), "released");
  assert.equal(statuses.get("w2"), "held");
});

test("listWorkerLeases fails loudly on a corrupted lease file", async () => {
  const { files, port } = memorySchedulingFs();
  files.set(`${ROOT}/vq/state/worker-leases/w1.json`, "{}");
  await assert.rejects(() => listWorkerLeases(port, ROOT));
});
