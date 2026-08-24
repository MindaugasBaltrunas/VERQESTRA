import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceAuthService } from "../application/device-auth-service.js";
import { GatewayRateLimits } from "../application/gateway-rate-limits.js";
import { GitHubReadService } from "../application/github-read-service.js";
import type {
  GitHostConnection,
  GitHostIssue,
  GitHostPort,
  GitHostPullRequest,
  GitHostRepositoryBinding,
  GitHostRepositoryStatus,
} from "../application/ports/git-host-port.js";
import type { ProjectMembershipPort } from "../application/ports/project-membership-port.js";
import { ProjectRegistry } from "../application/project-registry.js";
import { AtomicJsonDeviceAuthStateStore } from "../infrastructure/atomic-json-device-auth-state-store.js";
import { InMemoryAuditLog } from "../infrastructure/in-memory-audit-log.js";
import { RemoteGatewayRouter } from "../interfaces/http/remote-gateway-router.js";
import { assertEnvelopeMatchesTables } from "./envelope-assertions.js";

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const HIDDEN_PROJECT_ID = "123e4567-e89b-42d3-a456-426614174001";

/** Host boundary fake: the router tests never start a process or reach GitHub. */
class RecordingGitHostPort implements GitHostPort {
  connectionCalls = 0;
  statusCalls = 0;
  statusAnswer: GitHostRepositoryStatus | Error = {
    repository: "octo/repo",
    branch: "feature/voice",
    dirty: false,
    ahead: 0,
    behind: 3,
  };

  async connection(): Promise<GitHostConnection> {
    this.connectionCalls += 1;
    return { connectionId: "gh:github.com", status: "connected", account: "octocat" };
  }

  async beginAuthorization(): Promise<GitHostConnection> {
    throw new Error("no read route may begin authorization");
  }

  async revokeConnection(): Promise<void> {
    throw new Error("no read route may revoke a connection");
  }

  async binding(): Promise<GitHostRepositoryBinding | undefined> {
    throw new Error("no read route calls binding directly");
  }

  async repositoryStatus(): Promise<GitHostRepositoryStatus> {
    this.statusCalls += 1;
    if (this.statusAnswer instanceof Error) throw this.statusAnswer;
    return this.statusAnswer;
  }

  async listIssues(): Promise<readonly GitHostIssue[]> {
    throw new Error("no HTTP surface lists issues");
  }

  async issue(): Promise<GitHostIssue> {
    throw new Error("no HTTP surface reads an issue");
  }

  async listPullRequests(): Promise<readonly GitHostPullRequest[]> {
    throw new Error("no HTTP surface lists pull requests");
  }

  async createPullRequest(): Promise<GitHostPullRequest> {
    throw new Error("no HTTP surface creates a pull request");
  }
}

function publicKeyText(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64url");
}

async function pairDevice(
  auth: DeviceAuthService,
  now: Date,
  scopes: string[],
  nonce: string,
): Promise<Readonly<{ accessToken: string; principalId: string }>> {
  const keys = generateKeyPairSync("ed25519");
  const devicePublicKey = publicKeyText(keys.publicKey);
  const challenge = await auth.createPairingChallenge({
    hostFingerprint: "sha256:55555555555555555555555555555555",
    scopes,
    now,
  });
  const paired = await auth.redeemPairingChallenge({
    challengeId: challenge.challengeId,
    oneTimeCode: challenge.oneTimeCode,
    deviceName: "GitHub route phone",
    devicePublicKey,
    nonce,
    proof: sign(null, Buffer.from([
      "ag-pair-v1",
      challenge.challengeId,
      challenge.hostFingerprint,
      devicePublicKey,
      nonce,
    ].join("\n")), keys.privateKey).toString("base64url"),
    now,
  });
  return { accessToken: paired.tokens.accessToken, principalId: paired.principalId };
}

type Harness = Readonly<{
  router: RemoteGatewayRouter;
  gitHost: RecordingGitHostPort;
  authorization: string;
  otherScopeAuthorization: string;
}>;

async function withRouter(
  run: (harness: Harness) => Promise<void>,
  rateLimits?: GatewayRateLimits,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-github-routes-"));
  try {
    const now = new Date("2026-07-28T10:00:00.000Z");
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, "repository", ".git"), { recursive: true });
    const registry = await ProjectRegistry.create({ personal: workspace });
    for (const [projectId, name] of [[PROJECT_ID, "Mobile project"], [HIDDEN_PROJECT_ID, "Hidden"]]) {
      await registry.registerExisting({
        projectId: projectId as string,
        name: name as string,
        rootId: "personal",
        relativePath: "repository",
        branch: "main",
      });
    }
    const auth = new DeviceAuthService(
      new AtomicJsonDeviceAuthStateStore(join(directory, "state.json")),
    );
    const reader = await pairDevice(auth, now, ["github:read"], "github-route-nonce-01");
    const terminalOnly = await pairDevice(auth, now, ["terminal:write"], "github-route-nonce-02");
    const membership: ProjectMembershipPort = {
      async canReadProject(principalId, projectId) {
        return principalId === reader.principalId && projectId !== HIDDEN_PROJECT_ID;
      },
      async canControlTerminal() {
        return false;
      },
    };
    const gitHost = new RecordingGitHostPort();
    const router = new RemoteGatewayRouter({
      deviceAuth: auth,
      now: () => now,
      github: new GitHubReadService({ registry, membership, gitHost }),
      audit: new InMemoryAuditLog(),
      ...(rateLimits ? { rateLimits } : {}),
    });
    await run({
      router,
      gitHost,
      authorization: `Bearer ${reader.accessToken}`,
      otherScopeAuthorization: `Bearer ${terminalOnly.accessToken}`,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("GitHub reads are unreachable without a bearer token of the right scope", async () => {
  await withRouter(async ({ router, gitHost, otherScopeAuthorization }) => {
    for (const path of ["/v1/connections/github", `/v1/projects/${PROJECT_ID}/github`]) {
      assert.equal((await router.handle({ method: "GET", path })).status, 401, path);
      assert.equal(
        (await router.handle({
          method: "GET",
          path,
          headers: { authorization: otherScopeAuthorization },
        })).status,
        403,
        path,
      );
    }
    assert.equal(gitHost.connectionCalls, 0, "an unauthenticated caller must not reach the host");
    assert.equal(gitHost.statusCalls, 0, "an unauthenticated caller must not reach the host");
  });
});

test("GitHub reads reject query parameters and malformed project ids", async () => {
  await withRouter(async ({ router, gitHost, authorization }) => {
    assert.equal((await router.handle({
      method: "GET",
      path: "/v1/connections/github?x=1",
      headers: { authorization },
    })).status, 400);
    assert.equal((await router.handle({
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/github?x=1`,
      headers: { authorization },
    })).status, 400);
    assert.equal((await router.handle({
      method: "GET",
      path: "/v1/projects/not-a-uuid/github",
      headers: { authorization },
    })).status, 400);
    assert.equal(gitHost.connectionCalls, 0);
    assert.equal(gitHost.statusCalls, 0);
  });
});

test("GitHub reads answer with the contract DTOs and no-store headers", async () => {
  await withRouter(async ({ router, authorization }) => {
    const connection = await router.handle({
      method: "GET",
      path: "/v1/connections/github",
      headers: { authorization },
    });
    assert.equal(connection.status, 200);
    assert.deepEqual(connection.body, { status: "connected", account: "octocat" });
    assert.equal(connection.headers["cache-control"], "no-store");

    const status = await router.handle({
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/github`,
      headers: { authorization },
    });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, {
      repository: "octo/repo",
      branch: "feature/voice",
      dirty: false,
      ahead: 0,
      behind: 3,
    });
    assert.equal(status.headers["cache-control"], "no-store");
  });
});

test("an invisible project is not found and an unbound repository is a conflict", async () => {
  await withRouter(async ({ router, gitHost, authorization }) => {
    const hidden = await router.handle({
      method: "GET",
      path: `/v1/projects/${HIDDEN_PROJECT_ID}/github`,
      headers: { authorization },
    });
    assert.equal(hidden.status, 404);
    assert.equal(assertEnvelopeMatchesTables(hidden, "hidden project"), "project_not_found");

    gitHost.statusAnswer = Object.assign(new Error("no origin"), {
      code: "repository_not_bound",
    });
    const unbound = await router.handle({
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/github`,
      headers: { authorization },
    });
    assert.equal(unbound.status, 409);
    assert.equal(assertEnvelopeMatchesTables(unbound, "unbound repository"), "conflict");
  });
});

test("a host failure becomes a generic internal error with a correlation id", async () => {
  await withRouter(async ({ router, gitHost, authorization }) => {
    gitHost.statusAnswer = new Error("fatal: /host/workspace/repository leaked");
    const response = await router.handle({
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/github`,
      headers: { authorization },
    });
    assert.equal(response.status, 500);
    assert.equal(assertEnvelopeMatchesTables(response, "GitHub host failure"), "internal_error");
    assert.equal(JSON.stringify(response.body).includes("leaked"), false);
    assert.equal(JSON.stringify(response.body).includes("/host/workspace"), false);
  });
});

test("GitHub reads are budgeted per device", async () => {
  const rateLimits = new GatewayRateLimits({
    "github-read": { limit: 2, windowMs: 60_000, maxTrackedKeys: 8 },
  });
  await withRouter(async ({ router, authorization }) => {
    const request = {
      method: "GET",
      path: `/v1/projects/${PROJECT_ID}/github`,
      headers: { authorization },
    } as const;
    assert.equal((await router.handle(request)).status, 200);
    assert.equal((await router.handle(request)).status, 200);
    const limited = await router.handle(request);
    assert.equal(limited.status, 429);
    assert.equal(assertEnvelopeMatchesTables(limited, "GitHub read budget"), "rate_limited");
    assert.match(limited.headers["retry-after"] ?? "", /^\d+$/);
    // The budget is shared by the host connection route, which is the same
    // device spending the same host resource.
    assert.equal((await router.handle({
      method: "GET",
      path: "/v1/connections/github",
      headers: { authorization },
    })).status, 429);
  }, rateLimits);
});
