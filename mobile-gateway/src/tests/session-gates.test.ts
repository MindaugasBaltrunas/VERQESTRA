import assert from "node:assert/strict";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { GateCommandOutcome } from "../application/ports/gate-command-runner-port.js";
import { REQUIRED_GATE_NAMES } from "../application/session-gate-policy.js";
import type { PersistedSessionRecord } from "../domain/session-registry.js";
import { NOW, SESSION_ID, SOURCE_COMMIT } from "./local-control-doubles.js";
import {
  gateContext,
  gateNameOf,
  OWNER,
  PASSED,
  rejectsWith,
  withContext,
  type GitScript,
} from "./session-gate-doubles.js";

/**
 * The quality gate layer of `design.md` §7: what the host actually EXECUTED and
 * what it recorded.
 *
 * Almost every case here asks one of two questions. Either "what did the host
 * actually execute" — the run order, the working directory, whether a refused
 * caller reached a process at all — or "what was recorded", because evidence is
 * what the integration flow later merges on the strength of.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 984 eilutės). Kas nutinka, kai
 * pasaulis pajuda VYKDYMO metu — `session-gates-drift.test.ts`; katalogo politika —
 * `session-gate-policy.test.ts`. Bendra fikstūra — `session-gate-doubles.ts`.
 */

test("a gate run executes every required gate in the required order, once", async () => {
  await withContext({ prefix: "ag-gates-happy-" }, async (context) => {
    const run = await context.service.runGates({ sessionId: SESSION_ID, actor: OWNER });

    // Host configuration order is irrelevant to the result, so the shuffled
    // catalogue must not be able to change what the operator sees first.
    assert.deepEqual(context.runner.calls.map(gateNameOf), [...REQUIRED_GATE_NAMES]);
    assert.equal(context.runner.calls.length, REQUIRED_GATE_NAMES.length);
    for (const call of context.runner.calls) {
      assert.equal(call.cwd, context.area.worktreeRoot, gateNameOf(call));
    }
    // Git is read in the same canonical directory the gates ran in; a mismatch
    // would mean the evidence describes some other tree entirely.
    for (const cwd of context.git.cwds) {
      assert.equal(cwd, context.area.worktreeRoot);
    }

    assert.equal(context.evidence.records.length, 1, "one complete record, never a partial one");
    const record = context.evidence.records[0];
    assert.ok(record, "the run must have produced a record");
    assert.equal(record.sessionId, SESSION_ID);
    assert.equal(record.commit, SOURCE_COMMIT);
    assert.equal(record.recordedAt, NOW.toISOString());
    assert.deepEqual(record.gates.map((gate) => gate.name), [...REQUIRED_GATE_NAMES]);
    assert.equal(record.gates.every((gate) => gate.passed && gate.status === "passed"), true);

    assert.equal(context.registry.updates(), 1, "one atomic write for the whole run");
    assert.equal(context.registry.state(), "review_ready");
    assert.equal(run.allPassed, true);
    assert.equal(run.commit, SOURCE_COMMIT);
    assert.deepEqual(run.gates.map((gate) => gate.name), [...REQUIRED_GATE_NAMES]);
  });
});

test("a red gate is recorded and never stops the gates after it", async () => {
  await withContext({
    prefix: "ag-gates-red-",
    answer: (request) => (
      gateNameOf(request) === "secret"
        ? { exitCode: 1, timedOut: false, startFailed: false, durationMs: 3 }
        : PASSED
    ),
  }, async (context) => {
    const run = await context.service.runGates({ sessionId: SESSION_ID, actor: OWNER });

    // An operator repairing a branch needs the whole picture, so a failure is a
    // verdict about one gate, not a reason to stop measuring the rest.
    assert.deepEqual(context.runner.calls.map(gateNameOf), [...REQUIRED_GATE_NAMES]);
    const secret = run.gates.find((gate) => gate.name === "secret");
    assert.equal(secret?.status, "failed");
    assert.equal(secret?.passed, false);
    assert.equal(run.allPassed, false);
    assert.equal(context.evidence.records.length, 1, "a red run is still recorded");
    assert.equal(context.registry.state(), "review_ready");
  });
});

test("a gate the host could not start or could not finish is not a red gate", async () => {
  const cases: ReadonlyArray<readonly [string, GateCommandOutcome | "throws", string]> = [
    ["a start failure", { timedOut: false, startFailed: true, durationMs: 1 }, "errored"],
    ["an exhausted time budget", { timedOut: true, startFailed: false, durationMs: 60_000 }, "timed_out"],
    ["a runner that threw", "throws", "errored"],
    ["an exit that was never reported", { timedOut: false, startFailed: false, durationMs: 2 }, "errored"],
  ];
  for (const [label, outcome, expected] of cases) {
    await withContext({
      prefix: "ag-gates-not-a-verdict-",
      answer: (request) => {
        if (gateNameOf(request) !== "architecture") return PASSED;
        if (outcome === "throws") throw new Error("the host runner blew up");
        return outcome;
      },
    }, async (context) => {
      // A host fault must not become an exception the operator sees instead of a
      // record: the run completes and names the gate that could not be measured.
      const run = await context.service.runGates({ sessionId: SESSION_ID, actor: OWNER });
      const architecture = run.gates.find((gate) => gate.name === "architecture");
      assert.equal(architecture?.status, expected, label);
      assert.equal(architecture?.passed, false, label);
      assert.equal(run.allPassed, false, label);
      // The remaining gates still ran, and the record is still complete.
      assert.deepEqual(context.runner.calls.map(gateNameOf), [...REQUIRED_GATE_NAMES], label);
      assert.equal(context.evidence.records.length, 1, label);
    });
  }
});

test("a caller the host never proved is the local owner reaches nothing at all", async () => {
  await withContext({ prefix: "ag-gates-forbidden-" }, async (context) => {
    await rejectsWith(
      context.service.runGates({ sessionId: SESSION_ID, actor: { isLocalOsOwner: false } }),
      "forbidden",
      "not the local owner",
    );
    // Ownership is settled before any I/O: no registry read, no Git, no process.
    assert.equal(context.registry.reads(), 0);
    assert.equal(context.registry.updates(), 0);
    assert.deepEqual(context.git.calls, []);
    assert.deepEqual(context.runner.calls, []);
    assert.deepEqual(context.evidence.records, []);
  });
});

test("a session without a journalled worktree has nothing to measure", async () => {
  await withContext({ prefix: "ag-gates-missing-", worktree: "missing" }, async (context) => {
    await rejectsWith(
      context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
      "not_found",
      "no worktree record",
    );
    assert.deepEqual(context.runner.calls, []);
  });
});

test("gates never run while the agent may still be writing to the tree", async () => {
  // A gate run reads the whole worktree, so an unfinished session is refused
  // rather than measured — and a session the registry does not know at all
  // proves nothing about the process either.
  const cases: ReadonlyArray<readonly [string, PersistedSessionRecord["state"] | null]> = [
    ["a live session", "live"],
    ["a closing session", "closing"],
    ["an orphaned session", "orphaned"],
    ["no session record at all", null],
  ];
  for (const [label, sessionState] of cases) {
    await withContext({ prefix: "ag-gates-unfinished-", sessionState }, async (context) => {
      await rejectsWith(
        context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
        "conflict",
        label,
      );
      assert.deepEqual(context.runner.calls, [], label);
      assert.deepEqual(context.evidence.records, [], label);
      assert.equal(context.registry.updates(), 0, label);
    });
  }
});

test("a worktree that is not in a runnable disposition refuses the run", async () => {
  for (const state of ["allocating", "locally_integrating", "integrated", "quarantined"] as const) {
    await withContext({ prefix: "ag-gates-disposition-", worktreeState: state }, async (context) => {
      await rejectsWith(
        context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
        "conflict",
        state,
      );
      assert.deepEqual(context.runner.calls, [], state);
      assert.deepEqual(context.evidence.records, [], state);
      assert.equal(context.registry.updates(), 0, state);
    });
  }
});

test("uncommitted work is refused before a gate runs, not tested and left behind", async () => {
  await withContext({
    prefix: "ag-gates-dirty-",
    git: { status: " M src/domain/command-intent.ts\n" },
  }, async (context) => {
    // Evidence names a commit and the integration flow merges that commit, so
    // measuring a dirty tree would prove something about work nobody can merge.
    await rejectsWith(
      context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
      "conflict",
      "dirty worktree",
    );
    assert.deepEqual(context.runner.calls, []);
    assert.deepEqual(context.evidence.records, []);
    assert.equal(context.registry.updates(), 0);
  });
});

test("a worktree on another branch, or on none, is a conflict before the gates", async () => {
  const cases: ReadonlyArray<readonly [string, Partial<GitScript>]> = [
    ["a branch the registry never recorded", { branch: "mobile/somebody-else" }],
    // A detached HEAD is a state an operator can reach and undo, so it is
    // reported as such rather than as a broken host.
    ["a detached HEAD", { branchExitCode: 1, branch: "" }],
  ];
  for (const [label, git] of cases) {
    await withContext({ prefix: "ag-gates-branch-", git }, async (context) => {
      await rejectsWith(
        context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
        "conflict",
        label,
      );
      assert.deepEqual(context.runner.calls, [], label);
      assert.deepEqual(context.evidence.records, [], label);
    });
  }
});

test("a recorded worktree outside the session root never becomes a working directory", async () => {
  await withContext({
    prefix: "ag-gates-outside-",
    worktreeRootOf: (area) => area.outsideRoot,
  }, async (context) => {
    await rejectsWith(
      context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
      "internal_error",
      "outside the session root",
    );
    assert.deepEqual(context.runner.calls, []);
    assert.deepEqual(context.evidence.records, []);
  });
});

test("a session root reached through a symlink still contains its own worktrees", async (t) => {
  // Regression: comparing a RESOLVED worktree against an UNRESOLVED root refuses
  // every session on a host whose session root passes through a symlink or a
  // junction — `/tmp` on macOS is one — and the refusal would look like a
  // corrupt registry rather than a configuration that never matched.
  const context = await gateContext({
    prefix: "ag-gates-symlink-",
    sessionRootOf: (area) => join(area.root, "sessions-link"),
  });
  try {
    try {
      await symlink(
        context.area.sessionRoot,
        join(context.area.root, "sessions-link"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      t.skip(`this platform refused to create a directory symlink: ${(error as Error).message}`);
      return;
    }
    const run = await context.service.runGates({ sessionId: SESSION_ID, actor: OWNER });
    assert.equal(run.allPassed, true);
    assert.equal(context.runner.calls.length, REQUIRED_GATE_NAMES.length);
    // The child still runs in the canonical directory, never through the link.
    for (const call of context.runner.calls) {
      assert.equal(call.cwd, context.area.worktreeRoot);
    }
  } finally {
    await context.cleanup();
  }
});

test("re-running the gates on a reviewable worktree replaces the evidence without moving it", async () => {
  await withContext({
    prefix: "ag-gates-rerun-",
    worktreeState: "review_ready",
  }, async (context) => {
    const first = await context.service.runGates({ sessionId: SESSION_ID, actor: OWNER });
    const second = await context.service.runGates({ sessionId: SESSION_ID, actor: OWNER });
    assert.equal(first.allPassed, true);
    assert.equal(second.allPassed, true);
    assert.equal(context.evidence.records.length, 2, "the second run replaces the record");
    assert.equal(context.registry.state(), "review_ready", "a reviewable worktree needs no move");
  });
});
