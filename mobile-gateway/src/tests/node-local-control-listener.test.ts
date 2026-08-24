import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  LocalControlEndpoint,
  LocalControlHandler,
  LocalControlListenerHandle,
  LocalControlRequest,
} from "../application/ports/local-control-listener-port.js";
import type {
  LocalPeerAttestation,
  LocalPeerContext,
  LocalPeerIdentityPort,
} from "../application/ports/local-peer-identity-port.js";
import { MAX_LOCAL_BODY_BYTES } from "../interfaces/http/local-control-router.js";
import { createNodeLocalControlListener } from "../interfaces/http/node-local-control-listener.js";

/**
 * The Node transport of the local control channel, exercised over a REAL
 * endpoint — a Unix-domain socket where the platform has them, a named pipe on
 * Windows.
 *
 * A double for the socket would prove nothing here: everything this adapter is
 * responsible for happens at the boundary between the kernel and the router.
 * Each test therefore asks one of the four questions the transport alone can
 * answer: does the request arrive with the attestation the host produced, does a
 * host that could NOT attest still hand the request on (as `unverified`, for the
 * policy layer to refuse) rather than throw it away, is the body bounded before
 * it is buffered, and does closing really give the endpoint back.
 */

const OWNER_ATTESTATION = Object.freeze({
  assurance: "os-acl-verified" as const,
  endpointOwnerVerified: true,
  secretFileGuarded: true,
});

type CallResult = Readonly<{
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: string;
  /** Set when the connection failed instead of answering. */
  error?: string;
}>;

type Listening = Readonly<{
  endpoint: LocalControlEndpoint;
  /** Path a client connects to; the same value Node's `socketPath` takes. */
  socketPath: string;
  handle: LocalControlListenerHandle;
  seen: LocalControlRequest[];
  attested: LocalControlEndpoint[];
}>;

function endpointPath(endpoint: LocalControlEndpoint): string {
  if (endpoint.kind === "loopback-http") {
    throw new Error("this fixture serves pipe and socket endpoints only");
  }
  return endpoint.path;
}

/**
 * A pipe on Windows, a socket file elsewhere.
 *
 * Both are what `resolveLocalControlEndpoint` produces on their platform, so the
 * branch that does not apply here is not skipped coverage — it is unreachable on
 * this host, and the other branch is covered on the host where it applies.
 */
async function localEndpoint(t: TestContext): Promise<LocalControlEndpoint> {
  const unique = randomBytes(8).toString("hex");
  if (process.platform === "win32") {
    return { kind: "named-pipe", path: String.raw`\\.\pipe\ag-local-control-test-${unique}` };
  }
  const directory = await mkdtemp(join(tmpdir(), "ag-local-listener-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { kind: "unix-socket", path: join(directory, "local-control.sock") };
}

function peerIdentity(
  attest: (endpoint: LocalControlEndpoint, context?: LocalPeerContext) => Promise<LocalPeerAttestation>,
): LocalPeerIdentityPort {
  return { attest };
}

async function listening(t: TestContext, options: {
  handler?: LocalControlHandler;
  attest?: (endpoint: LocalControlEndpoint, context?: LocalPeerContext) => Promise<LocalPeerAttestation>;
} = {}): Promise<Listening> {
  const endpoint = await localEndpoint(t);
  const seen: LocalControlRequest[] = [];
  const attested: LocalControlEndpoint[] = [];
  const attest = options.attest ?? (async (target: LocalControlEndpoint) => Object.freeze({
    transport: target.kind,
    ...OWNER_ATTESTATION,
    observedAt: new Date().toISOString(),
  }));
  const handler: LocalControlHandler = options.handler ?? (async (request) => {
    seen.push(request);
    return {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
      body: { ok: true },
    };
  });
  const listener = createNodeLocalControlListener(peerIdentity(async (target, context) => {
    attested.push(target);
    return attest(target, context);
  }));
  const handle = await listener.start(endpoint, handler);
  t.after(() => handle.close());
  return { endpoint, socketPath: endpointPath(endpoint), handle, seen, attested };
}

/** One request over the local endpoint; a refused connection is a result, not a throw. */
function call(socketPath: string, options: {
  path: string;
  method?: string;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}): Promise<CallResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: CallResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = httpRequest({
      socketPath,
      path: options.path,
      method: options.method ?? "POST",
      headers: options.headers ?? {},
      // One connection per call, torn down with the call: a pooled keep-alive
      // socket would outlive the test and keep the listener from closing.
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => settle({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", (error: Error) => settle({ error: error.message }));
    });
    request.on("error", (error: Error) => settle({ error: error.message }));
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function errorCode(payload: string | undefined): string {
  const parsed = JSON.parse(payload ?? "{}") as { error?: { code?: string } };
  return parsed.error?.code ?? "";
}

test("a request arrives at the router with the attestation the host produced", async (t) => {
  const server = await listening(t);
  const body = JSON.stringify({ deviceName: "Owner phone", scopes: ["ag:read"] });
  const response = await call(server.socketPath, {
    path: "/v1/local/pairing-challenges",
    body,
    headers: { "content-type": "application/json", "x-ag-local-proof": "v1:nonce:when:mac" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body ?? ""), { ok: true });
  assert.equal(response.headers?.["cache-control"], "no-store");
  assert.equal(response.headers?.["content-type"], "application/json; charset=utf-8");
  assert.equal(response.headers?.["x-content-type-options"], "nosniff");
  // The transport declares the length itself; a chunked local answer would make
  // the framing depend on the router's serialisation.
  assert.equal(response.headers?.["content-length"], String(Buffer.byteLength('{"ok":true}', "utf8")));

  assert.equal(server.seen.length, 1);
  const received = server.seen[0];
  assert.ok(received);
  assert.equal(received.method, "POST");
  assert.equal(received.path, "/v1/local/pairing-challenges");
  assert.equal(received.headers["x-ag-local-proof"], "v1:nonce:when:mac");
  assert.equal(Buffer.from(received.body ?? new Uint8Array()).toString("utf8"), body);
  // The peer is carried WITH the request: the router never has to ask a second
  // question about who is calling.
  assert.equal(received.peer.transport, server.endpoint.kind);
  assert.equal(received.peer.assurance, "os-acl-verified");
  assert.equal(received.peer.endpointOwnerVerified, true);
  assert.equal(received.peer.secretFileGuarded, true);
  assert.deepEqual(server.attested, [server.endpoint]);
});

test("a host that cannot attest the peer reports it as unverified instead of failing", async (t) => {
  // Losing the attestation must not become a 500: `unverified` is a value the
  // policy layer refuses deliberately, whereas a swallowed transport error would
  // be indistinguishable from the gateway being down.
  const server = await listening(t, {
    attest: async () => {
      throw new Error("the secret file could not be examined");
    },
  });
  const response = await call(server.socketPath, { path: "/v1/local/pairing-challenges" });

  assert.equal(response.status, 200);
  assert.equal(server.seen.length, 1);
  const peer = server.seen[0]?.peer;
  assert.ok(peer);
  assert.equal(peer.assurance, "unverified");
  assert.equal(peer.endpointOwnerVerified, false);
  assert.equal(peer.secretFileGuarded, false);
  assert.equal(peer.transport, server.endpoint.kind);
  assert.equal(new Date(peer.observedAt).toISOString(), peer.observedAt);
});

test("a body over the transport bound is refused and the listener survives it", async (t) => {
  const server = await listening(t);
  const oversized = await call(server.socketPath, {
    path: "/v1/local/pairing-challenges",
    body: new Uint8Array(MAX_LOCAL_BODY_BYTES + 1).fill(0x20),
    headers: { "content-type": "application/json" },
  });

  // The bound is enforced while the body is still arriving, and the caller is
  // told why: a refusal the peer cannot read is indistinguishable from a gateway
  // that died mid-request. What must never happen is the router seeing it.
  assert.equal(oversized.status, 400, oversized.error ?? "");
  assert.equal(errorCode(oversized.body), "invalid_request");
  assert.equal(oversized.headers?.connection, "close");
  assert.equal(server.seen.length, 0, "an oversized body must never reach the router");

  // Exactly at the bound is still a request, and the listener is still serving:
  // refusing one caller must not take the local channel down with it.
  const atBound = await call(server.socketPath, {
    path: "/v1/local/pairing-challenges",
    body: new Uint8Array(MAX_LOCAL_BODY_BYTES).fill(0x20),
    headers: { "content-type": "application/json" },
  });
  assert.equal(atBound.status, 200);
  assert.equal(server.seen.length, 1);
  assert.equal(server.seen[0]?.body?.byteLength, MAX_LOCAL_BODY_BYTES);
});

test("a handler that fails answers a closed internal error, not the failure", async (t) => {
  const server = await listening(t, {
    handler: async () => {
      throw new Error("registry file is locked by another process");
    },
  });
  const response = await call(server.socketPath, { path: "/v1/local/pairing-challenges" });
  assert.equal(response.status, 500);
  assert.equal(errorCode(response.body), "internal_error");
  assert.equal(String(response.body).includes("registry file"), false);
});

test("closing the listener releases the endpoint", async (t) => {
  const server = await listening(t);
  assert.equal((await call(server.socketPath, { path: "/v1/local/pairing-challenges" })).status, 200);

  await server.handle.close();
  const afterClose = await call(server.socketPath, { path: "/v1/local/pairing-challenges" });
  assert.equal(afterClose.status, undefined, "a closed endpoint must not answer");
  assert.ok(afterClose.error);
  if (server.endpoint.kind === "unix-socket") {
    // Node unlinks the socket file it created; leaving it behind would make the
    // next start fail with EADDRINUSE against a listener that no longer exists.
    assert.equal(existsSync(server.socketPath), false);
  }
  // Closing an already closed listener still resolves, so composition teardown
  // never has to know whether it ran twice.
  await server.handle.close();
});

test("a second listener cannot take over an endpoint that is already bound", async (t) => {
  const server = await listening(t);
  const rival = createNodeLocalControlListener(peerIdentity(async () => Object.freeze({
    transport: server.endpoint.kind,
    ...OWNER_ATTESTATION,
    observedAt: new Date().toISOString(),
  })));
  await assert.rejects(
    rival.start(server.endpoint, async () => {
      throw new Error("the rival listener must never serve a request");
    }),
    (error: unknown) => error instanceof Error && "code" in error,
  );
  // The established listener is untouched by the failed takeover.
  assert.equal((await call(server.socketPath, { path: "/v1/local/pairing-challenges" })).status, 200);
});
