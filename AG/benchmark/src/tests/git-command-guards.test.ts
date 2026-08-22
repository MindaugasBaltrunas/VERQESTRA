import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOWED_GIT_SUBCOMMANDS,
  GitCommandRefusedError,
  assertSafeGitArguments,
  parseObjectId,
  splitNulSeparated,
} from "../infrastructure/git/git-runner.js";
import {
  UnverifiableRootError,
  VerifiedRoot,
  WorktreeRootEscapeError,
  createTemporaryRunRoot,
  isTemporaryRunRoot,
  samePath,
} from "../infrastructure/git/verified-root.js";

/**
 * The two guards every worktree operation passes through, tested without a
 * repository (BENCH-4).
 *
 * Both are refusals, and a refusal is exactly the behaviour an integration test
 * is worst at proving: it can only show that the destructive thing did not
 * happen this time. Stating the rules directly is what makes "no force
 * operation" and "nothing outside the verified root" checkable claims rather
 * than a description of the current call sites.
 */

/** Verbs that would let the runner reach a network or discard a working tree. */
const DESTRUCTIVE_SUBCOMMANDS = [
  "push",
  "clean",
  "reset",
  "checkout",
  "clone",
  "remote",
  "fetch",
  "branch",
  "rm",
  "gc",
];

test("only the subcommands the runner needs can be issued", () => {
  for (const subcommand of DESTRUCTIVE_SUBCOMMANDS) {
    assert.ok(
      !(ALLOWED_GIT_SUBCOMMANDS as readonly string[]).includes(subcommand),
      `"${subcommand}" is on the allowlist; the runner has no reason to issue it`,
    );
    assert.throws(
      () => assertSafeGitArguments([subcommand, "--dry-run"]),
      GitCommandRefusedError,
      `"git ${subcommand}" was not refused`,
    );
  }
});

test("the commands the worktree runner actually issues are accepted", () => {
  const issued: readonly (readonly string[])[] = [
    ["init"],
    ["symbolic-ref", "HEAD", "refs/heads/benchmark-base"],
    ["add", "--all"],
    ["commit", "--message", "benchmark fixture baseline"],
    ["rev-parse", "HEAD"],
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    ["diff", "--no-renames", "--name-only", "-z", "a".repeat(40), "b".repeat(40)],
    ["worktree", "add", "-b", "benchmark/run-0001/scenario-0001", "/tmp/w", "a".repeat(40)],
    ["worktree", "list", "--porcelain"],
    ["worktree", "remove", "/tmp/w"],
    ["worktree", "prune"],
  ];
  for (const args of issued) {
    assert.doesNotThrow(() => assertSafeGitArguments(args), `"git ${args.join(" ")}" was refused`);
  }
});

test("no force argument reaches Git, in any of its spellings", () => {
  const forced: readonly (readonly string[])[] = [
    ["worktree", "remove", "--force", "/tmp/w"],
    ["worktree", "remove", "-f", "/tmp/w"],
    ["add", "--force", "ignored.txt"],
    ["commit", "--force-with-lease"],
    ["diff", "--force-if-includes"],
    ["status", "--hard"],
    ["worktree", "prune", "-D"],
  ];
  for (const args of forced) {
    assert.throws(
      () => assertSafeGitArguments(args),
      (error: unknown) =>
        error instanceof GitCommandRefusedError && /force operation/.test(error.message),
      `"git ${args.join(" ")}" was not refused as a force operation`,
    );
  }
});

test("a force flag hidden in a cluster of short options is refused too", () => {
  // Git expands `-ff` into `-f -f`, so an exact-spelling check would let a force
  // removal through written this way.
  for (const argument of ["-ff", "-fq", "-qf", "-Dv", "-vD"]) {
    assert.throws(
      () => assertSafeGitArguments(["worktree", "remove", argument, "/tmp/w"]),
      (error: unknown) =>
        error instanceof GitCommandRefusedError && /force operation/.test(error.message),
      `"git worktree remove ${argument}" was not refused as a force operation`,
    );
  }
});

test("short options the runner does use are not mistaken for force flags", () => {
  assert.doesNotThrow(() => assertSafeGitArguments(["status", "--porcelain", "-z"]));
  assert.doesNotThrow(() =>
    assertSafeGitArguments(["worktree", "add", "-b", "benchmark/run-0001/s-0001", "/tmp/w"]),
  );
});

test("an empty command and an argument carrying a NUL byte are refused", () => {
  assert.throws(() => assertSafeGitArguments([]), GitCommandRefusedError);
  assert.throws(
    () => assertSafeGitArguments(["status", "--porcelain\0--force"]),
    (error: unknown) => error instanceof GitCommandRefusedError && /NUL/.test(error.message),
  );
});

test("a verified root contains what is under it and nothing else", () => {
  const root = new VerifiedRoot(path.resolve(path.sep, "benchmark-runs", "run-0001"));

  assert.ok(root.contains(path.join(root.path, "worktrees", "scenario-0001")));
  assert.ok(!root.contains(root.path), "the root is not strictly inside itself");
  assert.ok(!root.contains(path.resolve(root.path, "..")), "the parent is not inside the root");
  assert.ok(
    !root.contains(path.resolve(root.path, "..", "run-0002")),
    "a sibling run root is not inside this one",
  );
  assert.ok(
    !root.contains(path.join(root.path, "worktrees", "..", "..", "run-0002")),
    "traversal back out of the root is not containment",
  );
});

test("resolving outside the verified root throws instead of clamping", () => {
  const root = new VerifiedRoot(path.resolve(path.sep, "benchmark-runs", "run-0001"));
  assert.throws(() => root.resolve("..", "run-0002"), WorktreeRootEscapeError);
  assert.throws(() => root.assertContains(path.resolve(path.sep, "etc")), WorktreeRootEscapeError);
  assert.equal(
    root.resolve("worktrees", "scenario-0001"),
    path.join(root.path, "worktrees", "scenario-0001"),
  );
});

test("a relative root is refused: containment cannot be decided against one", () => {
  assert.throws(() => new VerifiedRoot(path.join("runs", "run-0001")), UnverifiableRootError);
});

test("only a benchmark run root in the temporary directory is recognised as removable", async () => {
  const created = await createTemporaryRunRoot("guards");
  try {
    assert.equal(await isTemporaryRunRoot(created.path), true);
    // The two shapes a recursive removal must never accept: a directory that is
    // not this package's, and the repository this package lives in.
    assert.equal(await isTemporaryRunRoot(tmpdir()), false);
    assert.equal(await isTemporaryRunRoot(process.cwd()), false);
    assert.equal(await isTemporaryRunRoot(path.join(created.path, "worktrees")), false);
  } finally {
    await rm(created.path, { recursive: true, force: true });
  }
});

test("path comparison normalises the spellings one filesystem treats as equal", () => {
  const base = path.resolve(path.sep, "benchmark-runs", "run-0001");
  assert.ok(samePath(base, path.join(base, "worktrees", "..")));
  assert.ok(!samePath(base, path.join(base, "worktrees")));
  if (process.platform === "win32" || process.platform === "darwin") {
    assert.ok(
      samePath(base, base.toUpperCase()),
      "this filesystem is case-insensitive, so case must not decide containment",
    );
  }
});

test("`-z` output is split on terminators, not on newlines a path may contain", () => {
  assert.deepEqual(splitNulSeparated("a.md\0docs/b c.md\0"), ["a.md", "docs/b c.md"]);
  assert.deepEqual(splitNulSeparated(""), []);
  assert.deepEqual(splitNulSeparated("with\nnewline.md\0"), ["with\nnewline.md"]);
});

test("only a real object id is read back as a commit", () => {
  assert.equal(parseObjectId(`${"a".repeat(40)}\n`, "test"), "a".repeat(40));
  assert.equal(parseObjectId(`${"f".repeat(64)}\n`, "test"), "f".repeat(64));
  assert.throws(
    () => parseObjectId("fatal: not a git repository\n", "Reading the base commit"),
    /did not report a commit id/,
  );
});
