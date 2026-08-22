import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { BenchmarkPathEscapeError } from "../infrastructure/benchmark-workspace-paths.js";
import {
  FIXTURE_BASE_BRANCH,
  FixtureMaterializationError,
  FixtureRepositoryStore,
} from "../infrastructure/fixtures/fixture-repository.js";
import { execFileGitRunner, runGit } from "../infrastructure/git/git-runner.js";
import { VerifiedRoot } from "../infrastructure/git/verified-root.js";

/**
 * Materializing a fixture into the repository a sample branches off (BENCH-4).
 *
 * The tests run against a synthetic workspace rather than this package's real
 * fixtures, because what is under test is the boundary — what a fixture
 * declaration is allowed to reach — and stating that requires declaring things
 * the real suite deliberately does not contain.
 */

interface Workspace {
  readonly root: string;
  readonly store: FixtureRepositoryStore;
  readonly runRoot: VerifiedRoot;
}

/** A workspace and a run root, both outside the repository, both removed with the test. */
async function workspace(t: TestContext, files: Readonly<Record<string, string>>): Promise<Workspace> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ag-benchmark-workspace-")));
  const runRoot = new VerifiedRoot(
    await realpath(await mkdtemp(path.join(tmpdir(), "ag-benchmark-runroot-"))),
  );
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(runRoot.path, { recursive: true, force: true });
  });
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  return {
    root,
    runRoot,
    store: new FixtureRepositoryStore(runRoot, { workspaceRoot: root }),
  };
}

const SIMPLE_FIXTURE = {
  "fixtures/task-service/README.md": "# task service\n",
  "fixtures/task-service/src/task-store.mjs": "export const tasks = [];\n",
} as const;

test("a fixture becomes a repository with one commit, inside the run root", async (t) => {
  const { store, runRoot } = await workspace(t, SIMPLE_FIXTURE);
  const repository = await store.materialize("fixtures/task-service");

  assert.ok(runRoot.contains(repository.path), "the fixture repository escaped the run root");
  assert.equal(repository.fixture, "fixtures/task-service");
  assert.equal(repository.baseBranch, FIXTURE_BASE_BRANCH);
  assert.match(repository.baseCommit, /^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

  const at = { cwd: repository.path };
  const branch = await runGit(
    execFileGitRunner,
    ["symbolic-ref", "--short", "HEAD"],
    at,
    "reading the base branch",
  );
  assert.equal(branch.trim(), FIXTURE_BASE_BRANCH);

  const pending = await runGit(
    execFileGitRunner,
    ["diff", "--no-renames", "--name-only", repository.baseCommit],
    at,
    "comparing the baseline commit with the working tree",
  );
  assert.equal(pending.trim(), "", "the baseline commit does not match the working tree");
});

test("the base commit is a function of the fixture content, not of when it was run", async (t) => {
  const first = await workspace(t, SIMPLE_FIXTURE);
  const second = await workspace(t, SIMPLE_FIXTURE);

  const left = await first.store.materialize("fixtures/task-service");
  const right = await second.store.materialize("fixtures/task-service");

  assert.equal(
    left.baseCommit,
    right.baseCommit,
    "two hosts materializing identical fixture content must agree on the commit they start from",
  );
});

test("a fixture is materialized once, so every sample of it starts from one commit", async (t) => {
  const { store } = await workspace(t, SIMPLE_FIXTURE);
  const first = await store.materialize("fixtures/task-service");
  const second = await store.materialize("fixtures/task-service");
  assert.equal(first.path, second.path);
  assert.equal(first.baseCommit, second.baseCommit);
  assert.deepEqual(store.materialized, [first.path]);
});

test("entries that are not part of the fixture are left out of the repository", async (t) => {
  const { store } = await workspace(t, {
    ...SIMPLE_FIXTURE,
    "fixtures/task-service/node_modules/left-pad/index.js": "module.exports = 1;\n",
    "fixtures/task-service/dist/task-store.js": "compiled\n",
    "fixtures/task-service/.git/config": "[core]\n",
  });
  const repository = await store.materialize("fixtures/task-service");

  // The baseline has no parent commit, so the tracked set is read from the
  // commit itself rather than from a diff against something earlier.
  const listed = await runGit(
    execFileGitRunner,
    ["log", "--name-only", "--pretty=format:", repository.baseCommit],
    { cwd: repository.path },
    "listing the baseline files",
  );
  const files = listed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();
  assert.deepEqual(
    files,
    ["README.md", "src/task-store.mjs"],
    "a build output, an installed dependency or a nested repository reached the fixture baseline",
  );
});

test("a fixture that resolves outside the benchmark workspace is refused", async (t) => {
  const { store } = await workspace(t, SIMPLE_FIXTURE);
  await assert.rejects(
    store.materialize("../../../etc"),
    (error: unknown) =>
      error instanceof FixtureMaterializationError &&
      error.cause instanceof BenchmarkPathEscapeError,
    "traversal out of the workspace was not refused",
  );
  await assert.rejects(
    store.materialize(path.resolve(path.sep, "etc")),
    FixtureMaterializationError,
    "an absolute fixture path was not refused",
  );
});

test("a path inside the workspace but outside `fixtures/` is refused", async (t) => {
  const { store } = await workspace(t, {
    ...SIMPLE_FIXTURE,
    "src/index.ts": "export {};\n",
  });
  await assert.rejects(
    store.materialize("src"),
    (error: unknown) =>
      error instanceof FixtureMaterializationError && /fixtures live under/.test(error.message),
  );
});

test("a fixture that does not exist is refused rather than materialized empty", async (t) => {
  const { store } = await workspace(t, SIMPLE_FIXTURE);
  await assert.rejects(
    store.materialize("fixtures/absent"),
    (error: unknown) =>
      error instanceof FixtureMaterializationError && /no such directory/.test(error.message),
  );
});

test("a fixture with no files is refused: there would be nothing to start from", async (t) => {
  const { root, store } = await workspace(t, SIMPLE_FIXTURE);
  await mkdir(path.join(root, "fixtures", "hollow"), { recursive: true });
  await assert.rejects(
    store.materialize("fixtures/hollow"),
    (error: unknown) =>
      error instanceof FixtureMaterializationError && /contains no files/.test(error.message),
  );
});

test("a symbolic link inside a fixture is refused, not followed", async (t) => {
  const { root, store } = await workspace(t, SIMPLE_FIXTURE);
  const link = path.join(root, "fixtures", "task-service", "escape.md");
  try {
    await symlink(path.resolve(root, "..", "..", "outside.md"), link, "file");
  } catch (error) {
    // Creating a symbolic link is a privileged operation on Windows unless
    // developer mode is on. The refusal cannot be observed on a host that will
    // not let the situation be created in the first place.
    t.skip(`this host does not permit creating symbolic links: ${(error as Error).message}`);
    return;
  }
  await assert.rejects(
    store.materialize("fixtures/task-service"),
    (error: unknown) =>
      error instanceof FixtureMaterializationError && /symbolic link/.test(error.message),
  );
});

test("two fixtures that read alike get separate repositories", async (t) => {
  // Both fold to the same readable slug; only the digest of the declared path
  // keeps the second from being copied on top of the first.
  const { store } = await workspace(t, {
    "fixtures/task-service/README.md": "# flat\n",
    "fixtures/task/service/README.md": "# nested\n",
  });
  const flat = await store.materialize("fixtures/task-service");
  const nested = await store.materialize("fixtures/task/service");

  assert.notEqual(flat.path, nested.path, "two fixtures shared one repository directory");
  assert.notEqual(flat.baseCommit, nested.baseCommit);
  assert.equal(store.materialized.length, 2);
});

test("a fixture directory that is itself a symbolic link is refused", async (t) => {
  const { root, store } = await workspace(t, SIMPLE_FIXTURE);
  const outside = path.join(root, "..", `ag-benchmark-outside-${path.basename(root)}`);
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.md"), "# not a fixture\n", "utf8");
  t.after(async () => {
    await rm(outside, { recursive: true, force: true });
  });
  try {
    await symlink(outside, path.join(root, "fixtures", "linked"), "dir");
  } catch (error) {
    // Symbolic links are privileged on Windows unless developer mode is on.
    t.skip(`this host does not permit creating symbolic links: ${(error as Error).message}`);
    return;
  }

  await assert.rejects(
    store.materialize("fixtures/linked"),
    (error: unknown) =>
      error instanceof FixtureMaterializationError && /symbolic link/.test(error.message),
    "a fixture pointing outside the workspace was materialized anyway",
  );
});

test("a failed materialization is not cached, so a later attempt is not refused for it", async (t) => {
  const { root, store } = await workspace(t, SIMPLE_FIXTURE);
  await assert.rejects(store.materialize("fixtures/late"), FixtureMaterializationError);

  await mkdir(path.join(root, "fixtures", "late"), { recursive: true });
  await writeFile(path.join(root, "fixtures", "late", "README.md"), "# late\n", "utf8");
  const repository = await store.materialize("fixtures/late");
  assert.match(repository.baseCommit, /^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
});
