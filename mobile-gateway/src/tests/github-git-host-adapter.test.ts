import assert from "node:assert/strict";
import test from "node:test";
import type { GitRunnerPort, GitRunResult } from "../application/ports/git-runner-port.js";
import {
  GhCliGitHostAdapter,
  GitHostError,
} from "../infrastructure/gh-cli-git-host-adapter.js";
import {
  GH_CLI_NOT_INSTALLED,
  GH_CLI_UNAVAILABLE,
  type GhCliResult,
  type GhCliRunner,
} from "../infrastructure/gh-cli-runner.js";

/**
 * Every fact below is answered by a fake: `verification-matrix.md` requires the
 * contract run to pass on a host with no GitHub CLI and no network, so no test
 * here starts a process, resolves a name or reaches github.com.
 */

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROJECT_ROOT = "/host/workspace/repository";

/**
 * A remote may legitimately embed a credential; this is the one that must never
 * surface. The value deliberately does NOT imitate a real GitHub token layout:
 * the adapter strips URL userinfo by position, never by recognising a token
 * shape, so a generic secret exercises exactly the same path — and a fixture
 * shaped like a real credential would trip the repository secret scanner for no
 * added coverage.
 */
const CREDENTIAL = "not-a-real-remote-password-0000000000";

type Fake<T> = Readonly<{ calls: string[][]; port: T }>;

function fakeGit(answers: Readonly<Record<string, GitRunResult>>): Fake<GitRunnerPort> & {
  readonly roots: string[];
} {
  const calls: string[][] = [];
  const roots: string[] = [];
  return {
    calls,
    roots,
    port: {
      async run(cwd, args) {
        roots.push(cwd);
        calls.push([...args]);
        // An unstubbed command is the "not present" answer git itself gives.
        return answers[args.join(" ")] ?? { exitCode: 128, stdout: "", stderr: "" };
      },
    },
  };
}

function fakeGh(handler: (args: readonly string[]) => GhCliResult): Fake<GhCliRunner> {
  const calls: string[][] = [];
  return {
    calls,
    port: async (args) => {
      calls.push([...args]);
      return handler(args);
    },
  };
}

function ok(stdout: string): GhCliResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function adapterFor(
  git: GitRunnerPort,
  run: GhCliRunner,
): GhCliGitHostAdapter {
  return new GhCliGitHostAdapter({ git, projectRoot: () => PROJECT_ROOT, run });
}

const BOUND_REPOSITORY: Readonly<Record<string, GitRunResult>> = {
  "remote get-url origin": { exitCode: 0, stdout: "https://github.com/octo/repo.git\n", stderr: "" },
  "symbolic-ref --quiet --short HEAD": { exitCode: 0, stdout: "feature/voice\n", stderr: "" },
  "symbolic-ref --quiet --short refs/remotes/origin/HEAD": {
    exitCode: 0,
    stdout: "origin/main\n",
    stderr: "",
  },
};

test("connection state is fail-closed and distinguishes the four host answers", async () => {
  const git = fakeGit(BOUND_REPOSITORY);

  const missing = fakeGh(() => ({ exitCode: GH_CLI_NOT_INSTALLED, stdout: "", stderr: "" }));
  assert.deepEqual(await adapterFor(git.port, missing.port).connection(), {
    connectionId: "gh:github.com",
    status: "disconnected",
    reasonCode: "cli_not_installed",
  });
  assert.deepEqual(missing.calls, [["auth", "status", "--hostname", "github.com"]]);

  const broken = fakeGh(() => ({ exitCode: GH_CLI_UNAVAILABLE, stdout: "", stderr: "" }));
  assert.deepEqual(await adapterFor(git.port, broken.port).connection(), {
    connectionId: "gh:github.com",
    status: "error",
    reasonCode: "cli_unavailable",
  });

  const signedOut = fakeGh(() => ({ exitCode: 1, stdout: "", stderr: "You are not logged in\n" }));
  assert.deepEqual(await adapterFor(git.port, signedOut.port).connection(), {
    connectionId: "gh:github.com",
    status: "authorization_required",
    reasonCode: "not_authenticated",
  });

  const signedIn = fakeGh(() => ok([
    "github.com",
    "  ✓ Logged in to github.com account octocat (keyring)",
    "  - Token: gho_************************************",
    "  - Active account: true",
  ].join("\n")));
  const connected = await adapterFor(git.port, signedIn.port).connection();
  assert.deepEqual(connected, {
    connectionId: "gh:github.com",
    status: "connected",
    account: "octocat",
  });
  // The masked token line is read past, never carried.
  assert.equal(JSON.stringify(connected).includes("gho_"), false);
});

test("authorization cannot be started from a device and never invents a URL", async () => {
  const git = fakeGit(BOUND_REPOSITORY);
  const signedOut = fakeGh(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  const adapter = adapterFor(git.port, signedOut.port);
  const started = await adapter.beginAuthorization({ requestId: "request-1" });
  assert.equal(started.status, "authorization_required");
  assert.equal(started.reasonCode, "interactive_authorization_required");
  assert.equal(started.authorizationUrl, undefined);
  await assert.rejects(
    adapter.revokeConnection({ requestId: "request-2" }),
    (error: unknown) => error instanceof GitHostError && error.code === "unsupported_operation",
  );
});

test("GitHub queries run a fixed argument vector with no credential-revealing flag", async () => {
  const git = fakeGit(BOUND_REPOSITORY);
  const gh = fakeGh(() => ok("[]"));
  const adapter = adapterFor(git.port, gh.port);
  await adapter.listIssues({ projectId: PROJECT_ID, limit: 20 });
  await adapter.listPullRequests({ projectId: PROJECT_ID, limit: 500 });
  await adapter.connection();

  assert.deepEqual(gh.calls, [
    [
      "issue",
      "list",
      "--repo",
      "octo/repo",
      "--state",
      "all",
      "--limit",
      "20",
      "--json",
      "number,title,state,url,labels,updatedAt",
    ],
    [
      "pr",
      "list",
      "--repo",
      "octo/repo",
      "--state",
      "all",
      "--limit",
      // The port's limit is clamped to a bounded page rather than forwarded.
      "100",
      "--json",
      "number,title,state,isDraft,url,headRefName,baseRefName,updatedAt",
    ],
    ["auth", "status", "--hostname", "github.com"],
  ]);
  assert.doesNotMatch(
    JSON.stringify(gh.calls),
    /show-token|--token|secret|password/i,
    "no GitHub CLI argument may ask for or carry a credential",
  );
});

test("a credential embedded in the origin URL never leaves the adapter", async () => {
  const git = fakeGit({
    ...BOUND_REPOSITORY,
    "remote get-url origin": {
      exitCode: 0,
      stdout: `https://octocat:${CREDENTIAL}@github.com/octo/repo.git\n`,
      stderr: "",
    },
    "diff --quiet HEAD": { exitCode: 0, stdout: "", stderr: "" },
    "rev-list --left-right --count @{upstream}...HEAD": {
      exitCode: 0,
      stdout: "0\t0\n",
      stderr: "",
    },
  });
  const gh = fakeGh(() => ok("[]"));
  const adapter = adapterFor(git.port, gh.port);

  const binding = await adapter.binding({ projectId: PROJECT_ID });
  assert.deepEqual(binding, {
    projectId: PROJECT_ID,
    owner: "octo",
    repository: "repo",
    defaultBranch: "main",
  });
  const status = await adapter.repositoryStatus({ projectId: PROJECT_ID });
  const issues = await adapter.listIssues({ projectId: PROJECT_ID, limit: 5 });
  for (const value of [binding, status, issues]) {
    assert.equal(
      JSON.stringify(value).includes(CREDENTIAL),
      false,
      "a returned value carried the remote credential",
    );
  }
  assert.equal(JSON.stringify(gh.calls).includes(CREDENTIAL), false);

  // The failure path is the other half: an error message must not quote the
  // remote, the CLI output or anything derived from them.
  const failing = fakeGit({
    ...BOUND_REPOSITORY,
    "remote get-url origin": {
      exitCode: 0,
      stdout: `https://octocat:${CREDENTIAL}@github.com/octo/repo.git\n`,
      stderr: "",
    },
    "diff --quiet HEAD": {
      exitCode: 128,
      stdout: "",
      stderr: `fatal: unable to read https://octocat:${CREDENTIAL}@github.com/octo/repo.git`,
    },
  });
  await assert.rejects(
    adapterFor(failing.port, gh.port).repositoryStatus({ projectId: PROJECT_ID }),
    (error: unknown) => {
      assert.ok(error instanceof GitHostError);
      assert.equal(error.code, "github_unavailable");
      assert.equal(`${error.message}${error.stack ?? ""}`.includes(CREDENTIAL), false);
      return true;
    },
  );
});

test("only a GitHub origin binds a project", async () => {
  const gh = fakeGh(() => ok("[]"));
  const withoutOrigin = fakeGit({});
  assert.equal(
    await adapterFor(withoutOrigin.port, gh.port).binding({ projectId: PROJECT_ID }),
    undefined,
  );

  for (const remote of [
    "https://gitlab.com/octo/repo.git",
    "https://github.com.evil.example/octo/repo.git",
    "https://github.com/octo/repo/extra.git",
    "not a remote url",
  ]) {
    const git = fakeGit({
      ...BOUND_REPOSITORY,
      "remote get-url origin": { exitCode: 0, stdout: `${remote}\n`, stderr: "" },
    });
    assert.equal(
      await adapterFor(git.port, gh.port).binding({ projectId: PROJECT_ID }),
      undefined,
      `${remote} must not bind a project`,
    );
  }

  const sshRemote = fakeGit({
    ...BOUND_REPOSITORY,
    "remote get-url origin": { exitCode: 0, stdout: "git@github.com:octo/repo.git\n", stderr: "" },
  });
  assert.deepEqual(await adapterFor(sshRemote.port, gh.port).binding({ projectId: PROJECT_ID }), {
    projectId: PROJECT_ID,
    owner: "octo",
    repository: "repo",
    defaultBranch: "main",
  });
  assert.equal(gh.calls.length, 0, "binding a project must not touch the GitHub CLI");
});

test("repository status is read from local git alone", async () => {
  const gh = fakeGh(() => {
    throw new Error("repository status must not reach the GitHub CLI");
  });
  const dirty = fakeGit({
    ...BOUND_REPOSITORY,
    "diff --quiet HEAD": { exitCode: 1, stdout: "", stderr: "" },
    "rev-list --left-right --count @{upstream}...HEAD": {
      exitCode: 0,
      stdout: "2\t3\n",
      stderr: "",
    },
  });
  const dirtyAdapter = adapterFor(dirty.port, gh.port);
  assert.deepEqual(await dirtyAdapter.repositoryStatus({ projectId: PROJECT_ID }), {
    repository: "octo/repo",
    branch: "feature/voice",
    dirty: true,
    ahead: 3,
    behind: 2,
  });
  assert.equal(dirty.roots.length, dirty.calls.length);
  assert.ok(dirty.roots.every((root) => root === PROJECT_ROOT), "every git command runs in the project root");
  assert.deepEqual(dirty.calls, [
    ["remote", "get-url", "origin"],
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ["diff", "--quiet", "HEAD"],
    ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
  ]);

  // No upstream and a detached HEAD are ordinary states, not failures.
  const detached = fakeGit({
    "remote get-url origin": {
      exitCode: 0,
      stdout: "ssh://git@github.com/octo/repo.git\n",
      stderr: "",
    },
    "diff --quiet HEAD": { exitCode: 0, stdout: "", stderr: "" },
  });
  assert.deepEqual(await adapterFor(detached.port, gh.port).repositoryStatus({ projectId: PROJECT_ID }), {
    repository: "octo/repo",
    branch: "(detached)",
    dirty: false,
    ahead: 0,
    behind: 0,
  });

  const unbound = fakeGit({});
  await assert.rejects(
    adapterFor(unbound.port, gh.port).repositoryStatus({ projectId: PROJECT_ID }),
    (error: unknown) => error instanceof GitHostError && error.code === "repository_not_bound",
  );
});

test("issue and pull request payloads are projected field by field", async () => {
  const git = fakeGit(BOUND_REPOSITORY);
  const gh = fakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") {
      return ok(JSON.stringify([{
        number: 7,
        title: "Voice input drops the last word",
        state: "OPEN",
        url: "https://github.com/octo/repo/issues/7",
        labels: [{ id: "L1", name: "bug" }, { id: "L2", name: "mobile" }],
        updatedAt: "2026-07-28T09:00:00Z",
        body: "internal detail that must not be projected",
      }]));
    }
    if (args[0] === "issue") {
      return ok(JSON.stringify({
        number: 7,
        title: "Voice input drops the last word",
        state: "CLOSED",
        url: "https://github.com/octo/repo/issues/7",
        labels: [],
        updatedAt: "2026-07-28T09:00:00Z",
      }));
    }
    return ok(JSON.stringify([{
      number: 11,
      title: "Add GitHub read routes",
      state: "MERGED",
      isDraft: false,
      url: "https://github.com/octo/repo/pull/11",
      headRefName: "mobile/session",
      baseRefName: "main",
      updatedAt: "2026-07-28T10:00:00Z",
    }]));
  });
  const adapter = adapterFor(git.port, gh.port);

  assert.deepEqual(await adapter.listIssues({ projectId: PROJECT_ID, limit: 10 }), [{
    number: 7,
    title: "Voice input drops the last word",
    state: "open",
    url: "https://github.com/octo/repo/issues/7",
    labels: ["bug", "mobile"],
    updatedAt: "2026-07-28T09:00:00Z",
  }]);
  assert.equal((await adapter.issue({ projectId: PROJECT_ID, issueNumber: 7 })).state, "closed");
  assert.deepEqual(await adapter.listPullRequests({ projectId: PROJECT_ID, limit: 10 }), [{
    number: 11,
    title: "Add GitHub read routes",
    state: "merged",
    draft: false,
    url: "https://github.com/octo/repo/pull/11",
    headBranch: "mobile/session",
    baseBranch: "main",
    updatedAt: "2026-07-28T10:00:00Z",
  }]);

  const garbled = fakeGh(() => ok("not json at all: /host/workspace/repository"));
  await assert.rejects(
    adapterFor(git.port, garbled.port).listIssues({ projectId: PROJECT_ID, limit: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof GitHostError);
      assert.equal(error.code, "github_unavailable");
      assert.equal(error.message.includes("not json"), false);
      assert.equal(error.message.includes(PROJECT_ROOT), false);
      return true;
    },
  );

  const wrongShape = fakeGh(() => ok(JSON.stringify([{ number: 7 }])));
  await assert.rejects(
    adapterFor(git.port, wrongShape.port).listIssues({ projectId: PROJECT_ID, limit: 10 }),
    (error: unknown) => error instanceof GitHostError && error.code === "github_unavailable",
  );
});

test("a write whose approved repository drifted is refused before any GitHub call", async () => {
  const git = fakeGit(BOUND_REPOSITORY);
  const gh = fakeGh(() => ok("https://github.com/octo/repo/pull/12\n"));
  const adapter = adapterFor(git.port, gh.port);
  const write = {
    projectId: PROJECT_ID,
    expectedRepository: "octo/other-repo",
    idempotencyKey: "device-1:1",
    approvedCommandId: "command-1",
  };
  await assert.rejects(
    adapter.createPullRequest(write, {
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      title: "Reviewed session",
      draft: true,
      headBranch: "mobile/session",
      baseBranch: "main",
    }),
    (error: unknown) => error instanceof GitHostError && error.code === "binding_mismatch",
  );
  assert.equal(gh.calls.length, 0, "a mismatched binding must not reach the GitHub CLI");

  const created = await adapter.createPullRequest(
    { ...write, expectedRepository: "octo/repo" },
    {
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      title: "Reviewed session",
      draft: true,
      headBranch: "mobile/session",
      baseBranch: "main",
    },
  );
  assert.deepEqual(gh.calls, [[
    "pr",
    "create",
    "--repo",
    "octo/repo",
    "--base",
    "main",
    "--head",
    "mobile/session",
    "--title",
    "Reviewed session",
    "--draft",
    "--body",
    "",
  ]]);
  assert.equal(created.number, 12);
  assert.equal(created.draft, true);
  assert.equal(created.url, "https://github.com/octo/repo/pull/12");
});
