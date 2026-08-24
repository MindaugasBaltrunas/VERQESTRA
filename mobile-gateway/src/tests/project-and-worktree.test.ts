import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IsolatedWorktreeService } from "../application/isolated-worktree-service.js";
import { ProjectRegistry } from "../application/project-registry.js";
import type { GitRunnerPort } from "../application/ports/git-runner-port.js";

test("project registry accepts only repository paths below a configured root", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ag-mobile-registry-"));
  try {
    const workspace = path.join(temp, "workspace");
    const repo = path.join(workspace, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    const registry = await ProjectRegistry.create({ personal: workspace });
    const summary = await registry.registerExisting({
      projectId: "project-1",
      name: "Repo",
      rootId: "personal",
      relativePath: "repo",
    });
    assert.deepEqual(summary, {
      projectId: "project-1",
      name: "Repo",
      repository: "repo",
      branch: "unknown",
    });
    assert.equal(registry.list()[0]?.name, "Repo");
    await assert.rejects(() => registry.registerExisting({
      projectId: "project-2",
      name: "Escape",
      rootId: "personal",
      relativePath: temp,
    }), /relative/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("worktree service constructs fixed git arguments under the session root", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ag-mobile-worktree-"));
  try {
    const repository = path.join(temp, "repo");
    const sessions = path.join(temp, "sessions");
    await mkdir(repository);
    await mkdir(sessions);
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];
    const runner: GitRunnerPort = {
      async run(cwd, args) {
        calls.push({ cwd, args });
        await mkdir(args[4]!, { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const service = new IsolatedWorktreeService(runner, sessions);
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const allocation = await service.allocate({
      repositoryRoot: repository,
      sessionId,
      baseCommit: "abcdef1234567890",
    });
    assert.equal(allocation.branch, `mobile/${sessionId}`);
    assert.equal(path.dirname(allocation.worktreeRoot), await import("node:fs/promises").then(({ realpath }) => realpath(sessions)));
    assert.deepEqual(calls[0]?.args, [
      "worktree",
      "add",
      "-b",
      `mobile/${sessionId}`,
      allocation.worktreeRoot,
      "abcdef1234567890",
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
