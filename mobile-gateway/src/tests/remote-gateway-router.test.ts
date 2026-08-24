import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceAuthService } from "../application/device-auth-service.js";
import type { AgLoopUiReadPort } from "../application/ports/ag-loop-ui-read-port.js";
import { agLoopUiReadDouble } from "./ag-loop-ui-read-double.js";
import type { ProjectMembershipPort } from "../application/ports/project-membership-port.js";
import { ProjectReadService } from "../application/project-read-service.js";
import { ProjectRegistry } from "../application/project-registry.js";
import { AtomicJsonDeviceAuthStateStore } from "../infrastructure/atomic-json-device-auth-state-store.js";
import { InMemoryAuditLog } from "../infrastructure/in-memory-audit-log.js";
import {
  MAX_HTTP_BODY_BYTES,
  RemoteGatewayRouter,
} from "../interfaces/http/remote-gateway-router.js";
import { assertEnvelopeMatchesTables } from "./envelope-assertions.js";
import { pairTestDevice } from "./paired-device.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 888 eilutės).
 *
 * Čia lieka AUTENTIKACIJA ir SKAITYMAI: poravimas, token'ų rotacija, deny-by-default ir AG Loop
 * UI projektų skaitymai. Terminalo maršrutai — `remote-gateway-terminal-routes.test.ts`, lease
 * pratęsimas — `remote-gateway-lease-routes.test.ts`, TLS fabrikas — `tls-gateway-transport.test.ts`.
 *
 * Etalono lokalus `pairDevice` pakeistas jau esamu `paired-device.ts#pairTestDevice`: tai ta
 * pati operacija, o antra kopija skirtųsi tik nonce'u — ir būtų dar vienas paviršius, kuris gali
 * tyliai prasilenkti su `device-auth-service` transkriptu.
 */

function publicKeyText(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64url");
}

function proof(key: KeyObject, transcript: string): string {
  return sign(null, Buffer.from(transcript), key).toString("base64url");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

test("router redeems pairing, refreshes tokens and returns contract-shaped responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-router-"));
  try {
    const now = new Date("2026-07-26T10:00:00.000Z");
    const auth = new DeviceAuthService(
      new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
    );
    const router = new RemoteGatewayRouter({
      deviceAuth: auth,
      now: () => now,
      audit: new InMemoryAuditLog(),
    });
    const keys = generateKeyPairSync("ed25519");
    const devicePublicKey = publicKeyText(keys.publicKey);
    const challenge = await auth.createPairingChallenge({
      hostFingerprint: "sha256:33333333333333333333333333333333",
      scopes: ["ag:read", "terminal:write"],
      now,
    });
    const nonce = "pairing-router-nonce-01";
    const pairingProof = proof(keys.privateKey, [
      "ag-pair-v1",
      challenge.challengeId,
      challenge.hostFingerprint,
      devicePublicKey,
      nonce,
    ].join("\n"));
    const redeem = await router.handle({
      method: "POST",
      path: `/v1/pairing-challenges/${challenge.challengeId}/redeem`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        oneTimeCode: challenge.oneTimeCode,
        deviceName: "Owner phone",
        devicePublicKey,
        nonce,
        proof: pairingProof,
      }),
    });
    assert.equal(redeem.status, 200);
    assert.deepEqual(Object.keys(redeem.body).sort(), [
      "deviceId",
      "hostFingerprint",
      "principalId",
      "tokens",
    ]);
    assert.equal(JSON.stringify(redeem.body).includes(challenge.oneTimeCode), false);

    const deviceId = redeem.body["deviceId"];
    const tokens = redeem.body["tokens"] as Record<string, string>;
    assert.equal(typeof deviceId, "string");
    const refreshNonce = "refresh-router-nonce-01";
    const refreshProof = proof(keys.privateKey, [
      "ag-refresh-v1",
      String(deviceId),
      hashSecret(tokens["refreshToken"] ?? ""),
      refreshNonce,
      "1",
    ].join("\n"));
    const rejectedRefresh = await router.handle({
      method: "POST",
      path: "/v1/auth/refresh",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId,
        refreshToken: tokens["refreshToken"],
        nonce: refreshNonce,
        proof: Buffer.alloc(64).toString("base64url"),
      }),
    });
    assert.equal(rejectedRefresh.status, 401);
    const refreshed = await router.handle({
      method: "POST",
      path: "/v1/auth/refresh",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        deviceId,
        refreshToken: tokens["refreshToken"],
        nonce: refreshNonce,
        proof: refreshProof,
      }),
    });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(Object.keys(refreshed.body).sort(), [
      "accessExpiresAt",
      "accessToken",
      "refreshExpiresAt",
      "refreshToken",
    ]);
    assert.equal(refreshed.headers["cache-control"], "no-store");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("router is deny-by-default and rejects malformed or oversized input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-router-"));
  try {
    const auth = new DeviceAuthService(
      new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
    );
    const router = new RemoteGatewayRouter({ deviceAuth: auth, audit: new InMemoryAuditLog() });
    assert.equal((await router.handle({
      method: "POST",
      path: "https://attacker.invalid/v1/auth/refresh",
    })).status, 400);
    for (const path of [
      "/v1/local/pairing-challenges",
      "/v1/local/devices/00000000-0000-4000-8000-000000000000/revoke",
      "/v1/ag-loop/stop",
      "/v1/projects/00000000-0000-4000-8000-000000000000/integrate",
      "/v1/projects",
    ]) {
      const result = await router.handle({ method: "POST", path });
      assert.equal(result.status, 404, path);
    }

    const wrongType = await router.handle({
      method: "POST",
      path: "/v1/auth/refresh",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 400);
    const oversized = await router.handle({
      method: "POST",
      path: "/v1/auth/refresh",
      headers: { "content-type": "application/json" },
      body: Buffer.alloc(MAX_HTTP_BODY_BYTES + 1),
    });
    assert.equal(oversized.status, 400);
    assert.equal(assertEnvelopeMatchesTables(oversized, "oversized body"), "invalid_request");
    const extraField = await router.handle({
      method: "POST",
      path: "/v1/auth/refresh",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "00000000-0000-4000-8000-000000000000",
        refreshToken: "a".repeat(32),
        nonce: "refresh-nonce-0001",
        proof: "proof",
        executable: "powershell.exe",
      }),
    });
    assert.equal(extraField.status, 400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("protected project and AG UI reads require scope and enforce project membership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-router-"));
  try {
    const now = new Date("2026-07-26T10:00:00.000Z");
    const workspace = join(directory, "workspace");
    const repository = join(workspace, "safe-repository");
    await mkdir(join(repository, ".git"), { recursive: true });
    const registry = await ProjectRegistry.create({ personal: workspace });
    const projectId = "123e4567-e89b-42d3-a456-426614174000";
    const hiddenProjectId = "123e4567-e89b-42d3-a456-426614174001";
    await registry.registerExisting({
      projectId,
      name: "Safe project",
      rootId: "personal",
      relativePath: "safe-repository",
      branch: "main",
    });
    await registry.registerExisting({
      projectId: hiddenProjectId,
      name: "Hidden project",
      rootId: "personal",
      relativePath: "safe-repository",
      branch: "main",
    });
    const auth = new DeviceAuthService(
      new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
    );
    const paired = await pairTestDevice(auth, now, ["ag:read"], "Protected route phone");
    const terminalOnly = await pairTestDevice(auth, now, ["terminal:write"], "Terminal phone");
    let uiOffline = false;
    const readOnlyAgUi: AgLoopUiReadPort = agLoopUiReadDouble({
      async dashboard() {
        if (uiOffline) {
          throw new Error(`upstream-secret:${directory}`);
        }
        return {
          availability: "online",
          currentTask: { id: "task-1", state: "active" },
          queueCounts: { queue: 1 },
          runtime: [{ name: "AG loop", status: "running" }],
          reviewCount: 0,
          updatedAt: now.toISOString(),
        };
      },
      async taskBucket(bucket) {
        return { bucket, tasks: ["001-safe.md"], totalCount: 1 };
      },
    });
    const membership: ProjectMembershipPort = {
      async canReadProject(principalId, candidateProjectId) {
        return principalId === paired.principalId && candidateProjectId === projectId;
      },
      async canControlTerminal() {
        return false;
      },
    };
    const reads = new ProjectReadService(
      registry,
      membership,
      (candidateProjectId) => candidateProjectId === projectId ? readOnlyAgUi : undefined,
    );
    const router = new RemoteGatewayRouter({
      deviceAuth: auth,
      now: () => now,
      projectReads: reads,
      audit: new InMemoryAuditLog(),
    });
    const authorization = `Bearer ${paired.accessToken}`;

    assert.equal((await router.handle({
      method: "GET",
      path: "/v1/projects",
    })).status, 401);
    assert.equal((await router.handle({
      method: "GET",
      path: "/v1/projects",
      headers: { authorization: `Bearer ${terminalOnly.accessToken}` },
    })).status, 403);
    const projects = await router.handle({
      method: "GET",
      path: "/v1/projects",
      headers: { authorization },
    });
    assert.equal(projects.status, 200);
    assert.deepEqual(projects.body["projects"], [{
      projectId,
      name: "Safe project",
      repository: "safe-repository",
      branch: "main",
      agLoopUi: "online",
    }]);
    assert.equal(JSON.stringify(projects.body).includes(directory), false);

    const dashboard = await router.handle({
      method: "GET",
      path: `/v1/projects/${projectId}/ag-loop/ui/dashboard`,
      headers: { authorization },
    });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body["availability"], "online");
    const tasks = await router.handle({
      method: "GET",
      path: `/v1/projects/${projectId}/ag-loop/ui/tasks?bucket=queue`,
      headers: { authorization },
    });
    assert.equal(tasks.status, 200);
    assert.deepEqual(tasks.body["tasks"], ["001-safe.md"]);
    assert.equal((await router.handle({
      method: "GET",
      path: `/v1/projects/${projectId}/ag-loop/ui/tasks?bucket=unknown`,
      headers: { authorization },
    })).status, 400);
    assert.equal((await router.handle({
      method: "GET",
      path: `/v1/projects/${hiddenProjectId}/ag-loop/ui/dashboard`,
      headers: { authorization },
    })).status, 404);
    uiOffline = true;
    const offline = await router.handle({
      method: "GET",
      path: `/v1/projects/${projectId}/ag-loop/ui/dashboard`,
      headers: { authorization },
    });
    assert.equal(offline.status, 503);
    assert.equal(JSON.stringify(offline.body).includes("upstream-secret"), false);
    assert.equal(JSON.stringify(offline.body).includes(directory), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
