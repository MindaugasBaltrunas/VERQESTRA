import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceAuthError, DeviceAuthService } from "../application/device-auth-service.js";
import { LocalControlError } from "../application/local-control-errors.js";
import { LocalControlService } from "../application/local-control-service.js";
import type {
  DirectAgentTerminalHandle,
  DirectAgentTerminalPort,
} from "../application/ports/direct-agent-terminal-port.js";
import type { ProcessIdentityPort } from "../application/ports/process-identity-port.js";
import { ProjectRegistry } from "../application/project-registry.js";
import {
  TerminalSupervisor,
  TerminalSupervisorError,
  type WorktreeAllocationPort,
} from "../application/terminal-supervisor.js";
import type { ProcessIdentity } from "../domain/session-registry.js";
import {
  DEVICE_ID,
  fakeRepository,
  inMemoryDeviceAuthState,
  memoryRegistryStore,
  NOW,
  routerFixture,
  SESSION_ID,
} from "./local-control-doubles.js";
import { pairTestDevice } from "./paired-device.js";

/**
 * Local recovery: force-closing a session and revoking a device.
 *
 * Both operations are destructive in the only sense that matters here — they end
 * something an owner is relying on — so every test asserts what did NOT happen
 * as well: no termination without a verified identity, no termination on a stale
 * fencing token, and no change to the worktree record in either case.
 */

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174030";
const GATEWAY_INSTANCE_ID = "123e4567-e89b-42d3-a456-426614174031";
const RECORDED_IDENTITY: ProcessIdentity = Object.freeze({
  pid: 4567,
  startedAt: "2026-08-09T09:59:00.000Z",
  executable: "C:/tools/codex.cmd",
});

type Harness = {
  supervisor: TerminalSupervisor;
  control: LocalControlService;
  deviceAuth: DeviceAuthService;
  registry: ReturnType<typeof memoryRegistryStore>;
  sessionId: string;
  deviceId: string;
  accessToken: string;
  terminated: string[];
  observeIdentity: (identity: ProcessIdentity | undefined) => void;
  disconnected: Array<{ sessionIds: readonly string[]; reason: string }>;
  dispose: () => Promise<void>;
};

type HarnessOptions = {
  /** Identity the host reports while the session starts; `undefined` records none. */
  identityAtStart?: ProcessIdentity | undefined;
  /** Builds the supervisor without a host process table at all. */
  withoutProcessTable?: boolean;
};

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "ag-local-recovery-"));
  const workspace = join(directory, "workspace");
  const repository = join(workspace, "repo");
  await mkdir(join(repository, ".git"), { recursive: true });
  const projects = await ProjectRegistry.create({ personal: workspace });
  await projects.registerExisting({
    projectId: PROJECT_ID,
    name: "Repo",
    rootId: "personal",
    relativePath: "repo",
    branch: "main",
  });
  const repo = fakeRepository();
  const terminated: string[] = [];
  const worktrees: WorktreeAllocationPort = {
    async allocate(input) {
      return {
        sessionId: input.sessionId,
        branch: `mobile/${input.sessionId}`,
        baseCommit: input.baseCommit,
        worktreeRoot: join(directory, "sessions", input.sessionId),
      };
    },
  };
  let observed: ProcessIdentity | undefined = "identityAtStart" in options
    ? options.identityAtStart
    : RECORDED_IDENTITY;
  const processes: ProcessIdentityPort = {
    async identify() {
      return observed;
    },
  };
  const registry = memoryRegistryStore();
  const deviceAuth = new DeviceAuthService(inMemoryDeviceAuthState());
  const device = await pairTestDevice(deviceAuth, NOW, ["ag:read", "terminal:write"]);
  const disconnected: Array<{ sessionIds: readonly string[]; reason: string }> = [];
  let sessionId = "";
  const handle: DirectAgentTerminalHandle = {
    pid: RECORDED_IDENTITY.pid,
    executable: RECORDED_IDENTITY.executable,
    async write() { /* unused by recovery */ },
    async resize() { /* unused by recovery */ },
    async interrupt() { /* unused by recovery */ },
    async terminate() {
      terminated.push(sessionId);
    },
    async close() { /* unused by recovery */ },
  };
  const terminals: DirectAgentTerminalPort = {
    async start() {
      return handle;
    },
  };
  const supervisor = new TerminalSupervisor({
    projects,
    git: repo.git,
    worktrees,
    terminals,
    clock: () => NOW,
    leaseTtlMs: 60_000,
    // The persistence trio is all-or-nothing, so dropping the process table
    // means dropping the registry with it.
    ...(options.withoutProcessTable
      ? {}
      : { registry, processes, gatewayInstanceId: GATEWAY_INSTANCE_ID }),
  });
  const created = await supervisor.createSession({
    projectId: PROJECT_ID,
    ownerDeviceId: device.deviceId,
    requestId: "create-request-1",
    provider: "codex",
    workspaceMode: "isolated-worktree",
    cols: 100,
    rows: 30,
  });
  sessionId = created.sessionId;
  const control = new LocalControlService({
    deviceAuth,
    terminals: supervisor,
    hostFingerprint: () => "sha256:33333333333333333333333333333333",
    pairingOrigin: () => "https://127.0.0.1:8443",
    clock: () => NOW,
    disconnectStreams: async (sessionIds, reason) => {
      disconnected.push({ sessionIds, reason });
    },
  });
  return {
    supervisor,
    control,
    deviceAuth,
    registry,
    sessionId,
    deviceId: device.deviceId,
    accessToken: device.accessToken,
    terminated,
    observeIdentity: (identity) => {
      observed = identity;
    },
    disconnected,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

test("a stale fencing revision refuses the force close without touching the process", async () => {
  const context = await harness();
  try {
    const view = await context.supervisor.localSessionView(context.sessionId);
    assert.equal(view.state, "live");
    await assert.rejects(
      context.supervisor.forceCloseLocally({
        sessionId: context.sessionId,
        requestId: randomUUID(),
        reason: "Owner requested local recovery",
        expectedSessionRevision: view.revision + 1,
      }),
      (error: unknown) => error instanceof TerminalSupervisorError
        && error.code === "session_revision_mismatch",
    );
    assert.deepEqual(context.terminated, []);
    assert.equal((await context.supervisor.localSessionView(context.sessionId)).state, "live");
  } finally {
    await context.dispose();
  }
});

test("an unverifiable process identity orphans the session instead of terminating it", async () => {
  const context = await harness();
  try {
    const view = await context.supervisor.localSessionView(context.sessionId);
    context.observeIdentity({ ...RECORDED_IDENTITY, startedAt: "2026-08-09T09:58:00.000Z" });
    await assert.rejects(
      context.supervisor.forceCloseLocally({
        sessionId: context.sessionId,
        requestId: randomUUID(),
        reason: "Owner requested local recovery",
        expectedSessionRevision: view.revision,
      }),
      (error: unknown) => error instanceof TerminalSupervisorError
        && error.code === "process_identity_unverified",
    );
    assert.deepEqual(context.terminated, []);
    const after = await context.supervisor.localSessionView(context.sessionId);
    assert.equal(after.state, "orphaned");
    assert.equal(after.lease.generation, view.lease.generation + 1);
  } finally {
    await context.dispose();
  }
});

test("a process the host no longer reports is orphaned rather than force closed", async () => {
  const context = await harness();
  try {
    const view = await context.supervisor.localSessionView(context.sessionId);
    context.observeIdentity(undefined);
    await assert.rejects(
      context.supervisor.forceCloseLocally({
        sessionId: context.sessionId,
        requestId: randomUUID(),
        reason: "Owner requested local recovery",
        expectedSessionRevision: view.revision,
      }),
      (error: unknown) => error instanceof TerminalSupervisorError
        && error.code === "process_identity_unverified",
    );
    assert.deepEqual(context.terminated, []);
  } finally {
    await context.dispose();
  }
});

test("a session that never recorded an identity is orphaned rather than force closed", async () => {
  // The host answered nothing when the session started, so there is no identity
  // to compare against later. Skipping the comparison would make the contract's
  // check optional for exactly the sessions it cannot verify.
  const context = await harness({ identityAtStart: undefined });
  try {
    const view = await context.supervisor.localSessionView(context.sessionId);
    context.observeIdentity(RECORDED_IDENTITY);
    await assert.rejects(
      context.supervisor.forceCloseLocally({
        sessionId: context.sessionId,
        requestId: randomUUID(),
        reason: "Owner requested local recovery",
        expectedSessionRevision: view.revision,
      }),
      (error: unknown) => error instanceof TerminalSupervisorError
        && error.code === "process_identity_unverified",
    );
    assert.deepEqual(context.terminated, []);
    assert.equal((await context.supervisor.localSessionView(context.sessionId)).state, "orphaned");
  } finally {
    await context.dispose();
  }
});

test("a supervisor with no host process table cannot force close at all", async () => {
  const context = await harness({ withoutProcessTable: true });
  try {
    const view = await context.supervisor.localSessionView(context.sessionId);
    await assert.rejects(
      context.supervisor.forceCloseLocally({
        sessionId: context.sessionId,
        requestId: randomUUID(),
        reason: "Owner requested local recovery",
        expectedSessionRevision: view.revision,
      }),
      (error: unknown) => error instanceof TerminalSupervisorError
        && error.code === "process_identity_unverified",
    );
    assert.deepEqual(context.terminated, []);
    // The session is untouched: what is missing is the composition, not the
    // session's own health.
    const after = await context.supervisor.localSessionView(context.sessionId);
    assert.equal(after.state, "live");
    assert.equal(after.lease.generation, view.lease.generation);
  } finally {
    await context.dispose();
  }
});

test("a verified force close ends the session, fences the lease and keeps the worktree", async () => {
  const context = await harness();
  try {
    const before = await context.supervisor.localSessionView(context.sessionId);
    const worktreesBefore = structuredClone(context.registry.current().worktrees);
    const requestId = randomUUID();
    const closed = await context.control.forceCloseSession({
      requestId,
      sessionId: context.sessionId,
      reason: "Owner requested local recovery",
      expectedSessionRevision: before.revision,
    });
    assert.equal(closed.state, "ended");
    assert.equal(closed.lease.generation, before.lease.generation + 1);
    assert.deepEqual(context.terminated, [context.sessionId]);
    assert.deepEqual(context.registry.current().worktrees, worktreesBefore);

    // Replaying the same request id returns the first outcome; it does not
    // terminate anything a second time.
    const replay = await context.control.forceCloseSession({
      requestId,
      sessionId: context.sessionId,
      reason: "Owner requested local recovery",
      expectedSessionRevision: before.revision,
    });
    assert.deepEqual(replay, closed);
    assert.deepEqual(context.terminated, [context.sessionId]);

    await assert.rejects(
      context.control.forceCloseSession({
        requestId,
        sessionId: "223e4567-e89b-42d3-a456-426614174040",
        reason: "Owner requested local recovery",
        expectedSessionRevision: before.revision,
      }),
      (error: unknown) => error instanceof LocalControlError && error.code === "duplicate_request",
    );
  } finally {
    await context.dispose();
  }
});

/**
 * The bound of the request-id ledger, restated from `local-control-service.ts`.
 *
 * It is written out here rather than exported from the service because the
 * number is a promise to an operator — a full ledger refuses new work instead of
 * forgetting an old outcome — and a test that imported it could no longer notice
 * the bound being quietly raised or dropped.
 */
const REQUEST_LEDGER_CAPACITY = 1024;

test("a request id whose operation failed is free to be retried", async () => {
  // The ledger exists to stop a repeat from acting twice. An attempt that never
  // acted must therefore release its slot, or a recovery action that failed
  // could never be retried with the id the operator already recorded.
  const fixture = await routerFixture();
  const requestId = randomUUID();
  await assert.rejects(fixture.control.forceCloseSession({
    requestId,
    sessionId: SESSION_ID,
    reason: "Owner requested local recovery",
    expectedSessionRevision: 1,
  }));

  const retried = await fixture.control.revokeDevice({
    requestId,
    deviceId: DEVICE_ID,
    reason: "Lost device",
  });
  assert.deepEqual([...retried.revokedSessionIds], []);
});

test("a full request ledger refuses new work but still answers a recorded request", async () => {
  const fixture = await routerFixture();
  const recorded = randomUUID();
  const first = await fixture.control.revokeDevice({
    requestId: recorded,
    deviceId: DEVICE_ID,
    reason: "Lost device",
  });
  for (let index = 1; index < REQUEST_LEDGER_CAPACITY; index += 1) {
    await fixture.control.revokeDevice({
      requestId: randomUUID(),
      deviceId: DEVICE_ID,
      reason: "Lost device",
    });
  }

  const isRateLimited = (error: unknown): boolean =>
    error instanceof LocalControlError && error.code === "rate_limited";
  await assert.rejects(
    fixture.control.revokeDevice({ requestId: randomUUID(), deviceId: DEVICE_ID, reason: "Lost device" }),
    isRateLimited,
  );
  // The ledger is shared, so exhausting it through one operation closes the
  // others too rather than leaving a way around the bound.
  await assert.rejects(
    fixture.control.forceCloseSession({
      requestId: randomUUID(),
      sessionId: SESSION_ID,
      reason: "Owner requested local recovery",
      expectedSessionRevision: 1,
    }),
    isRateLimited,
  );

  // Refusing new ids must not break the property the ledger exists for: a repeat
  // of something already recorded still gets its original outcome.
  const replay = await fixture.control.revokeDevice({
    requestId: recorded,
    deviceId: DEVICE_ID,
    reason: "Lost device",
  });
  assert.deepEqual(replay, first);
});

test("revoking a device fences its leases and disconnects its streams without touching the repository", async () => {
  const context = await harness();
  try {
    const before = await context.supervisor.localSessionView(context.sessionId);
    const worktreesBefore = structuredClone(context.registry.current().worktrees);
    const result = await context.control.revokeDevice({
      requestId: randomUUID(),
      deviceId: context.deviceId,
      reason: "Lost device",
    });

    assert.deepEqual([...result.revokedSessionIds], [context.sessionId]);
    assert.deepEqual(context.disconnected, [{
      sessionIds: result.revokedSessionIds,
      reason: "Lost device",
    }]);
    const after = await context.supervisor.localSessionView(context.sessionId);
    assert.equal(after.lease.generation, before.lease.generation + 1);
    // The agent keeps running and the work keeps its home.
    assert.equal(after.state, "live");
    assert.deepEqual(context.terminated, []);
    assert.deepEqual(context.registry.current().worktrees, worktreesBefore);
    await assert.rejects(
      context.deviceAuth.authorizeAccessToken(context.accessToken, "terminal:write", NOW),
      (error: unknown) => error instanceof DeviceAuthError,
    );
  } finally {
    await context.dispose();
  }
});
