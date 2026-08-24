import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IsolatedWorktreeService } from "../application/isolated-worktree-service.js";
import type { GitRunnerPort } from "../application/ports/git-runner-port.js";
import type { ProcessIdentityPort } from "../application/ports/process-identity-port.js";
import { SessionReconciliationService } from "../application/session-reconciliation-service.js";
import {
  assertCleanupAllowed,
  InvalidWorktreeTransitionError,
  transitionWorktree,
  WorktreeCleanupRefusedError,
  type WorktreeRecord,
} from "../domain/worktree-lifecycle.js";
import { AtomicJsonSessionRegistryStore } from "../infrastructure/atomic-json-session-registry-store.js";

const INSTANCE = "123e4567-e89b-42d3-a456-4266141740a0";
const SESSION = "123e4567-e89b-42d3-a456-4266141740a1";

function worktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    sessionId: SESSION,
    branch: `mobile/${SESSION}`,
    baseCommit: "abcdef1234567890",
    worktreeRoot: "/sessions/worktree",
    state: "ready",
    ...overrides,
  };
}

const noProcesses: ProcessIdentityPort = { async identify() { return undefined; } };
const failingGit: GitRunnerPort = {
  async run() {
    return { exitCode: 128, stdout: "", stderr: "fatal" };
  },
};

test("review_ready demands an ended process, captured status and recorded gates", () => {
  const dirty = worktree({ state: "dirty" });
  for (const review of [
    { processEnded: false, gitStatusCaptured: true, recordedGates: ["test"] },
    { processEnded: true, gitStatusCaptured: false, recordedGates: ["test"] },
    { processEnded: true, gitStatusCaptured: true, recordedGates: [] },
  ]) {
    assert.throws(
      () => transitionWorktree(dirty, "review_ready", { review }),
      InvalidWorktreeTransitionError,
    );
  }
  const reviewed = transitionWorktree(dirty, "review_ready", {
    review: { processEnded: true, gitStatusCaptured: true, recordedGates: ["typecheck", "test"] },
  });
  assert.equal(reviewed.state, "review_ready");
});

test("integration is local-only and a failure returns to review_ready", () => {
  const reviewed = worktree({ state: "review_ready" });
  assert.throws(
    () => transitionWorktree(reviewed, "locally_integrating"),
    InvalidWorktreeTransitionError,
  );
  const integrating = transitionWorktree(reviewed, "locally_integrating", { localOperator: true });
  assert.equal(integrating.state, "locally_integrating");
  // A failed gate or unresolved conflict goes back for another review; nothing
  // resolves a conflict automatically.
  assert.equal(transitionWorktree(integrating, "review_ready").state, "review_ready");
  assert.equal(transitionWorktree(integrating, "integrated").state, "integrated");
  assert.throws(
    () => transitionWorktree(transitionWorktree(integrating, "integrated"), "review_ready"),
    InvalidWorktreeTransitionError,
  );
});

test("cleanup refuses remote callers, unexported changes and unconfirmed requests", () => {
  assert.throws(
    () => assertCleanupAllowed({ localOperator: false, uncommittedChanges: false, confirmed: true }),
    (error: unknown) => error instanceof WorktreeCleanupRefusedError && error.reason === "remote_caller",
  );
  assert.throws(
    () => assertCleanupAllowed({ localOperator: true, uncommittedChanges: true, confirmed: true }),
    (error: unknown) => error instanceof WorktreeCleanupRefusedError && error.reason === "unexported_changes",
  );
  assert.throws(
    () => assertCleanupAllowed({ localOperator: true, uncommittedChanges: false, confirmed: false }),
    (error: unknown) => error instanceof WorktreeCleanupRefusedError && error.reason === "not_confirmed",
  );
  assert.doesNotThrow(() => assertCleanupAllowed({
    localOperator: true,
    uncommittedChanges: true,
    exportedAt: "2026-07-28T10:00:00.000Z",
    confirmed: true,
  }));
});

test("a quarantined worktree is final and cannot be revived", () => {
  const quarantined = transitionWorktree(worktree(), "quarantined", { quarantineReason: "crash" });
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.quarantineReason, "crash");
  for (const next of ["ready", "dirty", "review_ready", "quarantined"] as const) {
    assert.throws(() => transitionWorktree(quarantined, next), InvalidWorktreeTransitionError);
  }
});

test("a failed git worktree add quarantines the journalled allocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-worktree-fail-"));
  try {
    const sessionRoot = join(directory, "sessions");
    await mkdir(sessionRoot, { recursive: true });
    const store = new AtomicJsonSessionRegistryStore(join(directory, "sessions.json"), INSTANCE);
    const service = new IsolatedWorktreeService(failingGit, sessionRoot, store);

    await assert.rejects(
      () => service.allocate({
        repositoryRoot: join(directory, "repository"),
        sessionId: SESSION,
        baseCommit: "abcdef1234567890",
      }),
      /git_worktree_add_failed/,
    );

    const snapshot = await store.read();
    assert.equal(snapshot.worktrees[SESSION]?.state, "quarantined");
    assert.match(String(snapshot.worktrees[SESSION]?.quarantineReason), /git_worktree_add_failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an allocation interrupted by a restart is quarantined, never reused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-worktree-crash-"));
  try {
    const sessionRoot = join(directory, "sessions");
    await mkdir(sessionRoot, { recursive: true });
    const registryFile = join(directory, "sessions.json");
    const store = new AtomicJsonSessionRegistryStore(registryFile, INSTANCE);

    // Simulate the crash window: the allocation intent is journalled, then the
    // gateway dies before the worktree is confirmed ready.
    await store.update((snapshot) => ({
      snapshot: {
        ...snapshot,
        revision: snapshot.revision + 1,
        worktrees: {
          [SESSION]: worktree({ state: "allocating", worktreeRoot: join(sessionRoot, SESSION) }),
        },
      },
      result: undefined,
    }));

    const restarted = new AtomicJsonSessionRegistryStore(registryFile, INSTANCE);
    const report = await new SessionReconciliationService(
      restarted,
      noProcesses,
      failingGit,
      sessionRoot,
    ).reconcile();

    assert.deepEqual(report.quarantinedWorktrees, [SESSION]);
    const snapshot = await restarted.read();
    assert.equal(snapshot.worktrees[SESSION]?.state, "quarantined");
    assert.match(String(snapshot.worktrees[SESSION]?.quarantineReason), /restart/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciliation leaves settled worktrees alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-worktree-settled-"));
  try {
    const sessionRoot = join(directory, "sessions");
    const registryFile = join(directory, "sessions.json");
    const store = new AtomicJsonSessionRegistryStore(registryFile, INSTANCE);
    await store.update((snapshot) => ({
      snapshot: {
        ...snapshot,
        revision: snapshot.revision + 1,
        worktrees: { [SESSION]: worktree({ state: "review_ready" }) },
      },
      result: undefined,
    }));

    const report = await new SessionReconciliationService(
      store,
      noProcesses,
      failingGit,
      sessionRoot,
    ).reconcile();
    assert.deepEqual(report.quarantinedWorktrees, []);
    assert.equal((await store.read()).worktrees[SESSION]?.state, "review_ready");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
