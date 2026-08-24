import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubMutationService } from "../application/github-mutation-service.js";
import { GitHubReadService } from "../application/github-read-service.js";
import type {
  GitHostConnection,
  GitHostPort,
} from "../application/ports/git-host-port.js";
import type { ProjectMembershipPort } from "../application/ports/project-membership-port.js";
import { ProjectRegistry } from "../application/project-registry.js";
import {
  actions,
  connectIntent,
  harness,
  owner,
  rejects,
} from "./command-approval-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `command-approval.test.ts` buvo 843 eilutės).
 *
 * GitHub jungties mutacijos iškeltos, nes jų subjektas kitas: ne patvirtinimo taisyklė, o
 * `GitHubMutationService` — ar jis PRAŠO patvirtinimo prieš liesdamas hostą ir ar po mutacijos
 * atnaujina kešuotą skaitymo modelį.
 */

function gitHost(overrides: Partial<GitHostPort> = {}): GitHostPort {
  const unreachable = (): never => {
    throw new Error("this GitHub operation must not be reached");
  };
  return {
    connection: async () => Object.freeze({ connectionId: "c-1", status: "disconnected" as const }),
    beginAuthorization: async () => Object.freeze({
      connectionId: "c-1",
      status: "authorization_required" as const,
      authorizationUrl: "https://localhost/authorize",
      authorizationExpiresAt: "2026-08-10T10:05:00.000Z",
      reasonCode: "host_pending",
    }),
    revokeConnection: async () => undefined,
    binding: unreachable,
    repositoryStatus: unreachable,
    listIssues: unreachable,
    issue: unreachable,
    listPullRequests: unreachable,
    createPullRequest: unreachable,
    ...overrides,
  };
}

async function readService(
  host: GitHostPort,
  clock: () => Date,
  workspaceRoot: string,
): Promise<GitHubReadService> {
  const registry = await ProjectRegistry.create({ personal: workspaceRoot });
  const membership: ProjectMembershipPort = {
    async canReadProject() {
      return true;
    },
    async canControlTerminal() {
      return true;
    },
  };
  return new GitHubReadService({ registry, membership, gitHost: host, clock });
}

test("beginning a GitHub connection requires an approval and leaks no host detail", async () => {
  const { approvals, audit } = harness();
  let started = 0;
  const host = gitHost({
    beginAuthorization: async () => {
      started += 1;
      return Object.freeze({
        connectionId: "c-1",
        status: "authorization_required" as const,
        authorizationUrl: "https://localhost/authorize",
        authorizationExpiresAt: "2026-08-10T10:05:00.000Z",
        reasonCode: "host_pending",
      });
    },
  });
  const service = new GitHubMutationService({ gitHost: host, approvals });
  const intent = connectIntent();

  const challenge = await service.beginConnection(intent, owner());
  assert.equal(challenge.executed, false);
  assert.equal(challenge.outcome.decision, "confirmation_required");
  assert.equal(started, 0);

  const confirmed = await service.beginConnection(intent, owner(), {
    approval: {
      approvalChallengeId: challenge.outcome.approvalChallengeId as string,
      commandDigest: challenge.outcome.commandDigest as string,
    },
  });

  assert.equal(confirmed.executed, true);
  assert.equal(started, 1);
  assert.deepEqual(confirmed.executed === true ? confirmed.result : undefined, {
    status: "authorization_required",
    authorizationUrl: "https://localhost/authorize",
  });
  assert.deepEqual(actions(audit), [
    "command.approval.challenge:allowed",
    "command.submit:allowed",
    "command.execute:allowed",
  ]);
});

test("a GitHub connection mutation refreshes the cached read model", async (t) => {
  const { approvals } = harness();
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "ag-mobile-approval-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  let connectionReads = 0;
  const states: GitHostConnection[] = [
    Object.freeze({ connectionId: "c-1", status: "connected" as const, account: "octocat" }),
    Object.freeze({ connectionId: "c-1", status: "disconnected" as const }),
  ];
  const host = gitHost({
    connection: async () => {
      const state = states[Math.min(connectionReads, states.length - 1)] as GitHostConnection;
      connectionReads += 1;
      return state;
    },
  });
  const clock = () => new Date("2026-08-10T10:00:00.000Z");
  const reads = await readService(host, clock, workspaceRoot);
  const service = new GitHubMutationService({ gitHost: host, approvals, reads });

  assert.deepEqual(await reads.connection(), { status: "connected", account: "octocat" });
  // Cached: the TTL has not moved, so a second read must not reach the host.
  assert.deepEqual(await reads.connection(), { status: "connected", account: "octocat" });
  assert.equal(connectionReads, 1);

  const intent = connectIntent({ action: "github.connection.revoke" });
  const challenge = await service.revokeConnection(intent, owner());
  await service.revokeConnection(intent, owner(), {
    approval: {
      approvalChallengeId: challenge.outcome.approvalChallengeId as string,
      commandDigest: challenge.outcome.commandDigest as string,
    },
  });

  assert.deepEqual(await reads.connection(), { status: "disconnected" });
  assert.equal(connectionReads, 2);
});

test("a mutation method refuses an intent for another action", async () => {
  const { approvals } = harness();
  const service = new GitHubMutationService({ gitHost: gitHost(), approvals });

  await rejects(
    () => service.beginConnection(connectIntent({ action: "github.connection.revoke" }), owner()),
    "invalid_request",
  );
});
