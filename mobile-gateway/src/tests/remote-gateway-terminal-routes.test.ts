import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceAuthService } from "../application/device-auth-service.js";
import type { DirectAgentTerminalPort } from "../application/ports/direct-agent-terminal-port.js";
import type { GitRunnerPort } from "../application/ports/git-runner-port.js";
import type { ProjectMembershipPort } from "../application/ports/project-membership-port.js";
import { ProjectRegistry } from "../application/project-registry.js";
import {
  TerminalSupervisor,
  type WorktreeAllocationPort,
} from "../application/terminal-supervisor.js";
import { AtomicJsonDeviceAuthStateStore } from "../infrastructure/atomic-json-device-auth-state-store.js";
import { InMemoryAuditLog } from "../infrastructure/in-memory-audit-log.js";
import { RemoteGatewayRouter } from "../interfaces/http/remote-gateway-router.js";
import { assertEnvelopeMatchesTables } from "./envelope-assertions.js";
import { pairTestDevice } from "./paired-device.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `remote-gateway-router.test.ts` buvo 888
 * eilutės). Čia — terminalo maršrutai: scope, valdymo narystė, lease fence'as ir mutacijų
 * idempotencija. Būtent jie eina per `remote-gateway-terminals.ts`, į kurį maršrutizatorių
 * skaidžiau, tad šis failas yra to skaidymo pagrindinis liudininkas.
 */

test("terminal routes enforce device scope, control membership, leases and mutation idempotency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-terminal-router-"));
  try {
    const now = new Date("2026-07-26T10:00:00.000Z");
    const workspace = join(directory, "workspace");
    const repository = join(workspace, "safe-repository");
    await mkdir(join(repository, ".git"), { recursive: true });
    const registry = await ProjectRegistry.create({ personal: workspace });
    const projectId = "123e4567-e89b-42d3-a456-426614174010";
    await registry.registerExisting({
      projectId,
      name: "Terminal project",
      rootId: "personal",
      relativePath: "safe-repository",
      branch: "main",
    });
    const auth = new DeviceAuthService(
      new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
    );
    const terminalDevice = await pairTestDevice(auth, now, ["terminal:write"], "Terminal phone");
    const readOnlyDevice = await pairTestDevice(auth, now, ["ag:read"], "Reader phone");
    const membership: ProjectMembershipPort = {
      async canReadProject() {
        return false;
      },
      async canControlTerminal(principalId, candidateProjectId) {
        return principalId === terminalDevice.principalId && candidateProjectId === projectId;
      },
    };
    const git: GitRunnerPort = {
      async run(_cwd, args) {
        assert.deepEqual(args, ["rev-parse", "--verify", "HEAD^{commit}"]);
        return { exitCode: 0, stdout: "abcdef1234567890\n", stderr: "" };
      },
    };
    const worktrees: WorktreeAllocationPort = {
      async allocate(input) {
        const worktreeRoot = join(directory, "sessions", input.sessionId);
        await mkdir(worktreeRoot, { recursive: true });
        return {
          sessionId: input.sessionId,
          branch: `mobile/${input.sessionId}`,
          baseCommit: input.baseCommit,
          worktreeRoot,
        };
      },
    };
    const writes: string[] = [];
    let starts = 0;
    let resizes = 0;
    let interrupts = 0;
    let terminates = 0;
    let closes = 0;
    const terminals: DirectAgentTerminalPort = {
      async start() {
        starts += 1;
        return {
          pid: 3456,
          executable: "C:/tools/codex.cmd",
          async write(text) {
            writes.push(text);
          },
          async resize() {
            resizes += 1;
          },
          async interrupt() {
            interrupts += 1;
          },
          async terminate() {
            terminates += 1;
          },
          async close() {
            closes += 1;
          },
        };
      },
    };
    const supervisor = new TerminalSupervisor({
      projects: registry,
      git,
      worktrees,
      terminals,
      clock: () => now,
      leaseTtlMs: 60_000,
    });
    const router = new RemoteGatewayRouter({
      deviceAuth: auth,
      now: () => now,
      terminals: supervisor,
      membership,
      audit: new InMemoryAuditLog(),
    });
    const terminalAuthorization = `Bearer ${terminalDevice.accessToken}`;
    const createPath = `/v1/projects/${projectId}/terminal-sessions`;
    const createRequest = {
      method: "POST",
      path: createPath,
      headers: {
        authorization: terminalAuthorization,
        "content-type": "application/json",
        "idempotency-key": "terminal-create-key-0001",
      },
      body: JSON.stringify({
        provider: "codex",
        workspaceMode: "isolated-worktree",
        cols: 100,
        rows: 30,
      }),
    } as const;

    assert.equal((await router.handle({
      ...createRequest,
      headers: { ...createRequest.headers, authorization: undefined },
    })).status, 401);
    const wrongScope = await router.handle({
      ...createRequest,
      headers: {
        ...createRequest.headers,
        authorization: `Bearer ${readOnlyDevice.accessToken}`,
      },
    });
    assert.equal(wrongScope.status, 403);
    assert.equal(assertEnvelopeMatchesTables(wrongScope, "wrong device scope"), "forbidden");
    assert.equal((await router.handle({
      ...createRequest,
      headers: { ...createRequest.headers, "idempotency-key": undefined },
    })).status, 400);
    const created = await router.handle(createRequest);
    assert.equal(created.status, 201);
    assert.equal(starts, 1);
    const repeatedCreate = await router.handle(createRequest);
    assert.equal(repeatedCreate.status, 201);
    assert.deepEqual(repeatedCreate.body, created.body);
    assert.equal(starts, 1);

    // A second session while the first is live is the host, not the request,
    // saying no — one mobile terminal at a time.
    const busy = await router.handle({
      ...createRequest,
      headers: { ...createRequest.headers, "idempotency-key": "terminal-create-key-0009" },
    });
    assert.equal(busy.status, 409);
    assert.equal(assertEnvelopeMatchesTables(busy, "second live session"), "host_busy");
    assert.equal(starts, 1);

    const sessionId = String(created.body["sessionId"]);
    const lease = created.body["lease"] as Record<string, unknown>;
    const sessionPath = `${createPath}/${sessionId}`;
    assert.equal((await router.handle({
      method: "GET",
      path: sessionPath,
      headers: { authorization: terminalAuthorization },
    })).status, 200);

    const fence = {
      requestId: "123e4567-e89b-42d3-a456-426614174020",
      leaseId: lease["leaseId"],
      leaseGeneration: lease["generation"],
    };
    const inputRequest = {
      method: "POST",
      path: `${sessionPath}/input`,
      headers: {
        authorization: terminalAuthorization,
        "content-type": "application/json",
        "idempotency-key": "terminal-input-key-00001",
      },
      body: JSON.stringify({
        ...fence,
        inputId: "123e4567-e89b-42d3-a456-426614174021",
        source: "voice",
        text: "run tests",
      }),
    } as const;
    assert.equal((await router.handle(inputRequest)).status, 202);
    assert.equal((await router.handle(inputRequest)).status, 202);
    assert.deepEqual(writes, ["run tests"]);
    const conflictingInput = await router.handle({
      ...inputRequest,
      body: JSON.stringify({
        ...fence,
        inputId: "123e4567-e89b-42d3-a456-426614174021",
        source: "voice",
        text: "different command",
      }),
    });
    assert.equal(conflictingInput.status, 409);
    assert.equal(
      assertEnvelopeMatchesTables(conflictingInput, "conflicting input"),
      "duplicate_request",
    );

    const resizeRequest = {
      method: "POST",
      path: `${sessionPath}/resize`,
      headers: {
        authorization: terminalAuthorization,
        "content-type": "application/json",
        "idempotency-key": "terminal-resize-key-001",
      },
      body: JSON.stringify({ ...fence, cols: 120, rows: 40 }),
    } as const;
    assert.equal((await router.handle(resizeRequest)).status, 204);
    assert.equal((await router.handle(resizeRequest)).status, 204);
    assert.equal(resizes, 1);

    const signalRequest = {
      method: "POST",
      path: `${sessionPath}/signal`,
      headers: {
        authorization: terminalAuthorization,
        "content-type": "application/json",
        "idempotency-key": "terminal-signal-key-001",
      },
      body: JSON.stringify({ ...fence, signal: "interrupt" }),
    } as const;
    assert.equal((await router.handle(signalRequest)).status, 202);
    assert.equal((await router.handle(signalRequest)).status, 202);
    assert.equal(interrupts, 1);

    const stale = await router.handle({
      ...resizeRequest,
      headers: {
        ...resizeRequest.headers,
        "idempotency-key": "terminal-resize-key-002",
      },
      body: JSON.stringify({ ...fence, leaseGeneration: 99, cols: 120, rows: 40 }),
    });
    assert.equal(stale.status, 409);
    assert.equal(assertEnvelopeMatchesTables(stale, "stale fence"), "stale_terminal_lease");

    const closeRequest = {
      method: "POST",
      path: `${sessionPath}/close`,
      headers: {
        authorization: terminalAuthorization,
        "content-type": "application/json",
        "idempotency-key": "terminal-close-key-0001",
      },
      body: JSON.stringify(fence),
    } as const;
    assert.equal((await router.handle(closeRequest)).status, 202);
    assert.equal((await router.handle(closeRequest)).status, 202);
    assert.equal(closes, 1);
    assert.equal(terminates, 0);

    const secondCreate = await router.handle({
      ...createRequest,
      headers: {
        ...createRequest.headers,
        "idempotency-key": "terminal-create-key-0002",
      },
    });
    assert.equal(secondCreate.status, 201);
    const secondLease = secondCreate.body["lease"] as Record<string, unknown>;
    const terminate = await router.handle({
      method: "POST",
      path: `${createPath}/${String(secondCreate.body["sessionId"])}/signal`,
      headers: {
        authorization: terminalAuthorization,
        "content-type": "application/json",
        "idempotency-key": "terminal-terminate-key-01",
      },
      body: JSON.stringify({
        requestId: "123e4567-e89b-42d3-a456-426614174022",
        leaseId: secondLease["leaseId"],
        leaseGeneration: secondLease["generation"],
        signal: "terminate",
      }),
    });
    assert.equal(terminate.status, 202);
    assert.equal(terminates, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
