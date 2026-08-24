import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { integrationConfirmationProof } from "../application/local-control-auth.js";
import type { AuditEvent, AuditPort } from "../application/ports/audit-port.js";
import { REQUIRED_GATE_NAMES } from "../application/session-gate-policy.js";
import {
  DEVICE_ID,
  everyLocalRoute,
  localRequest,
  MERGE_COMMIT,
  routerFixture,
  sessionRecord,
  SESSION_ID,
  SOURCE_COMMIT,
  TARGET_HEAD,
  worktreeRecord,
} from "./local-control-doubles.js";

/**
 * The routing half of `local-control-contract.md`: what a request may contain
 * and what the host records about it.
 *
 * The audit assertions are the reason this file exists separately from the
 * transport one. A local action is the most consequential thing the gateway
 * does, so it must be recorded — and recorded WITHOUT the one-time pairing code
 * that the same request produced.
 *
 * NUKRYPIMAS (formos, ne elgesio): atsakymo kūno laukai skaitomi per bracket —
 * `noPropertyAccessFromIndexSignature`; kūnas yra `Record<string, unknown>`, tad nė vienas
 * laukas dar nėra įrodytas egzistuojančiu.
 */

function errorCode(body: Readonly<Record<string, unknown>>): string {
  return (body["error"] as { code?: string } | undefined)?.code ?? "";
}

const VALID_BODIES: Readonly<Record<string, Record<string, unknown>>> = {
  "/v1/local/pairing-challenges": { deviceName: "Owner phone", scopes: ["ag:read", "terminal:write"] },
  [`/v1/local/terminal-sessions/${SESSION_ID}/force-close`]: {
    requestId: "123e4567-e89b-42d3-a456-426614174020",
    reason: "Owner requested local recovery",
    expectedSessionRevision: 3,
  },
  [`/v1/local/terminal-sessions/${SESSION_ID}/integrate`]: {
    integrationId: "123e4567-e89b-42d3-a456-426614174021",
    sourceCommit: SOURCE_COMMIT,
    expectedTargetHead: TARGET_HEAD,
    diffDigest: `sha256:${"1".repeat(64)}`,
    gateDigest: `sha256:${"2".repeat(64)}`,
    strategy: "merge-no-ff",
    confirmation: "local-reauth-proof",
  },
  [`/v1/local/devices/${DEVICE_ID}/revoke`]: {
    requestId: "123e4567-e89b-42d3-a456-426614174022",
    reason: "Lost device",
  },
};

/**
 * `noUncheckedIndexedAccess` turns every lookup above into `… | undefined`. Rather than
 * asserting non-null at each call site, the absence is checked once and LOUDLY: a path this
 * file forgot to declare a body for would otherwise be probed with an empty request and the
 * test would pass for the wrong reason.
 */
function validBody(path: string): Record<string, unknown> {
  const body = VALID_BODIES[path];
  assert.ok(body, `no valid body is declared for ${path}`);
  return body;
}

test("every local DTO accepts exactly its documented fields", async () => {
  const fixture = await routerFixture();
  for (const [path, body] of Object.entries(VALID_BODIES)) {
    const keys = Object.keys(body);
    const extra = await fixture.router.handle(localRequest({
      secret: fixture.secret,
      path,
      body: { ...body, extra: "field" },
    }));
    assert.equal(extra.status, 400, `${path} accepted an unknown field`);
    assert.equal(errorCode(extra.body), "invalid_request", path);

    for (const missing of keys) {
      const partial = Object.fromEntries(Object.entries(body).filter(([key]) => key !== missing));
      const response = await fixture.router.handle(localRequest({
        secret: fixture.secret,
        path,
        body: partial,
      }));
      assert.equal(response.status, 400, `${path} accepted a body without ${missing}`);
    }
  }
});

test("the integration preview takes no request body", async () => {
  const fixture = await routerFixture();
  const path = `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`;
  assert.equal((await fixture.router.handle(localRequest({ secret: fixture.secret, path }))).status, 200);
  assert.equal(
    (await fixture.router.handle(localRequest({ secret: fixture.secret, path, body: {} }))).status,
    200,
  );
  const rejected = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path,
    body: { sessionId: SESSION_ID },
  }));
  assert.equal(rejected.status, 400);
});

test("a malformed path parameter never reaches a service", async () => {
  const fixture = await routerFixture();
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: "/v1/local/terminal-sessions/not-a-uuid/integration-preview",
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(fixture.repository.calls, []);
});

test("an unsupported integration strategy is refused at the edge", async () => {
  const fixture = await routerFixture();
  const path = `/v1/local/terminal-sessions/${SESSION_ID}/integrate`;
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path,
    body: { ...validBody(path), strategy: "rebase" },
  }));
  assert.equal(response.status, 400);
  assert.equal(errorCode(response.body), "invalid_request");
  assert.deepEqual(fixture.repository.calls.filter((call) => call[0] === "merge"), []);
});

test("only a confirmation proof bound to this preview can move the target branch", async () => {
  const fixture = await routerFixture();
  const previewPath = `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`;
  const confirmPath = `/v1/local/terminal-sessions/${SESSION_ID}/integrate`;
  const merges = (): string[][] => fixture.repository.calls.filter((call) => call[0] === "merge");

  const preview = async (): Promise<Record<string, string>> => {
    const response = await fixture.router.handle(localRequest({ secret: fixture.secret, path: previewPath }));
    assert.equal(response.status, 200);
    return response.body as Record<string, string>;
  };
  const confirm = async (
    shown: Record<string, string>,
    confirmation: string,
  ): Promise<{ status: number; body: Readonly<Record<string, unknown>> }> => fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: confirmPath,
    body: {
      integrationId: shown["integrationId"],
      sourceCommit: shown["sourceCommit"],
      expectedTargetHead: shown["targetHead"],
      diffDigest: shown["diffDigest"],
      gateDigest: shown["gateDigest"],
      strategy: "merge-no-ff",
      confirmation,
    },
  }));

  const first = await preview();
  // A proof the operator really made, but for a gate outcome they never saw.
  const forged = await confirm(first, integrationConfirmationProof(fixture.secret, {
    integrationId: String(first["integrationId"]),
    diffDigest: String(first["diffDigest"]),
    gateDigest: `sha256:${"9".repeat(64)}`,
  }));
  assert.equal(forged.status, 403);
  assert.equal(errorCode(forged.body), "forbidden");
  assert.deepEqual(merges(), []);

  // The preview was spent before the proof was judged, so even the correct proof
  // cannot revive it: a rejected confirmation costs a preview, never a merge.
  const revived = await confirm(first, integrationConfirmationProof(fixture.secret, {
    integrationId: String(first["integrationId"]),
    diffDigest: String(first["diffDigest"]),
    gateDigest: String(first["gateDigest"]),
  }));
  assert.equal(revived.status, 409);
  assert.equal(errorCode(revived.body), "duplicate_request");
  assert.deepEqual(merges(), []);

  const second = await preview();
  const accepted = await confirm(second, integrationConfirmationProof(fixture.secret, {
    integrationId: String(second["integrationId"]),
    diffDigest: String(second["diffDigest"]),
    gateDigest: String(second["gateDigest"]),
  }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body["mergeCommit"], MERGE_COMMIT);
  assert.equal(accepted.body["targetHeadBefore"], TARGET_HEAD);
  assert.deepEqual(merges(), [["merge", "--no-ff", "--no-edit", SOURCE_COMMIT]]);
});

test("every local operation is audited with its action and outcome", async () => {
  const fixture = await routerFixture();
  const requests: ReadonlyArray<{ path: string; body?: Record<string, unknown> }> = [
    { path: "/v1/local/pairing-challenges", body: validBody("/v1/local/pairing-challenges") },
    {
      path: `/v1/local/terminal-sessions/${SESSION_ID}/force-close`,
      body: validBody(`/v1/local/terminal-sessions/${SESSION_ID}/force-close`),
    },
    { path: `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview` },
    {
      path: `/v1/local/terminal-sessions/${SESSION_ID}/integrate`,
      body: validBody(`/v1/local/terminal-sessions/${SESSION_ID}/integrate`),
    },
    {
      path: `/v1/local/devices/${DEVICE_ID}/revoke`,
      body: validBody(`/v1/local/devices/${DEVICE_ID}/revoke`),
    },
  ];
  const statuses: number[] = [];
  for (const request of requests) {
    const response = await fixture.router.handle(localRequest({
      secret: fixture.secret,
      path: request.path,
      ...(request.body ? { body: request.body } : {}),
    }));
    statuses.push(response.status);
  }
  // Pairing, preview and revoke succeed; the force-close names a session this
  // fixture never started and the confirm names a preview nobody issued.
  assert.deepEqual(statuses, [201, 409, 200, 404, 200]);
  const events = fixture.auditEvents();
  assert.deepEqual(events.map((event) => event.action), [
    "local.pairing.challenge",
    "local.terminal.force_close",
    "local.integration.preview",
    "local.integration.confirm",
    "local.device.revoke",
  ]);
  assert.deepEqual(events.map((event) => event.outcome), [
    "allowed",
    "denied",
    "allowed",
    "denied",
    "allowed",
  ]);
  assert.equal(events[1]?.reasonCode, "session_not_live");
  assert.equal(events[3]?.reasonCode, "not_found");
  assert.equal(events[1]?.sessionId, SESSION_ID);
  assert.equal(events[4]?.deviceId, DEVICE_ID);
  for (const event of events) {
    assert.match(event.correlationId, /^[0-9a-f-]{36}$/);
    assert.equal(event.occurredAt, "2026-08-09T10:00:00.000Z");
  }
});

test("a local action whose audit record cannot be written fails closed", async () => {
  const failing: AuditPort = {
    async record() {
      throw new Error("audit sink is unavailable");
    },
  };
  const fixture = await routerFixture({ audit: failing });
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: "/v1/local/pairing-challenges",
    body: validBody("/v1/local/pairing-challenges"),
  }));
  assert.equal(response.status, 500);
  assert.equal(errorCode(response.body), "internal_error");
});

test("the one-time pairing code never reaches the audit record", async () => {
  const recorded: AuditEvent[] = [];
  const capturing: AuditPort = {
    async record(event) {
      recorded.push(event);
    },
  };
  const fixture = await routerFixture({ audit: capturing });
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: "/v1/local/pairing-challenges",
    body: validBody("/v1/local/pairing-challenges"),
  }));
  assert.equal(response.status, 201);
  const payload = JSON.parse(
    Buffer.from(String(response.body["qrPayload"]), "base64url").toString("utf8"),
  ) as { code: string; challengeId: string; origin: string; hostFingerprint: string; v: number };
  assert.equal(payload.v, 1);
  assert.equal(payload.challengeId, response.body["challengeId"]);
  assert.ok(payload.code.length >= 20);
  assert.equal(Object.keys(response.body).sort().join(","), "challengeId,expiresAt,hostFingerprint,qrPayload");

  const serialized = JSON.stringify(recorded);
  assert.ok(recorded.length > 0);
  assert.equal(serialized.includes(payload.code), false);
  assert.equal(serialized.includes(String(response.body["qrPayload"])), false);
});

test("a request id reused for another subject is a duplicate, not a second action", async () => {
  const fixture = await routerFixture();
  const requestId = randomUUID();
  const first = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: `/v1/local/devices/${DEVICE_ID}/revoke`,
    body: { requestId, reason: "Lost device" },
  }));
  assert.equal(first.status, 200);
  const other = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: "/v1/local/devices/123e4567-e89b-42d3-a456-426614174099/revoke",
    body: { requestId, reason: "Lost device" },
  }));
  assert.equal(other.status, 409);
  assert.equal(errorCode(other.body), "duplicate_request");
  const replay = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: `/v1/local/devices/${DEVICE_ID}/revoke`,
    body: { requestId, reason: "Lost device" },
  }));
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
});

test("the gate route runs every gate and records what they said", async () => {
  // Real directories, because the service canonicalises the configured root and
  // the recorded worktree through `realpath` before a gate may run in it.
  const sessionRoot = await realpath(await mkdtemp(join(tmpdir(), "ag-local-gates-")));
  const worktreeRoot = join(sessionRoot, SESSION_ID);
  await mkdir(worktreeRoot, { recursive: true });
  try {
    const fixture = await routerFixture({
      gateSessionRoot: sessionRoot,
      // `main` is the branch the fixture's scripted Git reports, and a clean
      // tree on a matching branch is what the service demands before it runs.
      worktrees: { [SESSION_ID]: worktreeRecord({ worktreeRoot, branch: "main", state: "ready" }) },
      sessions: { [SESSION_ID]: sessionRecord("ended") },
    });
    const response = await fixture.router.handle(localRequest({
      secret: fixture.secret,
      path: `/v1/local/terminal-sessions/${SESSION_ID}/gates`,
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(
      Object.keys(response.body).sort(),
      ["allPassed", "commit", "gates", "recordedAt", "sessionId"],
    );
    assert.equal(response.body["sessionId"], SESSION_ID);
    assert.equal(response.body["commit"], TARGET_HEAD);
    const gates = response.body["gates"] as ReadonlyArray<{ name: string; passed: boolean }>;
    assert.deepEqual(gates.map((gate) => gate.name), [...REQUIRED_GATE_NAMES]);
    // The fixture's runner refuses to start, which is a host fault rather than a
    // verdict: the run still completes and names every gate it could not measure.
    assert.equal(gates.every((gate) => gate.passed === false), true);
    assert.equal(response.body["allPassed"], false);
    assert.equal(fixture.gateRecords.length, 1, "one complete record for the run");
    assert.equal(fixture.registry.current().worktrees[SESSION_ID]?.state, "review_ready");

    const events = fixture.auditEvents();
    assert.deepEqual(events.map((event) => event.action), ["local.gates.run"]);
    assert.equal(events[0]?.outcome, "allowed");
    assert.equal(events[0]?.sessionId, SESSION_ID);
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
  }
});

test("the gate route refuses a worktree that is not in a runnable disposition", async () => {
  const fixture = await routerFixture({
    worktrees: { [SESSION_ID]: worktreeRecord({ state: "integrated" }) },
    sessions: { [SESSION_ID]: sessionRecord("ended") },
  });
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: `/v1/local/terminal-sessions/${SESSION_ID}/gates`,
  }));
  assert.equal(response.status, 409);
  assert.equal(errorCode(response.body), "conflict");
  // Nothing was measured and nothing was recorded; the local channel is always
  // the owner, so there is no forbidden path to test here.
  assert.equal(fixture.gateRecords.length, 0);
  assert.equal(fixture.auditEvents()[0]?.reasonCode, "conflict");
});

test("the gate route takes no request body", async () => {
  const fixture = await routerFixture();
  const rejected = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: `/v1/local/terminal-sessions/${SESSION_ID}/gates`,
    body: { sessionId: SESSION_ID },
  }));
  assert.equal(rejected.status, 400);
  assert.equal(errorCode(rejected.body), "invalid_request");
  assert.equal(fixture.gateRecords.length, 0);
});

test("responses carry the no-store, typed and sniff-proof headers", async () => {
  const fixture = await routerFixture();
  for (const route of everyLocalRoute()) {
    const response = await fixture.router.handle(localRequest({
      secret: fixture.secret,
      path: route.path,
      ...(route.body ? { body: route.body } : {}),
    }));
    assert.equal(response.headers["cache-control"], "no-store", route.path);
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8", route.path);
    assert.equal(response.headers["x-content-type-options"], "nosniff", route.path);
  }
});
