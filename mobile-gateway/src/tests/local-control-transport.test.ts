import assert from "node:assert/strict";
import test from "node:test";
import {
  integrationConfirmationProof,
  LocalProofVerifier,
  verifyIntegrationConfirmation,
} from "../application/local-control-auth.js";
import { LocalControlError } from "../application/local-control-errors.js";
import { LOCAL_CONTROL_ROUTE_SURFACE } from "../interfaces/http/local-control-router.js";
import {
  attestation,
  everyLocalRoute,
  localProofHeader,
  localRequest,
  NOW,
  routerFixture,
  SESSION_ID,
  testSecret,
} from "./local-control-doubles.js";

/**
 * The transport half of `local-control-contract.md`: who may reach the local
 * surface at all.
 *
 * Every case here asserts a refusal AND that nothing happened — a router that
 * answered 403 after running the operation would satisfy a status assertion and
 * still have merged a branch.
 */

function errorCode(body: Readonly<Record<string, unknown>>): string {
  return (body["error"] as { code?: string } | undefined)?.code ?? "";
}

test("an unverified peer is refused on every local route", async () => {
  const fixture = await routerFixture();
  for (const route of everyLocalRoute()) {
    const response = await fixture.router.handle(localRequest({
      secret: fixture.secret,
      path: route.path,
      ...(route.body ? { body: route.body } : {}),
      peer: attestation({ assurance: "unverified", endpointOwnerVerified: false, secretFileGuarded: false }),
    }));
    assert.equal(response.status, 403, route.path);
    assert.equal(errorCode(response.body), "forbidden", route.path);
  }
  assert.deepEqual(fixture.repository.calls, []);
  // Refused at the door, but not silently: a rejected peer aimed at a real local
  // operation is exactly the attempt an operator needs to be able to see.
  const events = fixture.auditEvents();
  assert.deepEqual(events.map((event) => event.action), [
    "local.pairing.challenge",
    "local.terminal.force_close",
    "local.gates.run",
    "local.integration.preview",
    "local.integration.confirm",
    "local.device.revoke",
  ]);
  assert.deepEqual(new Set(events.map((event) => event.outcome)), new Set(["denied"]));
  assert.deepEqual(new Set(events.map((event) => event.reasonCode)), new Set(["forbidden"]));
});

test("an invalid proof is recorded against the operation it was aimed at", async () => {
  const fixture = await routerFixture();
  const path = `/v1/local/terminal-sessions/${SESSION_ID}/force-close`;
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path,
    body: {
      requestId: "123e4567-e89b-42d3-a456-426614174020",
      reason: "Owner requested local recovery",
      expectedSessionRevision: 3,
    },
    proof: null,
  }));
  assert.equal(response.status, 401);
  const events = fixture.auditEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, "local.terminal.force_close");
  assert.equal(events[0]?.outcome, "denied");
  assert.equal(events[0]?.reasonCode, "unauthenticated");
  assert.equal(events[0]?.sessionId, SESSION_ID);
  // The path parameter is only recorded once it is a UUID; a probe cannot write
  // arbitrary text into the audit trail through it.
  assert.equal(events[0]?.requestId, undefined);
  assert.deepEqual(fixture.repository.calls, []);
});

test("a malformed path parameter never becomes part of the audit record", async () => {
  const fixture = await routerFixture();
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: "/v1/local/terminal-sessions/not-a-uuid/force-close",
    body: { requestId: "123e4567-e89b-42d3-a456-426614174020", reason: "x", expectedSessionRevision: 1 },
    proof: null,
  }));
  assert.equal(response.status, 401);
  const events = fixture.auditEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.sessionId, undefined);
  assert.equal(events[0]?.action, "local.terminal.force_close");
});

test("an endpoint the host could not prove ownership of is refused", async () => {
  const fixture = await routerFixture();
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`,
    peer: attestation({ endpointOwnerVerified: false }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(fixture.repository.calls, []);
});

test("a guarded secret file is required even when the endpoint is owned", async () => {
  const fixture = await routerFixture();
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`,
    peer: attestation({ secretFileGuarded: false }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(fixture.repository.calls, []);
});

test("capability-only assurance is refused unless the composition allows it", async () => {
  const path = `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`;
  const peer = attestation({ transport: "named-pipe", assurance: "capability-only" });

  const strict = await routerFixture();
  const refused = await strict.router.handle(localRequest({ secret: strict.secret, path, peer }));
  assert.equal(refused.status, 403);
  assert.deepEqual(strict.repository.calls, []);

  const permissive = await routerFixture({ allowCapabilityOnlyAssurance: true });
  const allowed = await permissive.router.handle(localRequest({ secret: permissive.secret, path, peer }));
  assert.equal(allowed.status, 200);
  assert.ok(permissive.repository.calls.length > 0);
});

test("the loopback fallback refuses a Host header that does not address it", async () => {
  const path = `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`;
  const peer = attestation({
    transport: "loopback-http",
    assurance: "capability-only",
    peerAddressIsLoopback: true,
  });
  const fixture = await routerFixture({ allowCapabilityOnlyAssurance: true, loopbackPort: 8765 });
  for (const host of ["evil.example", "127.0.0.1:9999", "127.0.0.1", undefined]) {
    const response = await fixture.router.handle(localRequest({
      secret: fixture.secret,
      path,
      peer,
      headers: { host },
    }));
    assert.equal(response.status, 403, String(host));
  }
  assert.deepEqual(fixture.repository.calls, []);

  const accepted = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path,
    peer,
    headers: { host: "127.0.0.1:8765" },
  }));
  assert.equal(accepted.status, 200);
});

test("a loopback peer whose address is not loopback is refused", async () => {
  const fixture = await routerFixture({ allowCapabilityOnlyAssurance: true, loopbackPort: 8765 });
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`,
    peer: attestation({ transport: "loopback-http", assurance: "capability-only" }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(fixture.repository.calls, []);
});

test("a request without a local proof is unauthenticated", async () => {
  const fixture = await routerFixture();
  for (const route of everyLocalRoute()) {
    const response = await fixture.router.handle(localRequest({
      secret: fixture.secret,
      path: route.path,
      ...(route.body ? { body: route.body } : {}),
      proof: null,
    }));
    assert.equal(response.status, 401, route.path);
    assert.equal(errorCode(response.body), "unauthenticated", route.path);
  }
  assert.deepEqual(fixture.repository.calls, []);
});

test("a proof signed with another secret is unauthenticated", async () => {
  const fixture = await routerFixture();
  const path = `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`;
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path,
    proof: localProofHeader({
      secret: new Uint8Array(32),
      method: "POST",
      path,
      now: NOW,
    }),
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(fixture.repository.calls, []);
});

test("a proof bound to another path cannot be replayed onto this one", async () => {
  const fixture = await routerFixture();
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`,
    proof: localProofHeader({
      secret: fixture.secret,
      method: "POST",
      path: "/v1/local/pairing-challenges",
      now: NOW,
    }),
  }));
  assert.equal(response.status, 401);
});

test("a replayed nonce is refused after the first use", async () => {
  const fixture = await routerFixture();
  const path = `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`;
  const nonce = "9".repeat(32);
  const first = await fixture.router.handle(localRequest({ secret: fixture.secret, path, nonce }));
  assert.equal(first.status, 200);
  const replay = await fixture.router.handle(localRequest({ secret: fixture.secret, path, nonce }));
  assert.equal(replay.status, 401);
  assert.equal(errorCode(replay.body), "unauthenticated");
});

test("a proof outside the accepted clock skew is refused", async () => {
  const fixture = await routerFixture();
  const path = `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview`;
  for (const drift of [-10 * 60_000, 10 * 60_000]) {
    const response = await fixture.router.handle(localRequest({
      secret: fixture.secret,
      path,
      now: new Date(NOW.getTime() + drift),
    }));
    assert.equal(response.status, 401, String(drift));
  }
  assert.deepEqual(fixture.repository.calls, []);
});

test("a body over the 32 KiB bound is refused before it is parsed", async () => {
  const fixture = await routerFixture();
  const body = new Uint8Array(32 * 1024 + 1).fill(0x20);
  const response = await fixture.router.handle(localRequest({
    secret: fixture.secret,
    path: `/v1/local/devices/${"123e4567-e89b-42d3-a456-426614174011"}/revoke`,
    body,
  }));
  assert.equal(response.status, 400);
  assert.equal(errorCode(response.body), "invalid_request");
});

test("an unknown path or method is a 404 that reaches no service", async () => {
  const fixture = await routerFixture();
  const unknown: ReadonlyArray<{ method: string; path: string }> = [
    { method: "POST", path: "/v1/local/unknown" },
    { method: "GET", path: `/v1/local/terminal-sessions/${SESSION_ID}/integration-preview` },
    { method: "DELETE", path: `/v1/local/devices/${"123e4567-e89b-42d3-a456-426614174011"}/revoke` },
    { method: "POST", path: `/v1/local/terminal-sessions/${SESSION_ID}/integrate?force=1` },
    { method: "POST", path: "/v1/projects" },
  ];
  for (const target of unknown) {
    const response = await fixture.router.handle(localRequest({
      secret: fixture.secret,
      method: target.method,
      path: target.path,
    }));
    assert.equal(response.status, 404, `${target.method} ${target.path}`);
    assert.equal(errorCode(response.body), "not_found", target.path);
  }
  assert.deepEqual(fixture.repository.calls, []);
  assert.deepEqual(fixture.auditEvents(), []);
});

test("a full nonce cache refuses instead of forgetting a remembered nonce", () => {
  // Making room by dropping a remembered nonce is how a replay window reopens,
  // so exhaustion has to be a refusal even though refusing costs availability.
  const secret = testSecret();
  const path = "/v1/local/pairing-challenges";
  const verifier = new LocalProofVerifier({ maxNonces: 2 });
  const verify = (nonce: string): void => verifier.verify({
    secret,
    method: "POST",
    path,
    body: undefined,
    header: localProofHeader({ secret, method: "POST", path, now: NOW, nonce }),
    now: NOW,
  });

  verify("1".repeat(32));
  verify("2".repeat(32));
  assert.throws(
    () => verify("3".repeat(32)),
    (error: unknown) => error instanceof LocalControlError && error.code === "rate_limited",
  );
  assert.throws(
    () => verify("1".repeat(32)),
    (error: unknown) => error instanceof LocalControlError && error.code === "unauthenticated",
  );
});

test("an integration confirmation proof is bound to its preview and to both digests", () => {
  const secret = testSecret();
  const binding = {
    integrationId: "123e4567-e89b-42d3-a456-426614174021",
    diffDigest: `sha256:${"1".repeat(64)}`,
    gateDigest: `sha256:${"2".repeat(64)}`,
  };
  const proof = integrationConfirmationProof(secret, binding);
  assert.equal(verifyIntegrationConfirmation(secret, binding, proof), true);

  for (const drift of [
    { integrationId: "123e4567-e89b-42d3-a456-426614174099" },
    { diffDigest: `sha256:${"9".repeat(64)}` },
    { gateDigest: `sha256:${"8".repeat(64)}` },
  ]) {
    assert.equal(
      verifyIntegrationConfirmation(secret, { ...binding, ...drift }, proof),
      false,
      JSON.stringify(drift),
    );
  }
  assert.equal(verifyIntegrationConfirmation(new Uint8Array(32), binding, proof), false);
  for (const forged of ["", proof.slice(0, -1), `${proof}=`]) {
    assert.equal(verifyIntegrationConfirmation(secret, binding, forged), false, forged);
  }
});

test("the declared local surface is exactly the routes the contract lists", () => {
  assert.deepEqual([...LOCAL_CONTROL_ROUTE_SURFACE].map((route) => `${route.method} ${route.template}`), [
    "POST /v1/local/pairing-challenges",
    "POST /v1/local/terminal-sessions/{sessionId}/force-close",
    "POST /v1/local/terminal-sessions/{sessionId}/gates",
    "POST /v1/local/terminal-sessions/{sessionId}/integration-preview",
    "POST /v1/local/terminal-sessions/{sessionId}/integrate",
    "POST /v1/local/devices/{deviceId}/revoke",
  ]);
});
