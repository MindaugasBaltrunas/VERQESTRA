import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GitHubReadError,
  GitHubReadService,
} from "../application/github-read-service.js";
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

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const HIDDEN_PROJECT_ID = "123e4567-e89b-42d3-a456-426614174001";
const UNKNOWN_PROJECT_ID = "123e4567-e89b-42d3-a456-426614174002";
const PRINCIPAL_ID = "principal-1";

/** Fake host boundary: no process, no repository, no network in this file. */
class FakeGitHostPort implements GitHostPort {
  connectionCalls = 0;
  statusCalls = 0;
  connectionAnswer: GitHostConnection | Error = {
    connectionId: "gh:github.com",
    status: "connected",
    account: "octocat",
  };
  statusAnswer: GitHostRepositoryStatus | Error = {
    repository: "octo/repo",
    branch: "feature/voice",
    dirty: true,
    ahead: 2,
    behind: 1,
  };

  async connection(): Promise<GitHostConnection> {
    this.connectionCalls += 1;
    if (this.connectionAnswer instanceof Error) throw this.connectionAnswer;
    return this.connectionAnswer;
  }

  async beginAuthorization(): Promise<GitHostConnection> {
    throw new Error("not used by the read service");
  }

  async revokeConnection(): Promise<void> {
    throw new Error("not used by the read service");
  }

  async binding(): Promise<GitHostRepositoryBinding | undefined> {
    throw new Error("not used by the read service");
  }

  async repositoryStatus(): Promise<GitHostRepositoryStatus> {
    this.statusCalls += 1;
    if (this.statusAnswer instanceof Error) throw this.statusAnswer;
    return this.statusAnswer;
  }

  async listIssues(): Promise<readonly GitHostIssue[]> {
    throw new Error("not used by the read service");
  }

  async issue(): Promise<GitHostIssue> {
    throw new Error("not used by the read service");
  }

  async listPullRequests(): Promise<readonly GitHostPullRequest[]> {
    throw new Error("not used by the read service");
  }

  async createPullRequest(): Promise<GitHostPullRequest> {
    throw new Error("not used by the read service");
  }
}

/** A host connection that answers only when the test releases it. */
class DeferredGitHostPort extends FakeGitHostPort {
  private release?: (connection: GitHostConnection) => void;

  override async connection(): Promise<GitHostConnection> {
    this.connectionCalls += 1;
    return new Promise<GitHostConnection>((resolve) => {
      this.release = resolve;
    });
  }

  answer(connection: GitHostConnection): void {
    this.release?.(connection);
  }
}

const membership: ProjectMembershipPort = {
  async canReadProject(principalId, projectId) {
    return principalId === PRINCIPAL_ID && projectId !== HIDDEN_PROJECT_ID;
  },
  async canControlTerminal() {
    return false;
  },
};

async function withRegistry(
  run: (registry: ProjectRegistry, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-github-"));
  try {
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, "repository", ".git"), { recursive: true });
    const registry = await ProjectRegistry.create({ personal: workspace });
    await registry.registerExisting({
      projectId: PROJECT_ID,
      name: "Mobile project",
      rootId: "personal",
      relativePath: "repository",
      branch: "main",
    });
    await registry.registerExisting({
      projectId: HIDDEN_PROJECT_ID,
      name: "Hidden project",
      rootId: "personal",
      relativePath: "repository",
      branch: "main",
    });
    await run(registry, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("connection and status DTOs carry exactly the fields the contract declares", async () => {
  await withRegistry(async (registry) => {
    const gitHost = new FakeGitHostPort();
    const service = new GitHubReadService({ registry, membership, gitHost });

    const connection = await service.connection();
    assert.deepEqual(Object.keys(connection).sort(), ["account", "status"]);
    assert.deepEqual(connection, { status: "connected", account: "octocat" });

    const status = await service.projectStatus(PRINCIPAL_ID, PROJECT_ID);
    assert.deepEqual(Object.keys(status).sort(), [
      "ahead",
      "behind",
      "branch",
      "dirty",
      "repository",
    ]);
    assert.deepEqual(status, {
      repository: "octo/repo",
      branch: "feature/voice",
      dirty: true,
      ahead: 2,
      behind: 1,
    });
  });
});

test("host-only connection fields are dropped and absent fields are omitted", async () => {
  await withRegistry(async (registry) => {
    const gitHost = new FakeGitHostPort();
    gitHost.connectionAnswer = {
      connectionId: "gh:github.com",
      status: "authorization_required",
      reasonCode: "not_authenticated",
      authorizationExpiresAt: "2026-07-28T10:15:00.000Z",
    };
    const service = new GitHubReadService({ registry, membership, gitHost });
    const connection = await service.connection();
    assert.deepEqual(connection, { status: "authorization_required" });
    assert.equal("account" in connection, false);
    assert.equal("authorizationUrl" in connection, false);
    assert.equal(JSON.stringify(connection).includes("gh:github.com"), false);
    assert.equal(JSON.stringify(connection).includes("not_authenticated"), false);
  });
});

test("a host failure is a connection state, never a failed read", async () => {
  await withRegistry(async (registry) => {
    const gitHost = new FakeGitHostPort();
    gitHost.connectionAnswer = new Error("gh: /host/workspace/repository is unreadable");
    const service = new GitHubReadService({ registry, membership, gitHost });
    const connection = await service.connection();
    assert.deepEqual(connection, { status: "error" });
    assert.equal(JSON.stringify(connection).includes("/host/workspace"), false);
  });
});

test("project status enforces membership before the host is touched", async () => {
  await withRegistry(async (registry) => {
    const gitHost = new FakeGitHostPort();
    const service = new GitHubReadService({ registry, membership, gitHost });

    await assert.rejects(
      service.projectStatus(PRINCIPAL_ID, HIDDEN_PROJECT_ID),
      (error: unknown) => error instanceof GitHubReadError && error.code === "project_not_found",
    );
    await assert.rejects(
      service.projectStatus("other-principal", PROJECT_ID),
      (error: unknown) => error instanceof GitHubReadError && error.code === "project_not_found",
    );
    // An unregistered project is the same answer as an invisible one.
    await assert.rejects(
      service.projectStatus(PRINCIPAL_ID, UNKNOWN_PROJECT_ID),
      (error: unknown) => error instanceof GitHubReadError && error.code === "project_not_found",
    );
    assert.equal(gitHost.statusCalls, 0, "an unauthorized read must not reach the host");
  });
});

test("host failures are reduced to a taxonomy that carries no host text", async () => {
  await withRegistry(async (registry) => {
    const gitHost = new FakeGitHostPort();
    const service = new GitHubReadService({ registry, membership, gitHost });

    gitHost.statusAnswer = Object.assign(
      new Error("fatal: /host/workspace/repository has no origin"),
      { code: "repository_not_bound" },
    );
    await assert.rejects(
      service.projectStatus(PRINCIPAL_ID, PROJECT_ID),
      (error: unknown) => {
        assert.ok(error instanceof GitHubReadError);
        assert.equal(error.code, "repository_not_bound");
        assert.equal(error.message.includes("/host/workspace"), false);
        return true;
      },
    );

    gitHost.statusAnswer = new Error("fatal: /host/workspace/repository exploded");
    await assert.rejects(
      service.projectStatus(PRINCIPAL_ID, PROJECT_ID),
      (error: unknown) => {
        assert.ok(error instanceof GitHubReadError);
        assert.equal(error.code, "github_unavailable");
        assert.equal(error.message.includes("exploded"), false);
        assert.equal(error.message.includes("/host/workspace"), false);
        return true;
      },
    );
  });
});

test("repository status is never cached, because divergence changes constantly", async () => {
  await withRegistry(async (registry) => {
    const gitHost = new FakeGitHostPort();
    const service = new GitHubReadService({ registry, membership, gitHost });
    await service.projectStatus(PRINCIPAL_ID, PROJECT_ID);
    await service.projectStatus(PRINCIPAL_ID, PROJECT_ID);
    assert.equal(gitHost.statusCalls, 2);
  });
});

test("the host connection is cached briefly, shared and re-read after its window", async () => {
  await withRegistry(async (registry) => {
    const gitHost = new FakeGitHostPort();
    let nowMs = Date.parse("2026-07-28T10:00:00.000Z");
    const service = new GitHubReadService({
      registry,
      membership,
      gitHost,
      clock: () => new Date(nowMs),
      cacheTtlMs: 15_000,
    });

    await service.connection();
    await service.connection();
    assert.equal(gitHost.connectionCalls, 1, "a second read inside the window reuses the answer");

    nowMs += 15_000;
    await service.connection();
    assert.equal(gitHost.connectionCalls, 2, "an expired answer is read again");

    // A failed lookup expires far sooner than a successful one.
    gitHost.connectionAnswer = new Error("host fault");
    nowMs += 15_000;
    assert.deepEqual(await service.connection(), { status: "error" });
    assert.equal(gitHost.connectionCalls, 3);
    nowMs += 3_000;
    gitHost.connectionAnswer = { connectionId: "gh:github.com", status: "connected" };
    assert.deepEqual(await service.connection(), { status: "connected" });
    assert.equal(gitHost.connectionCalls, 4);
  });
});

test("concurrent connection reads share a single host lookup", async () => {
  await withRegistry(async (registry) => {
    const gitHost = new DeferredGitHostPort();
    const service = new GitHubReadService({ registry, membership, gitHost });
    const first = service.connection();
    const second = service.connection();
    gitHost.answer({ connectionId: "gh:github.com", status: "connected", account: "octocat" });
    assert.deepEqual(await first, { status: "connected", account: "octocat" });
    assert.deepEqual(await second, { status: "connected", account: "octocat" });
    assert.equal(gitHost.connectionCalls, 1);
  });
});
