import assert from "node:assert/strict";
import test from "node:test";
import {
  GatewayClientError,
  GatewayHttpClient,
  type MobileHttpTransportPort,
} from "../adapters/network/gateway-http-client.js";
import type {
  CredentialPort,
  DeviceCredential,
  DeviceProofPort,
} from "../model/ports.js";

/**
 * NUKRYPIMAS (forma, ne elgesys): `headers` yra `Readonly<Record<string, string>>`, o
 * `noPropertyAccessFromIndexSignature` draudžia `headers.Authorization`, tad antraštės
 * skaitomos laužtiniais. Tikrinamų faktų aibė nepakito.
 */

const baseUrl = "https://pc.private.test/v1";
const projectId = "123e4567-e89b-42d3-a456-426614174030";
const sessionId = "123e4567-e89b-42d3-a456-426614174031";
const deviceId = "123e4567-e89b-42d3-a456-426614174032";
const leaseId = "123e4567-e89b-42d3-a456-426614174033";
const requestId = "123e4567-e89b-42d3-a456-426614174034";
const inputId = "123e4567-e89b-42d3-a456-426614174035";
const idempotencyId = "123e4567-e89b-42d3-a456-426614174036";

const initialCredential: DeviceCredential = Object.freeze({
  deviceId,
  generation: 1,
  accessToken: "oldpayload.oldsignature",
  accessExpiresAt: "2026-07-26T12:15:00.000Z",
  refreshToken: "old-refresh-token-value-0001",
  refreshExpiresAt: "2026-08-25T12:00:00.000Z",
});

function sessionBody(): Record<string, unknown> {
  return {
    sessionId,
    projectId,
    provider: "codex",
    workspaceMode: "isolated-worktree",
    branch: `mobile/${sessionId}`,
    state: "live",
    lease: {
      leaseId,
      ownerDeviceId: deviceId,
      generation: 1,
      expiresAt: "2026-07-26T12:05:00.000Z",
    },
    nextSequence: 1,
  };
}

function fakeCredentials(): {
  port: CredentialPort;
  get current(): DeviceCredential | null;
  stores: DeviceCredential[];
  get clearCount(): number;
} {
  let current: DeviceCredential | null = initialCredential;
  let clearCount = 0;
  const stores: DeviceCredential[] = [];
  return {
    port: {
      async loadDeviceCredential() {
        return current;
      },
      async storeDeviceCredential(value) {
        current = value;
        stores.push(value);
      },
      async clearDeviceCredential() {
        current = null;
        clearCount += 1;
      },
    },
    get current() {
      return current;
    },
    stores,
    get clearCount() {
      return clearCount;
    },
  };
}

function fakeProof(): { port: DeviceProofPort; calls: DeviceCredential[] } {
  const calls: DeviceCredential[] = [];
  return {
    port: {
      async createRefreshProof(input) {
        calls.push({
          ...initialCredential,
          deviceId: input.deviceId,
          generation: input.generation,
          refreshToken: input.refreshToken,
        });
        return {
          nonce: "refresh-nonce-value-0001",
          // 86 base64url characters: the exact shape of an unpadded 64-byte
          // Ed25519 signature, which is the only proof the gateway accepts.
          proof: `signed-device-proof-${"0".repeat(66)}`,
        };
      },
    },
    calls,
  };
}

function ids(values: string[]): { nextUuid(): string } {
  let index = 0;
  return {
    nextUuid() {
      const value = values[index];
      index += 1;
      if (!value) throw new Error("Unexpected UUID request");
      return value;
    },
  };
}

test("HTTP adapter creates a fixed isolated session with authorization and idempotency", async () => {
  const credential = fakeCredentials();
  const proof = fakeProof();
  const requests: Parameters<MobileHttpTransportPort["request"]>[0][] = [];
  const transport: MobileHttpTransportPort = {
    async request(input) {
      requests.push(input);
      return { status: 201, body: JSON.stringify(sessionBody()) };
    },
  };
  const client = new GatewayHttpClient(
    baseUrl,
    transport,
    credential.port,
    proof.port,
    ids([idempotencyId]),
  );
  const session = await client.createTerminalSession({
    projectId,
    provider: "codex",
    workspaceMode: "isolated-worktree",
    cols: 100,
    rows: 30,
  });

  assert.equal(session.sessionId, sessionId);
  assert.equal(requests[0]?.url, `${baseUrl}/projects/${projectId}/terminal-sessions`);
  assert.equal(requests[0]?.headers["Authorization"], `Bearer ${initialCredential.accessToken}`);
  assert.equal(requests[0]?.headers["Idempotency-Key"], `mobile-${idempotencyId}`);
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    provider: "codex",
    workspaceMode: "isolated-worktree",
    cols: 100,
    rows: 30,
  });
  assert.equal(proof.calls.length, 0);
});

test("HTTP adapter writes one lease-fenced input identity", async () => {
  const credential = fakeCredentials();
  const proof = fakeProof();
  const requests: Parameters<MobileHttpTransportPort["request"]>[0][] = [];
  const transport: MobileHttpTransportPort = {
    async request(input) {
      requests.push(input);
      return {
        status: 202,
        body: JSON.stringify({ inputId, status: "accepted" }),
      };
    },
  };
  const client = new GatewayHttpClient(
    baseUrl,
    transport,
    credential.port,
    proof.port,
    ids([inputId, requestId, idempotencyId]),
  );
  const result = await client.writeTerminalInput({
    projectId,
    sessionId,
    lease: {
      leaseId,
      ownerDeviceId: deviceId,
      generation: 1,
      expiresAt: "2026-07-26T12:05:00.000Z",
    },
    text: "run tests",
    source: "voice",
  });

  assert.deepEqual(result, { inputId, status: "accepted" });
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    requestId,
    leaseId,
    leaseGeneration: 1,
    inputId,
    source: "voice",
    text: "run tests",
  });
  assert.equal(requests[0]?.headers["Idempotency-Key"], `mobile-${idempotencyId}`);
});

test("401 rotates credentials once and retries the identical mutation identity", async () => {
  const credential = fakeCredentials();
  const proof = fakeProof();
  const requests: Parameters<MobileHttpTransportPort["request"]>[0][] = [];
  let call = 0;
  const transport: MobileHttpTransportPort = {
    async request(input) {
      requests.push(input);
      call += 1;
      if (call === 1) {
        return { status: 401, body: JSON.stringify({ error: { recoverable: true } }) };
      }
      if (call === 2) {
        return {
          status: 200,
          body: JSON.stringify({
            accessToken: "newpayload.newsignature",
            accessExpiresAt: "2026-07-26T12:30:00.000Z",
            refreshToken: "new-refresh-token-value-0002",
            refreshExpiresAt: "2026-08-25T12:15:00.000Z",
          }),
        };
      }
      return { status: 201, body: JSON.stringify(sessionBody()) };
    },
  };
  const client = new GatewayHttpClient(
    baseUrl,
    transport,
    credential.port,
    proof.port,
    ids([idempotencyId]),
  );
  await client.createTerminalSession({
    projectId,
    provider: "codex",
    workspaceMode: "isolated-worktree",
    cols: 100,
    rows: 30,
  });

  assert.equal(requests.length, 3);
  assert.equal(requests[1]?.url, `${baseUrl}/auth/refresh`);
  assert.equal(requests[1]?.headers["Authorization"], undefined);
  assert.equal(requests[2]?.headers["Authorization"], "Bearer newpayload.newsignature");
  assert.equal(requests[0]?.body, requests[2]?.body);
  assert.equal(
    requests[0]?.headers["Idempotency-Key"],
    requests[2]?.headers["Idempotency-Key"],
  );
  assert.equal(proof.calls.length, 1);
  assert.equal(credential.stores.length, 1);
  assert.equal(credential.current?.refreshToken, "new-refresh-token-value-0002");
});

test("403 does not rotate credentials and malformed success fails closed", async () => {
  const credential = fakeCredentials();
  const proof = fakeProof();
  let forbidden = true;
  const transport: MobileHttpTransportPort = {
    async request() {
      if (forbidden) {
        return { status: 403, body: JSON.stringify({ error: { recoverable: false } }) };
      }
      return { status: 201, body: JSON.stringify({ sessionId }) };
    },
  };
  const client = new GatewayHttpClient(
    baseUrl,
    transport,
    credential.port,
    proof.port,
    ids([idempotencyId, requestId]),
  );
  const input = {
    projectId,
    provider: "codex" as const,
    workspaceMode: "isolated-worktree" as const,
    cols: 100,
    rows: 30,
  };
  await assert.rejects(
    client.createTerminalSession(input),
    (error: unknown) => error instanceof GatewayClientError &&
      error.code === "authentication_failed",
  );
  assert.equal(proof.calls.length, 0);

  forbidden = false;
  await assert.rejects(
    client.createTerminalSession(input),
    (error: unknown) => error instanceof GatewayClientError &&
      error.code === "invalid_response",
  );
});

test("tampered secure-storage tokens are rejected before an HTTP header is built", async () => {
  let requests = 0;
  const transport: MobileHttpTransportPort = {
    async request() {
      requests += 1;
      return { status: 500, body: "{}" };
    },
  };
  const credentials: CredentialPort = {
    async loadDeviceCredential() {
      return {
        ...initialCredential,
        accessToken: "payload.signature\r\nX-Injected: true",
      };
    },
    async storeDeviceCredential() {},
    async clearDeviceCredential() {},
  };
  const client = new GatewayHttpClient(
    baseUrl,
    transport,
    credentials,
    fakeProof().port,
    ids([idempotencyId]),
  );
  await assert.rejects(
    client.createTerminalSession({
      projectId,
      provider: "codex",
      workspaceMode: "isolated-worktree",
      cols: 100,
      rows: 30,
    }),
    (error: unknown) => error instanceof GatewayClientError &&
      error.code === "authentication_failed",
  );
  assert.equal(requests, 0);
});
