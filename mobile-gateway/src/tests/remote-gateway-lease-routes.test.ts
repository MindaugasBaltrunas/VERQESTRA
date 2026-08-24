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
 * eilutės). Lease pratęsimas laikomas atskirai, nes jam reikia JUDANČIO laikrodžio: terminalo
 * maršrutų fikstūra pina `const now`, o pratęsimas matomas tik tada, kai laikas pajuda tarp
 * sukūrimo ir atnaujinimo.
 */

test("the lease renewal route extends a live lease without changing its identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-lease-router-"));
  try {
    // Mutable, unlike the terminal-routes fixture: renewal is only observable if
    // the clock can move between the create and the renew.
    let now = new Date("2026-07-26T10:00:00.000Z");
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, "safe-repository", ".git"), { recursive: true });
    const registry = await ProjectRegistry.create({ personal: workspace });
    const projectId = "123e4567-e89b-42d3-a456-426614174030";
    await registry.registerExisting({
      projectId,
      name: "Lease project",
      rootId: "personal",
      relativePath: "safe-repository",
      branch: "main",
    });
    const auth = new DeviceAuthService(
      new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
    );
    const device = await pairTestDevice(auth, now, ["terminal:write"], "Lease phone");
    const membership: ProjectMembershipPort = {
      async canReadProject() {
        return false;
      },
      async canControlTerminal(principalId, candidateProjectId) {
        return principalId === device.principalId && candidateProjectId === projectId;
      },
    };
    const git: GitRunnerPort = {
      async run() {
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
    const terminals: DirectAgentTerminalPort = {
      async start() {
        return {
          pid: 6789,
          executable: "C:/tools/codex.cmd",
          async write() {},
          async resize() {},
          async interrupt() {},
          async terminate() {},
          async close() {},
        };
      },
    };
    const audit = new InMemoryAuditLog();
    const router = new RemoteGatewayRouter({
      deviceAuth: auth,
      now: () => now,
      terminals: new TerminalSupervisor({
        projects: registry,
        git,
        worktrees,
        terminals,
        clock: () => now,
        leaseTtlMs: 60_000,
      }),
      membership,
      audit,
    });
    const authorization = `Bearer ${device.accessToken}`;
    const created = await router.handle({
      method: "POST",
      path: `/v1/projects/${projectId}/terminal-sessions`,
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "lease-create-key-000001",
      },
      body: JSON.stringify({
        provider: "codex",
        workspaceMode: "isolated-worktree",
        cols: 100,
        rows: 30,
      }),
    });
    assert.equal(created.status, 201);
    const sessionId = String(created.body["sessionId"]);
    const lease = created.body["lease"] as Record<string, unknown>;
    const leasePath = `/v1/projects/${projectId}/terminal-sessions/${sessionId}/lease`;
    const fence = {
      requestId: "123e4567-e89b-42d3-a456-426614174031",
      leaseId: lease["leaseId"],
      leaseGeneration: lease["generation"],
    };
    const renewRequest = {
      method: "POST",
      path: leasePath,
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "lease-renew-key-0000001",
      },
      body: JSON.stringify(fence),
    } as const;

    // Authentication happens before the body is read, so an anonymous caller
    // cannot use the DTO as an oracle for the request shape.
    const anonymous = await router.handle({
      ...renewRequest,
      headers: { ...renewRequest.headers, authorization: undefined },
      body: "}not json{",
    });
    assert.equal(anonymous.status, 401);
    assert.equal(assertEnvelopeMatchesTables(anonymous, "anonymous renewal"), "unauthenticated");

    const noKey = await router.handle({
      ...renewRequest,
      headers: { ...renewRequest.headers, "idempotency-key": undefined },
    });
    assert.equal(noKey.status, 400);
    assert.equal(assertEnvelopeMatchesTables(noKey, "renewal without a key"), "invalid_request");

    now = new Date(now.getTime() + 30_000);
    const renewed = await router.handle(renewRequest);
    assert.equal(renewed.status, 200);
    const renewedLease = renewed.body["lease"] as Record<string, unknown>;
    assert.equal(renewed.body["sessionId"], sessionId);
    assert.equal(renewedLease["leaseId"], lease["leaseId"]);
    assert.equal(renewedLease["generation"], lease["generation"]);
    assert.equal(renewedLease["ownerDeviceId"], lease["ownerDeviceId"]);
    assert.equal(renewedLease["expiresAt"], new Date(now.getTime() + 60_000).toISOString());
    assert.ok(Date.parse(String(renewedLease["expiresAt"])) > Date.parse(String(lease["expiresAt"])));

    // A retry with the same key must not extend the lease a second time.
    now = new Date(now.getTime() + 10_000);
    const replay = await router.handle(renewRequest);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, renewed.body);

    const reusedKey = await router.handle({
      ...renewRequest,
      body: JSON.stringify({ ...fence, requestId: "123e4567-e89b-42d3-a456-426614174032" }),
    });
    assert.equal(reusedKey.status, 409);
    assert.equal(assertEnvelopeMatchesTables(reusedKey, "reused renewal key"), "duplicate_request");

    assert.deepEqual(
      audit.entries().filter((event) => event.action === "terminal.lease.renew").map((event) => ({
        outcome: event.outcome,
        sessionId: event.sessionId,
        projectId: event.projectId,
      })),
      [
        // The anonymous attempt and the missing key are recorded too: a refused
        // renewal is exactly the attempt an operator needs to see.
        { outcome: "denied", sessionId, projectId },
        { outcome: "denied", sessionId, projectId },
        { outcome: "allowed", sessionId, projectId },
        { outcome: "allowed", sessionId, projectId },
        { outcome: "denied", sessionId, projectId },
      ],
    );

    // A session the supervisor never had is not a missing route: the project is
    // visible and the path is real, so the answer is about the session.
    const unknownSession = await router.handle({
      method: "GET",
      path: `/v1/projects/${projectId}/terminal-sessions/123e4567-e89b-42d3-a456-426614174099`,
      headers: { authorization },
    });
    assert.equal(unknownSession.status, 409);
    assert.equal(
      assertEnvelopeMatchesTables(unknownSession, "unknown session"),
      "session_not_live",
    );

    // A closed session has no write access left to extend.
    assert.equal((await router.handle({
      method: "POST",
      path: `/v1/projects/${projectId}/terminal-sessions/${sessionId}/close`,
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "lease-close-key-00000001",
      },
      body: JSON.stringify({ ...fence, requestId: "123e4567-e89b-42d3-a456-426614174033" }),
    })).status, 202);
    const afterClose = await router.handle({
      ...renewRequest,
      headers: { ...renewRequest.headers, "idempotency-key": "lease-renew-key-0000002" },
    });
    assert.equal(afterClose.status, 409);
    // The lease was revoked by the close, so the fence is stale before liveness
    // is ever considered — the order the supervisor checks in.
    assert.equal(
      assertEnvelopeMatchesTables(afterClose, "renewal after close"),
      "stale_terminal_lease",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
