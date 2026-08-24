import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  DirectAgentTerminalHandle,
  DirectAgentTerminalPort,
} from "../application/ports/direct-agent-terminal-port.js";
import type { GitRunnerPort } from "../application/ports/git-runner-port.js";
import type { ProcessIdentityPort } from "../application/ports/process-identity-port.js";
import type { SessionRegistryStorePort } from "../application/ports/session-registry-store-port.js";
import type {
  PersistedSessionRecord,
  SessionRegistrySnapshot,
} from "../domain/session-registry.js";
import { ProjectRegistry } from "../application/project-registry.js";
import {
  TerminalSupervisor,
  TerminalSupervisorError,
  type TerminalSessionSnapshot,
} from "../application/terminal-supervisor.js";
import type { WorktreeAllocationPort } from "../application/terminal-supervisor.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas): antra `terminal-supervisor.test.ts` pusė.
 *
 * Etalone abi gyveno viename 832 eilučių faile. Pjūvis ne mechaninis: šis failas turi SAVO
 * fikstūrą — žurnalą, kuris kiekvieną handle kvietimą užrašo KARTU su pid'u, kurį handle
 * praneša, ir `process.kill` / `process.stdin.write` diktofonus. Ta fikstūra atsako į vienintelį
 * klausimą: ar kuris nors gyvavimo ciklo kelias paliečia procesą, kurio šis šliuzas nepaleido.
 * Gyvavimo ciklo, idempotencijos ir lease testai jos nenaudoja.
 */

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const ownerDeviceId = "123e4567-e89b-42d3-a456-426614174001";
const gatewayInstanceId = "123e4567-e89b-42d3-a456-426614174002";

/**
 * Force-close and non-interference fixture.
 *
 * The mobile terminal may only ever drive the agent PTY this gateway spawned.
 * The AG Loop process is external: it is never started, stopped, signalled or
 * fed input from here, and its pid is read-only elsewhere. These fixtures make
 * that provable rather than assumed — every call the supervisor makes on its
 * handle is journalled together with the pid that handle reports, so a call
 * carrying any other process identity would show up in the journal.
 */

/** A pid that is provably not this test host's, standing in for the agent PTY. */
const agentPid = process.pid === 4567 ? 4568 : 4567;
const agentExecutable = "C:/tools/codex.cmd";

type HandleCall = Readonly<{
  method: "write" | "resize" | "interrupt" | "terminate" | "close";
  /** Identity of the process the call was delivered to, as the handle reports it. */
  pid: number;
  args: readonly unknown[];
}>;

type SupervisorHarness = Readonly<{
  supervisor: TerminalSupervisor;
  /** Every handle call the supervisor made, in order. */
  journal: readonly HandleCall[];
  /** Every pid the supervisor ever handed to the read-only process-table port. */
  identifiedPids: readonly number[];
  /** Makes the corresponding handle call fail, i.e. leave the outcome unknown. */
  failures: { terminate: boolean; close: boolean };
  createSession(requestId: string): Promise<TerminalSessionSnapshot>;
  persisted(sessionId: string): PersistedSessionRecord | undefined;
  cleanup(): Promise<void>;
}>;

function fenceFor(session: TerminalSessionSnapshot): Readonly<{
  projectId: string;
  sessionId: string;
  ownerDeviceId: string;
  leaseId: string;
  leaseGeneration: number;
}> {
  return {
    projectId: session.projectId,
    sessionId: session.sessionId,
    ownerDeviceId: session.lease.ownerDeviceId,
    leaseId: session.lease.leaseId,
    leaseGeneration: session.lease.generation,
  };
}

async function createHarness(): Promise<SupervisorHarness> {
  const directory = await mkdtemp(join(tmpdir(), "ag-terminal-force-close-"));
  const workspace = join(directory, "workspace");
  const repository = join(workspace, "repo");
  const sessionRoot = join(directory, "sessions");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(sessionRoot, { recursive: true });
  const projects = await ProjectRegistry.create({ personal: workspace });
  await projects.registerExisting({
    projectId,
    name: "Repo",
    rootId: "personal",
    relativePath: "repo",
    branch: "main",
  });
  const git: GitRunnerPort = {
    async run() {
      return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    },
  };
  const worktrees: WorktreeAllocationPort = {
    async allocate(input) {
      const worktreeRoot = join(sessionRoot, input.sessionId);
      await mkdir(worktreeRoot, { recursive: true });
      return {
        sessionId: input.sessionId,
        branch: `mobile/${input.sessionId}`,
        baseCommit: input.baseCommit,
        worktreeRoot,
      };
    },
  };
  const journal: HandleCall[] = [];
  const failures = { terminate: false, close: false };
  // The pid is read back from the handle the call was delivered to, never from
  // the constant above: the journal has to report the identity the supervisor
  // actually reached, so that reaching a second handle would be visible.
  const record = (method: HandleCall["method"], args: readonly unknown[]): void => {
    journal.push({ method, pid: handle.pid, args });
  };
  const handle: DirectAgentTerminalHandle = {
    pid: agentPid,
    executable: agentExecutable,
    async write(text) {
      record("write", [text]);
    },
    async resize(cols, rows) {
      record("resize", [cols, rows]);
    },
    async interrupt() {
      record("interrupt", []);
    },
    async terminate() {
      record("terminate", []);
      if (failures.terminate) throw new Error("ambiguous terminate");
    },
    async close() {
      record("close", []);
      if (failures.close) throw new Error("ambiguous close");
    },
  };
  const terminals: DirectAgentTerminalPort = {
    async start() {
      return handle;
    },
  };
  const identifiedPids: number[] = [];
  const processes: ProcessIdentityPort = {
    async identify(pid) {
      identifiedPids.push(pid);
      return { pid, startedAt: "2026-07-26T09:59:00.000Z", executable: agentExecutable };
    },
  };
  let stored: SessionRegistrySnapshot = {
    version: 1,
    revision: 0,
    gatewayInstanceId,
    sessions: {},
    worktrees: {},
  };
  const registry: SessionRegistryStorePort = {
    async read() {
      return stored;
    },
    async update(mutate) {
      const next = mutate(stored);
      stored = next.snapshot;
      return next.result;
    },
  };
  const now = new Date("2026-07-26T10:00:00.000Z");
  const supervisor = new TerminalSupervisor({
    projects,
    git,
    worktrees,
    terminals,
    clock: () => now,
    leaseTtlMs: 60_000,
    registry,
    processes,
    gatewayInstanceId,
  });
  return {
    supervisor,
    journal,
    identifiedPids,
    failures,
    createSession: (requestId) => supervisor.createSession({
      projectId,
      ownerDeviceId,
      requestId,
      provider: "codex",
      workspaceMode: "isolated-worktree",
      cols: 100,
      rows: 30,
    }),
    persisted: (sessionId) => stored.sessions[sessionId],
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("force-close terminates only the gateway-spawned PTY and frees the host", async () => {
  const harness = await createHarness();
  try {
    const session = await harness.createSession("force-close-1");
    assert.equal(session.state, "live");

    const ended = await harness.supervisor.terminate(fenceFor(session));

    assert.equal(ended.state, "ended");
    // The lease generation moves, so any device still holding the old fence is
    // fenced out of the terminal it just force-closed.
    assert.equal(ended.lease.generation, session.lease.generation + 1);
    // Force-close is exactly one `terminate()` on the handle this gateway
    // spawned — no write, no interrupt, no close, nothing else.
    assert.deepEqual(harness.journal, [{ method: "terminate", pid: agentPid, args: [] }]);
    // The only process identity that ever reached a call is the handle's own.
    assert.notEqual(agentPid, process.pid);
    assert.deepEqual([...new Set(harness.journal.map((call) => call.pid))], [agentPid]);
    assert.deepEqual(harness.identifiedPids, [agentPid]);
    const record = harness.persisted(session.sessionId);
    assert.equal(record?.state, "ended");
    assert.equal(record?.process?.pid, agentPid);

    // The revoked lease is real: the pre-force-close fence can no longer reach
    // the handle at all.
    await assert.rejects(
      harness.supervisor.writeInput({
        ...fenceFor(session),
        inputId: "123e4567-e89b-42d3-a456-426614174020",
        source: "keyboard",
        text: "after force close",
      }),
      (error: unknown) => (
        error instanceof TerminalSupervisorError && error.code === "stale_terminal_lease"
      ),
    );
    assert.equal(harness.journal.length, 1);

    // The single-session reservation is released, so the next start succeeds
    // instead of failing with `host_busy`.
    const next = await harness.createSession("force-close-2");
    assert.notEqual(next.sessionId, session.sessionId);
    assert.equal(next.state, "live");
    assert.deepEqual([...new Set(harness.identifiedPids)], [agentPid]);
  } finally {
    await harness.cleanup();
  }
});

for (const stop of ["terminate", "close"] as const) {
  test(`failed ${stop} orphans the session and still touches no other process`, async () => {
    const harness = await createHarness();
    try {
      const session = await harness.createSession(`failed-${stop}-1`);
      harness.failures[stop] = true;

      await assert.rejects(
        harness.supervisor[stop](fenceFor(session)),
        (error: unknown) => (
          error instanceof TerminalSupervisorError && error.code === "session_not_live"
        ),
      );

      // An ambiguous stop must not be reported as a clean one: the session goes
      // `orphaned` and the lease is revoked anyway, so no device keeps driving a
      // terminal whose fate is unknown.
      const after = await harness.supervisor.getSession(projectId, session.sessionId);
      assert.equal(after.state, "orphaned");
      assert.equal(after.lease.generation, session.lease.generation + 1);
      assert.equal(harness.persisted(session.sessionId)?.state, "orphaned");
      // Still a single call, still on the gateway's own PTY: the failure path adds
      // no retry, no escalation to a signal and no second victim.
      assert.deepEqual(harness.journal, [{ method: stop, pid: agentPid, args: [] }]);
      assert.deepEqual(harness.identifiedPids, [agentPid]);

      // The host stays reserved while the outcome is unknown — the safe direction.
      await assert.rejects(
        harness.createSession(`failed-${stop}-2`),
        (error: unknown) => error instanceof TerminalSupervisorError && error.code === "host_busy",
      );
    } finally {
      await harness.cleanup();
    }
  });
}

type HostProcessProbe = Readonly<{
  signals: ReadonlyArray<Readonly<{ pid: number; signal: string | number | undefined }>>;
  stdinWrites: readonly string[];
  pidBefore: number;
  pidAfter: number;
}>;

/**
 * Runs `body` with `process.kill` and this host process's stdin replaced by
 * recorders, and restores both even when `body` throws.
 *
 * The test host stands in for the AG Loop process: it is a process the gateway
 * did not spawn. If any lifecycle path signalled a foreign pid or wrote to a
 * foreign stdin, it would have to go through one of these two functions, and the
 * recorder would hold the evidence.
 *
 * Deliberately duplicated in `node-pty-direct-agent-terminal-adapter.test.ts`:
 * the PTY adapter and the supervisor are proven independently, and a shared
 * helper module is not among the files this proof may add. Keep the two copies
 * identical.
 *
 * Safe under `node --test`, which runs each file in its own process and the
 * tests within a file one at a time, so no other test observes the patched
 * globals.
 */
async function withoutTouchingTheHostProcess(body: () => Promise<void>): Promise<HostProcessProbe> {
  const signals: Array<Readonly<{ pid: number; signal: string | number | undefined }>> = [];
  const stdinWrites: string[] = [];
  const pidBefore = process.pid;
  // Resolved once: `process.stdin` is a lazy getter, and the object it creates
  // on first access is the one every later access returns — patch that object,
  // not a fresh one.
  const hostStdin = process.stdin;
  const originalKill = process.kill;
  const originalStdinWrite = hostStdin.write;
  process.kill = (pid: number, signal?: string | number): true => {
    signals.push({ pid, signal });
    return true;
  };
  hostStdin.write = (chunk: unknown): boolean => {
    stdinWrites.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    await body();
  } finally {
    process.kill = originalKill;
    hostStdin.write = originalStdinWrite;
  }
  return { signals, stdinWrites, pidBefore, pidAfter: process.pid };
}

test("the non-interference recorders observe a signal and a foreign stdin write", async () => {
  // Control for the lifecycle test below: an empty recorder proves something
  // only if a violation would fill it. Inside the probe `process.kill` and the
  // host stdin are the recorders themselves, so nothing is signalled for real.
  const probe = await withoutTouchingTheHostProcess(async () => {
    process.kill(process.pid, "SIGTERM");
    process.stdin.write("takeover");
  });
  assert.deepEqual(probe.signals, [{ pid: process.pid, signal: "SIGTERM" }]);
  assert.deepEqual(probe.stdinWrites, ["takeover"]);
  assert.equal(probe.pidAfter, probe.pidBefore);
});

for (const stop of ["terminate", "close"] as const) {
  // Both stop paths are covered: `close` is the graceful stop the phone asks for
  // and `terminate` is the force-close, and neither may reach the host process.
  test(`the whole supervisor lifecycle ending in ${stop} signals nothing and writes to no foreign stdin`, async () => {
    const harness = await createHarness();
    try {
      const probe = await withoutTouchingTheHostProcess(async () => {
        const session = await harness.createSession(`non-interference-${stop}`);
        const fence = fenceFor(session);
        await harness.supervisor.writeInput({
          ...fence,
          inputId: "123e4567-e89b-42d3-a456-426614174030",
          source: "voice",
          text: "run the tests",
        });
        await harness.supervisor.resize({ ...fence, cols: 120, rows: 40 });
        await harness.supervisor.interrupt(fence);
        await harness.supervisor[stop](fence);
      });

      assert.deepEqual(probe.signals, []);
      assert.deepEqual(probe.stdinWrites, []);
      assert.equal(probe.pidAfter, probe.pidBefore);
      // Every effect of the lifecycle landed on the gateway-owned handle, in order.
      assert.deepEqual(harness.journal, [
        { method: "write", pid: agentPid, args: ["run the tests"] },
        { method: "resize", pid: agentPid, args: [120, 40] },
        { method: "interrupt", pid: agentPid, args: [] },
        { method: stop, pid: agentPid, args: [] },
      ]);
      assert.deepEqual(harness.identifiedPids, [agentPid]);
    } finally {
      await harness.cleanup();
    }
  });
}
