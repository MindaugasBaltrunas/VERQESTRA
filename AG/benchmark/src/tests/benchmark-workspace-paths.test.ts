import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  BENCHMARK_PACKAGE_ROOT,
  BenchmarkPathEscapeError,
  isInsideBenchmarkWorkspace,
  resolveInsideBenchmarkWorkspace,
} from "../infrastructure/benchmark-workspace-paths.js";

const root = path.join(path.sep === "\\" ? "C:\\" : "/", "benchmark-root");

test("a workspace-relative path resolves under the root", () => {
  assert.equal(
    resolveInsideBenchmarkWorkspace(path.join("fixtures", "bugfix-01"), root),
    path.join(root, "fixtures", "bugfix-01"),
  );
});

test("traversal out of the root is rejected", () => {
  for (const escape of ["..", path.join("..", "orchestrator"), path.join("fixtures", "..", "..", "state")]) {
    assert.throws(
      () => resolveInsideBenchmarkWorkspace(escape, root),
      BenchmarkPathEscapeError,
      escape,
    );
  }
});

test("an absolute path is rejected even when it points inside the root", () => {
  assert.throws(
    () => resolveInsideBenchmarkWorkspace(path.join(root, "fixtures"), root),
    BenchmarkPathEscapeError,
  );
});

test("traversal that lands back on the root is rejected", () => {
  // `fixtures/..` resolves to the root itself: containment holds, but the
  // caller asked for something other than what it got.
  assert.throws(() => resolveInsideBenchmarkWorkspace(path.join("fixtures", ".."), root), BenchmarkPathEscapeError);
  assert.throws(() => resolveInsideBenchmarkWorkspace(".", root), BenchmarkPathEscapeError);
});

test("the non-throwing form reports the same boundary", () => {
  assert.equal(isInsideBenchmarkWorkspace(path.join("fixtures", "ui-01"), root), true);
  assert.equal(isInsideBenchmarkWorkspace(path.join("..", "secrets"), root), false);
});

test("the default root is this package, not the process working directory", () => {
  assert.equal(path.basename(BENCHMARK_PACKAGE_ROOT), "benchmark");
  assert.equal(
    resolveInsideBenchmarkWorkspace("package.json"),
    path.join(BENCHMARK_PACKAGE_ROOT, "package.json"),
  );
});
