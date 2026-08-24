import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceAuthService } from "../application/device-auth-service.js";
import type { AuditEvent, AuditPort } from "../application/ports/audit-port.js";
import type { DirectAgentTerminalPort } from "../application/ports/direct-agent-terminal-port.js";
import type { GitRunnerPort } from "../application/ports/git-runner-port.js";
import type { ProjectMembershipPort } from "../application/ports/project-membership-port.js";
import { ProjectRegistry } from "../application/project-registry.js";
import {
  TerminalSupervisor,
  type WorktreeAllocationPort,
} from "../application/terminal-supervisor.js";
import {
  PAIRING_ATTEMPT_POLICY,
  TERMINAL_MUTATION_POLICY,
} from "../application/gateway-rate-limits.js";
import { AtomicJsonDeviceAuthStateStore } from "../infrastructure/atomic-json-device-auth-state-store.js";
import { InMemoryAuditLog } from "../infrastructure/in-memory-audit-log.js";
import { RemoteGatewayRouter } from "../interfaces/http/remote-gateway-router.js";
import { assertEnvelopeMatchesTables } from "./envelope-assertions.js";
import { pairTestDevice } from "./paired-device.js";

/**
 * NUKRYPIMAS (be elgesio pokyčio): etalono lokalus `pairDevice` pakeistas jau esamu
 * `paired-device.ts#pairTestDevice`. Tai ta pati operacija; skyrėsi tik nonce ir hosto
 * pirštų atspaudas, o nė vienas jų šio failo teiginiuose nedalyvauja.
 */

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174030";
const SOURCE = "203.0.113.10";

type TerminalFixture = Readonly<{
  router: RemoteGatewayRouter;
  auth: DeviceAuthService;
  terminalToken: string;
  startAttempts: () => number;
}>;

async function terminalFixture(
  directory: string,
  now: () => Date,
  options: { audit?: AuditPort; failFirstStart?: boolean } = {},
): Promise<TerminalFixture> {
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "repository", ".git"), { recursive: true });
  const registry = await ProjectRegistry.create({ personal: workspace });
  await registry.registerExisting({
    projectId: PROJECT_ID,
    name: "Hardening project",
    rootId: "personal",
    relativePath: "repository",
    branch: "main",
  });
  const auth = new DeviceAuthService(
    new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
  );
  const device = await pairTestDevice(auth, now(), ["terminal:write"], "Hardening phone");
  const membership: ProjectMembershipPort = {
    async canReadProject() {
      return false;
    },
    async canControlTerminal(principalId, projectId) {
      return principalId === device.principalId && projectId === PROJECT_ID;
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
  let starts = 0;
  const terminals: DirectAgentTerminalPort = {
    async start() {
      starts += 1;
      if (options.failFirstStart && starts === 1) {
        throw new Error("PTY unavailable");
      }
      return {
        pid: 2345,
        executable: "C:/tools/codex.cmd",
        async write() {},
        async resize() {},
        async interrupt() {},
        async terminate() {},
        async close() {},
      };
    },
  };
  const supervisor = new TerminalSupervisor({
    projects: registry,
    git,
    worktrees,
    terminals,
    clock: now,
    leaseTtlMs: 60_000,
  });
  return {
    router: new RemoteGatewayRouter({
      deviceAuth: auth,
      now,
      terminals: supervisor,
      membership,
      audit: options.audit ?? new InMemoryAuditLog(),
    }),
    auth,
    terminalToken: device.accessToken,
    startAttempts: () => starts,
  };
}

/** `noPropertyAccessFromIndexSignature`: klaidos vokas skaitomas per bracket. */
function errorField(body: Readonly<Record<string, unknown>>, field: string): unknown {
  return (body["error"] as Record<string, unknown> | undefined)?.[field];
}

test("pairing redemption is rate limited per source before any proof verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-ratelimit-"));
  try {
    let current = new Date("2026-07-28T10:00:00.000Z");
    const auth = new DeviceAuthService(
      new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
    );
    const router = new RemoteGatewayRouter({
      deviceAuth: auth,
      now: () => current,
      audit: new InMemoryAuditLog(),
    });
    const attempt = (remoteAddress: string) => router.handle({
      method: "POST",
      path: "/v1/pairing-challenges/123e4567-e89b-42d3-a456-426614174099/redeem",
      headers: { "content-type": "application/json" },
      remoteAddress,
      body: JSON.stringify({
        oneTimeCode: "x".repeat(32),
        deviceName: "Attacker",
        devicePublicKey: "AAAA",
        nonce: "attacker-nonce-000001",
        proof: "AAAA",
      }),
    });

    for (let index = 0; index < PAIRING_ATTEMPT_POLICY.limit; index += 1) {
      const rejected = await attempt(SOURCE);
      assert.equal(rejected.status, 400, `attempt ${index + 1} should reach validation`);
    }
    const throttled = await attempt(SOURCE);
    assert.equal(throttled.status, 429);
    assert.equal(errorField(throttled.body, "code"), "rate_limited");
    assert.match(String(throttled.headers["retry-after"]), /^[1-9][0-9]*$/);

    // The budget is per source, so one abusive peer cannot lock out the owner.
    assert.equal((await attempt("198.51.100.7")).status, 400);

    // The window drains instead of extending itself while denied.
    current = new Date(current.getTime() + PAIRING_ATTEMPT_POLICY.windowMs + 1000);
    assert.equal((await attempt(SOURCE)).status, 400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal create authenticates before it parses an untrusted body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-authfirst-"));
  try {
    const now = new Date("2026-07-28T10:00:00.000Z");
    const fixture = await terminalFixture(directory, () => now);
    const path = `/v1/projects/${PROJECT_ID}/terminal-sessions`;

    // No credential, no Idempotency-Key and an unsupported field: the caller
    // must learn only that it is unauthenticated, never how the DTO validates.
    const anonymous = await fixture.router.handle({
      method: "POST",
      path,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "bash", executable: "powershell.exe" }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal(errorField(anonymous.body, "code"), "unauthenticated");
    assert.equal(fixture.startAttempts(), 0);

    // Validation still runs once the caller is authenticated and authorized.
    const authenticated = await fixture.router.handle({
      method: "POST",
      path,
      headers: {
        authorization: `Bearer ${fixture.terminalToken}`,
        "content-type": "application/json",
        "idempotency-key": "terminal-create-key-0009",
      },
      body: JSON.stringify({ provider: "bash", executable: "powershell.exe" }),
    });
    assert.equal(authenticated.status, 400);
    assert.equal(fixture.startAttempts(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mutations are audited with identifiers only, never terminal content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-audit-"));
  try {
    const now = new Date("2026-07-28T10:00:00.000Z");
    const audit = new InMemoryAuditLog();
    const fixture = await terminalFixture(directory, () => now, { audit });
    const authorization = `Bearer ${fixture.terminalToken}`;
    const createPath = `/v1/projects/${PROJECT_ID}/terminal-sessions`;
    const created = await fixture.router.handle({
      method: "POST",
      path: createPath,
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "terminal-create-key-0010",
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
    // Deliberately not credential-shaped: the repository secret scan is a hard
    // gate, and the assertion only needs a marker that cannot occur by accident.
    const secret = "canary-terminal-content-must-never-be-audited";
    const input = await fixture.router.handle({
      method: "POST",
      path: `${createPath}/${sessionId}/input`,
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": "terminal-input-key-00010",
      },
      body: JSON.stringify({
        requestId: "123e4567-e89b-42d3-a456-426614174031",
        leaseId: lease["leaseId"],
        leaseGeneration: lease["generation"],
        inputId: "123e4567-e89b-42d3-a456-426614174032",
        source: "voice",
        text: `export TOKEN=${secret}`,
      }),
    });
    assert.equal(input.status, 202);

    const denied = await fixture.router.handle({
      method: "POST",
      path: `${createPath}/${sessionId}/input`,
      headers: { "content-type": "application/json", "idempotency-key": "terminal-input-key-00011" },
      body: JSON.stringify({}),
    });
    assert.equal(denied.status, 401);

    const entries = audit.entries();
    assert.deepEqual(entries.map((entry: AuditEvent) => entry.action), [
      "terminal.session.create",
      "terminal.input",
      "terminal.input",
    ]);
    assert.deepEqual(entries.map((entry: AuditEvent) => entry.outcome), [
      "allowed",
      "allowed",
      "denied",
    ]);
    assert.equal(entries[1]?.sessionId, sessionId);
    assert.equal(entries[1]?.requestId, "123e4567-e89b-42d3-a456-426614174031");
    assert.equal(entries[2]?.reasonCode, "unauthenticated");
    assert.equal(entries[2]?.principalId, undefined);

    const serialized = JSON.stringify(entries);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("export TOKEN"), false);
    assert.equal(serialized.includes(fixture.terminalToken), false);
    assert.equal(serialized.includes(directory), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unwritable audit record fails the request closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-audit-fail-"));
  try {
    const now = new Date("2026-07-28T10:00:00.000Z");
    const audit: AuditPort = {
      async record() {
        throw new Error("audit sink unavailable");
      },
    };
    const fixture = await terminalFixture(directory, () => now, { audit });
    const response = await fixture.router.handle({
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/terminal-sessions`,
      headers: {
        authorization: `Bearer ${fixture.terminalToken}`,
        "content-type": "application/json",
        "idempotency-key": "terminal-create-key-0011",
      },
      body: JSON.stringify({
        provider: "codex",
        workspaceMode: "isolated-worktree",
        cols: 100,
        rows: 30,
      }),
    });
    assert.equal(response.status, 500);
    assert.equal(assertEnvelopeMatchesTables(response, "unwritable audit"), "internal_error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authenticated terminal mutations are bounded per device", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-device-quota-"));
  try {
    let current = new Date("2026-07-28T10:00:00.000Z");
    const fixture = await terminalFixture(directory, () => current);
    const authorization = `Bearer ${fixture.terminalToken}`;
    const path = `/v1/projects/${PROJECT_ID}/terminal-sessions`;
    // A malformed body keeps every attempt cheap while still passing the quota
    // gate, which runs immediately after authorization.
    const attempt = (index: number) => fixture.router.handle({
      method: "POST",
      path,
      headers: {
        authorization,
        "content-type": "application/json",
        "idempotency-key": `terminal-quota-key-${String(index).padStart(6, "0")}`,
      },
      body: JSON.stringify({ provider: "bash" }),
    });

    for (let index = 0; index < TERMINAL_MUTATION_POLICY.limit; index += 1) {
      assert.equal((await attempt(index)).status, 400, `attempt ${index + 1}`);
    }
    const throttled = await attempt(TERMINAL_MUTATION_POLICY.limit);
    assert.equal(throttled.status, 429);
    assert.equal(assertEnvelopeMatchesTables(throttled, "device quota"), "rate_limited");
    assert.equal(fixture.startAttempts(), 0);

    current = new Date(current.getTime() + TERMINAL_MUTATION_POLICY.windowMs + 1000);
    assert.equal((await attempt(TERMINAL_MUTATION_POLICY.limit + 1)).status, 400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed mutation releases its idempotency slot so the same key can retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-idempotency-"));
  try {
    const now = new Date("2026-07-28T10:00:00.000Z");
    const fixture = await terminalFixture(directory, () => now, { failFirstStart: true });
    const request = {
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/terminal-sessions`,
      headers: {
        authorization: `Bearer ${fixture.terminalToken}`,
        "content-type": "application/json",
        "idempotency-key": "terminal-create-key-0012",
      },
      body: JSON.stringify({
        provider: "codex",
        workspaceMode: "isolated-worktree",
        cols: 100,
        rows: 30,
      }),
    } as const;

    const failed = await fixture.router.handle(request);
    assert.equal(failed.status, 500);

    const retried = await fixture.router.handle(request);
    assert.equal(retried.status, 201);
    assert.equal(fixture.startAttempts(), 2);

    // A successful result is still replayed rather than re-executed.
    const replayed = await fixture.router.handle(request);
    assert.equal(replayed.status, 201);
    assert.deepEqual(replayed.body, retried.body);
    assert.equal(fixture.startAttempts(), 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
