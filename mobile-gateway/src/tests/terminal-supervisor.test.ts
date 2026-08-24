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
import type { SessionRegistrySnapshot } from "../domain/session-registry.js";
import { ProjectRegistry } from "../application/project-registry.js";
import {
  TerminalSupervisor,
  TerminalSupervisorError,
  type WorktreeAllocationPort,
} from "../application/terminal-supervisor.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 832 eilutės).
 *
 * Čia lieka SEANSO GYVAVIMO CIKLAS: nuosavybė, idempotencija, lease fence'as ir jo pratęsimas.
 * Ne-įsikišimo įrodymas — „nė vienas kelias neliečia svetimo proceso" — persikėlė į
 * `terminal-supervisor-noninterference.test.ts`: jis turi savo fikstūrą (žurnalas su pid'ais,
 * `process.kill` diktofonas) ir atsako į kitą klausimą nei šie testai.
 */

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const ownerDeviceId = "123e4567-e89b-42d3-a456-426614174001";
const gatewayInstanceId = "123e4567-e89b-42d3-a456-426614174002";

test("supervisor owns one isolated, idempotent and lease-fenced terminal session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-terminal-supervisor-"));
  try {
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
    const gitCalls: Array<{ cwd: string; args: readonly string[] }> = [];
    const git: GitRunnerPort = {
      async run(cwd, args) {
        gitCalls.push({ cwd, args });
        return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      },
    };
    const allocations: string[] = [];
    const worktrees: WorktreeAllocationPort = {
      async allocate(input) {
        const worktreeRoot = join(sessionRoot, input.sessionId);
        await mkdir(worktreeRoot);
        allocations.push(worktreeRoot);
        return {
          sessionId: input.sessionId,
          branch: `mobile/${input.sessionId}`,
          baseCommit: input.baseCommit,
          worktreeRoot,
        };
      },
    };
    const writes: string[] = [];
    const resizes: Array<[number, number]> = [];
    let interruptCount = 0;
    let terminateCount = 0;
    let closeCount = 0;
    let failClose = false;
    let startCount = 0;
    let failNextWrite = false;
    let emitOutput: ((data: string) => void) | undefined;
    const handle: DirectAgentTerminalHandle = {
      pid: 4567,
      executable: "C:/tools/codex.cmd",
      async write(text) {
        writes.push(text);
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("ambiguous PTY write");
        }
      },
      async resize(cols, rows) {
        resizes.push([cols, rows]);
      },
      async interrupt() {
        interruptCount += 1;
      },
      async terminate() {
        terminateCount += 1;
      },
      async close() {
        closeCount += 1;
        if (failClose) throw new Error("ambiguous close");
      },
    };
    const starts: Parameters<DirectAgentTerminalPort["start"]>[0][] = [];
    const terminals: DirectAgentTerminalPort = {
      async start(input) {
        startCount += 1;
        starts.push(input);
        emitOutput = input.onOutput;
        return handle;
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
    });
    const createInput = {
      projectId,
      ownerDeviceId,
      requestId: "create-request-1",
      provider: "codex" as const,
      workspaceMode: "isolated-worktree" as const,
      cols: 100,
      rows: 30,
    };
    const session = await supervisor.createSession(createInput);
    assert.equal(session.state, "live");
    assert.equal(startCount, 1);
    assert.equal(starts[0]?.provider, "codex");
    assert.equal(starts[0]?.cwd, allocations[0]);
    assert.notEqual(starts[0]?.cwd, repository);
    assert.deepEqual(gitCalls, [{
      cwd: repository,
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
    }]);
    assert.equal((await supervisor.createSession(createInput)).sessionId, session.sessionId);
    assert.equal(startCount, 1);
    await assert.rejects(
      supervisor.createSession({ ...createInput, requestId: "create-request-2" }),
      (error: unknown) => error instanceof TerminalSupervisorError && error.code === "host_busy",
    );

    const fence = {
      projectId,
      sessionId: session.sessionId,
      ownerDeviceId,
      leaseId: session.lease.leaseId,
      leaseGeneration: session.lease.generation,
    };
    const inputId = "123e4567-e89b-42d3-a456-426614174010";
    const [firstWrite, duplicateWrite] = await Promise.all([
      supervisor.writeInput({ ...fence, inputId, source: "voice", text: "fix tests" }),
      supervisor.writeInput({ ...fence, inputId, source: "voice", text: "fix tests" }),
    ]);
    assert.equal(firstWrite.status, "written");
    assert.equal(duplicateWrite.status, "written");
    assert.deepEqual(writes, ["fix tests"]);
    await assert.rejects(
      supervisor.writeInput({ ...fence, inputId, source: "voice", text: "different" }),
      (error: unknown) => error instanceof TerminalSupervisorError && error.code === "duplicate_request",
    );
    await assert.rejects(
      supervisor.writeInput({
        ...fence,
        leaseGeneration: fence.leaseGeneration + 1,
        inputId: "123e4567-e89b-42d3-a456-426614174011",
        source: "keyboard",
        text: "blocked",
      }),
      (error: unknown) => (
        error instanceof TerminalSupervisorError &&
        error.code === "stale_terminal_lease"
      ),
    );
    failNextWrite = true;
    const unknownId = "123e4567-e89b-42d3-a456-426614174012";
    assert.equal((await supervisor.writeInput({
      ...fence,
      inputId: unknownId,
      source: "keyboard",
      text: "ambiguous",
    })).status, "unknown");
    assert.equal((await supervisor.writeInput({
      ...fence,
      inputId: unknownId,
      source: "keyboard",
      text: "ambiguous",
    })).status, "unknown");
    assert.deepEqual(writes, ["fix tests", "ambiguous"]);

    await supervisor.resize({ ...fence, cols: 120, rows: 40 });
    await supervisor.interrupt(fence);
    assert.deepEqual(resizes, [[120, 40]]);
    assert.equal(interruptCount, 1);
    assert.equal(terminateCount, 0);
    emitOutput?.("\u001b]52;c;ZXZpbA==\u0007TOKEN=terminal-secret");
    const ended = await supervisor.close(fence);
    assert.equal(ended.state, "ended");
    assert.equal(ended.lease.generation, 2);
    assert.equal(closeCount, 1);
    const replay = await supervisor.replayAfter(projectId, session.sessionId, 0);
    // The replay log now carries lifecycle events alongside output, so select
    // the output frames rather than asserting on the whole sequence.
    assert.deepEqual(
      replay.events.flatMap((event) => event.type === "server.output" ? [event.data] : []),
      ["TOKEN=[REDACTED]"],
    );

    const next = await supervisor.createSession({ ...createInput, requestId: "create-request-3" });
    assert.notEqual(next.sessionId, session.sessionId);
    assert.equal(startCount, 2);
    failClose = true;
    const nextFence = {
      projectId,
      sessionId: next.sessionId,
      ownerDeviceId,
      leaseId: next.lease.leaseId,
      leaseGeneration: next.lease.generation,
    };
    await assert.rejects(
      supervisor.close(nextFence),
      (error: unknown) => error instanceof TerminalSupervisorError && error.code === "session_not_live",
    );
    assert.equal((await supervisor.getSession(projectId, next.sessionId)).state, "orphaned");
    await assert.rejects(
      supervisor.createSession({ ...createInput, requestId: "create-request-4" }),
      (error: unknown) => error instanceof TerminalSupervisorError && error.code === "host_busy",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lease can be extended before it expires, and never after", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-terminal-lease-renewal-"));
  try {
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
    const terminals: DirectAgentTerminalPort = {
      async start() {
        return {
          pid: 5678,
          executable: "C:/tools/codex.cmd",
          async write() {},
          async resize() {},
          async interrupt() {},
          async terminate() {},
          async close() {},
        };
      },
    };
    // The fixture above pins a `const now`; renewal is only observable when the
    // clock can move, so this block keeps its own mutable one.
    let now = new Date("2026-07-26T10:00:00.000Z");
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
    const processes: ProcessIdentityPort = {
      async identify(pid) {
        return { pid, startedAt: "2026-07-26T09:59:00.000Z", executable: "C:/tools/codex.cmd" };
      },
    };
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
    const session = await supervisor.createSession({
      projectId,
      ownerDeviceId,
      requestId: "lease-renewal-1",
      provider: "codex",
      workspaceMode: "isolated-worktree",
      cols: 100,
      rows: 30,
    });
    const fence = {
      projectId,
      sessionId: session.sessionId,
      ownerDeviceId,
      leaseId: session.lease.leaseId,
      leaseGeneration: session.lease.generation,
    };
    const eventsBefore = (await supervisor.replayAfter(projectId, session.sessionId, 0))
      .events.length;

    now = new Date(now.getTime() + 45_000);
    const renewed = await supervisor.renewLease(fence);

    // Identity is untouched: the generation is a revocation counter, and the
    // lease id only ties a request to one lease. Only the deadline moves.
    assert.equal(renewed.lease.leaseId, session.lease.leaseId);
    assert.equal(renewed.lease.generation, session.lease.generation);
    assert.equal(renewed.lease.ownerDeviceId, ownerDeviceId);
    assert.equal(renewed.lease.expiresAt, new Date(now.getTime() + 60_000).toISOString());
    assert.ok(Date.parse(renewed.lease.expiresAt) > Date.parse(session.lease.expiresAt));

    // The new deadline reaches the phone over the stream it already reads, and
    // the durable record so a restart does not reconcile an expired lease.
    const replay = await supervisor.replayAfter(projectId, session.sessionId, 0);
    const leaseDeadlines = replay.events.flatMap(
      (event) => event.type === "server.lease" ? [event.expiresAt] : [],
    );
    assert.ok(replay.events.length > eventsBefore);
    assert.equal(leaseDeadlines[leaseDeadlines.length - 1], renewed.lease.expiresAt);
    assert.equal(stored.sessions[session.sessionId]?.lease.expiresAt, renewed.lease.expiresAt);
    assert.equal(stored.sessions[session.sessionId]?.lease.status, "active");

    // The point of a renewal: at 50s past the original grant the untouched lease
    // would still be live, but at 70s only the extended one is.
    now = new Date(Date.parse(session.lease.expiresAt) + 10_000);
    await supervisor.resize({ ...fence, cols: 120, rows: 40 });

    for (const [label, wrong] of [
      ["another device", { ownerDeviceId: "123e4567-e89b-42d3-a456-426614174099" }],
      ["a stale generation", { leaseGeneration: fence.leaseGeneration + 1 }],
      ["another lease id", { leaseId: "123e4567-e89b-42d3-a456-426614174098" }],
    ] as ReadonlyArray<readonly [string, Partial<typeof fence>]>) {
      await assert.rejects(
        supervisor.renewLease({ ...fence, ...wrong }),
        (error: unknown) => (
          error instanceof TerminalSupervisorError && error.code === "stale_terminal_lease"
        ),
        label,
      );
    }

    // A session the supervisor never had: the runtime lookup fails before any
    // fence is compared, so the answer is about the session, not the lease.
    await assert.rejects(
      supervisor.renewLease({ ...fence, sessionId: "123e4567-e89b-42d3-a456-426614174097" }),
      (error: unknown) => (
        error instanceof TerminalSupervisorError && error.code === "session_not_live"
      ),
      "a session the supervisor never had",
    );

    // An expired lease is not renewable: the same `>= expiresAt` comparison that
    // refuses every other action refuses this one, so the two cannot drift.
    const afterExpiry = new Date(Date.parse(renewed.lease.expiresAt) + 1);
    now = afterExpiry;
    await assert.rejects(
      supervisor.renewLease(fence),
      (error: unknown) => (
        error instanceof TerminalSupervisorError && error.code === "stale_terminal_lease"
      ),
      "an expired lease",
    );

    // A closed session cannot be renewed either, and the refusal names the
    // fence: closing REVOKES the lease, so the generation has already moved.
    now = new Date(Date.parse(renewed.lease.expiresAt) - 1_000);
    await supervisor.close(fence);
    await assert.rejects(
      supervisor.renewLease(fence),
      (error: unknown) => (
        error instanceof TerminalSupervisorError && error.code === "stale_terminal_lease"
      ),
      "a closed session",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed terminal start clears the global active-session reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-terminal-supervisor-"));
  try {
    const workspace = join(directory, "workspace");
    const repository = join(workspace, "repo");
    await mkdir(join(repository, ".git"), { recursive: true });
    const projects = await ProjectRegistry.create({ personal: workspace });
    await projects.registerExisting({
      projectId,
      name: "Repo",
      rootId: "personal",
      relativePath: "repo",
    });
    const git: GitRunnerPort = {
      async run() {
        return { exitCode: 0, stdout: "abcdef1234567890", stderr: "" };
      },
    };
    const worktrees: WorktreeAllocationPort = {
      async allocate(input) {
        const worktreeRoot = join(directory, input.sessionId);
        await mkdir(worktreeRoot);
        return {
          sessionId: input.sessionId,
          branch: `mobile/${input.sessionId}`,
          baseCommit: input.baseCommit,
          worktreeRoot,
        };
      },
    };
    let attempts = 0;
    const terminals: DirectAgentTerminalPort = {
      async start() {
        attempts += 1;
        throw new Error("provider unavailable");
      },
    };
    const supervisor = new TerminalSupervisor({ projects, git, worktrees, terminals });
    const request = {
      projectId,
      ownerDeviceId,
      provider: "claude-code" as const,
      workspaceMode: "isolated-worktree" as const,
      cols: 80,
      rows: 24,
    };
    await assert.rejects(
      supervisor.createSession({ ...request, requestId: "failure-1" }),
      (error: unknown) => error instanceof TerminalSupervisorError && error.code === "terminal_start_failed",
    );
    await assert.rejects(
      supervisor.createSession({ ...request, requestId: "failure-2" }),
      (error: unknown) => error instanceof TerminalSupervisorError && error.code === "terminal_start_failed",
    );
    assert.equal(attempts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
