import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTerminalLease,
  createTerminalControlLease,
  renewTerminalControlLease,
  revokeTerminalLease,
  StaleTerminalLeaseError,
} from "../domain/terminal-control-lease.js";
import { transitionTerminalSession, type TerminalSession } from "../domain/terminal-session.js";

test("terminal lease fences owner, generation, session and expiry", () => {
  const now = new Date("2026-07-26T10:00:00.000Z");
  const lease = createTerminalControlLease({
    sessionId: "session-1",
    projectId: "project-1",
    provider: "codex",
    ownerDeviceId: "device-1",
    ttlMs: 60_000,
    now,
  });
  assert.doesNotThrow(() => assertTerminalLease(lease, {
    leaseId: lease.leaseId,
    generation: 1,
    ownerDeviceId: "device-1",
    sessionId: "session-1",
    now: new Date("2026-07-26T10:00:59.999Z"),
  }));
  assert.throws(() => assertTerminalLease(lease, {
    leaseId: lease.leaseId,
    generation: 1,
    ownerDeviceId: "device-1",
    sessionId: "session-1",
    now: new Date("2026-07-26T10:01:00.000Z"),
  }), StaleTerminalLeaseError);
  const revoked = revokeTerminalLease(lease, now);
  assert.equal(revoked.generation, 2);
  assert.throws(() => assertTerminalLease(revoked, {
    leaseId: lease.leaseId,
    generation: 1,
    ownerDeviceId: "device-1",
    sessionId: "session-1",
    now,
  }), StaleTerminalLeaseError);
});

/**
 * Renewal at the domain level.
 *
 * `terminal-supervisor.test.ts` proves what a renewal does to a running
 * session; these cases prove what the rule itself is, including the inputs no
 * caller can reach through the supervisor because the supervisor supplies the
 * TTL from its own configuration.
 */

const GRANTED_AT = new Date("2026-07-26T10:00:00.000Z");

function liveLease() {
  return createTerminalControlLease({
    sessionId: "session-1",
    projectId: "project-1",
    provider: "codex",
    ownerDeviceId: "device-1",
    ttlMs: 60_000,
    now: GRANTED_AT,
  });
}

function fenceOf(lease: ReturnType<typeof liveLease>, now: Date) {
  return {
    leaseId: lease.leaseId,
    generation: lease.generation,
    ownerDeviceId: lease.ownerDeviceId,
    sessionId: lease.sessionId,
    now,
  };
}

test("renewing a terminal lease moves the deadline and nothing else", () => {
  const lease = liveLease();
  const now = new Date(GRANTED_AT.getTime() + 45_000);
  const renewed = renewTerminalControlLease(lease, fenceOf(lease, now), 60_000);

  // The generation is a revocation counter and `revokeTerminalLease` is its only
  // writer, so an extension must leave it — and the lease id, the owner and the
  // grant instant — exactly where they were.
  assert.deepEqual(
    { ...renewed, expiresAt: lease.expiresAt },
    { ...lease },
    "only expiresAt may differ",
  );
  assert.equal(renewed.expiresAt, new Date(now.getTime() + 60_000).toISOString());
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(lease.expiresAt));
  // A renewal is a new value, never a mutation of the lease the caller held.
  assert.notEqual(renewed, lease);
});

test("a lease that cannot pass its own fence cannot be renewed", () => {
  const lease = liveLease();
  const now = new Date(GRANTED_AT.getTime() + 45_000);
  const fence = fenceOf(lease, now);
  for (const [label, wrong] of [
    ["another device", { ownerDeviceId: "device-2" }],
    ["another session", { sessionId: "session-2" }],
    ["another lease id", { leaseId: "00000000-0000-4000-8000-000000000000" }],
    ["a generation the revocation already moved past", { generation: 2 }],
    // The same `>= expiresAt` comparison every other action uses: "an expired
    // lease cannot be renewed" is not a second rule that could drift from it.
    ["an expired lease", { now: new Date(Date.parse(lease.expiresAt)) }],
  ] as ReadonlyArray<readonly [string, Partial<typeof fence>]>) {
    assert.throws(
      () => renewTerminalControlLease(lease, { ...fence, ...wrong }, 60_000),
      StaleTerminalLeaseError,
      label,
    );
  }
  assert.throws(
    () => renewTerminalControlLease(revokeTerminalLease(lease, now), fence, 60_000),
    StaleTerminalLeaseError,
    "a revoked lease",
  );
});

test("a renewal TTL that is not a positive safe integer is a host fault, not a stale lease", () => {
  const lease = liveLease();
  const now = new Date(GRANTED_AT.getTime() + 45_000);
  const fence = fenceOf(lease, now);
  for (const ttlMs of [
    0,
    -1,
    -60_000,
    1_500.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => renewTerminalControlLease(lease, fence, ttlMs),
      (error: unknown) => {
        // Deliberately a plain `Error`: the caller's fence was good and its
        // request was legitimate, so answering `stale_terminal_lease` would tell
        // a phone to re-acquire a lease that is perfectly live. This is the host
        // handing the domain a nonsense budget.
        assert.ok(error instanceof Error, String(ttlMs));
        assert.ok(!(error instanceof StaleTerminalLeaseError), String(ttlMs));
        assert.match(error.message, /ttlMs must be a positive safe integer/);
        return true;
      },
      String(ttlMs),
    );
  }
  // No lease is produced by a refused renewal, whatever the reason.
  assert.equal(lease.expiresAt, new Date(GRANTED_AT.getTime() + 60_000).toISOString());

  // The fence outranks the budget: a caller that cannot prove the lease learns
  // nothing about how the host validates a TTL it was never entitled to set.
  assert.throws(
    () => renewTerminalControlLease(lease, { ...fence, ownerDeviceId: "device-2" }, 0),
    StaleTerminalLeaseError,
    "a stale fence and a nonsense TTL together",
  );
});

test("terminal session state machine rejects unsafe transitions", () => {
  const creating: TerminalSession = {
    sessionId: "session",
    projectId: "project",
    provider: "claude-code",
    workspaceMode: "isolated-worktree",
    branch: "mobile/session",
    baseCommit: "abcdef1",
    state: "creating",
    revision: 1,
  };
  const starting = transitionTerminalSession(creating, "starting");
  const live = transitionTerminalSession(starting, "live");
  assert.equal(live.revision, 3);
  assert.throws(() => transitionTerminalSession(live, "ended"), /Invalid terminal session transition/);
  const closing = transitionTerminalSession(live, "closing");
  assert.equal(transitionTerminalSession(closing, "ended").state, "ended");
});
