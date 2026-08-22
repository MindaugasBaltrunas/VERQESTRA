import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Workspace containment (design §Saugumas).
 *
 * Fixtures, worktree roots and report targets are all named by data — suite
 * files, CLI flags, stored samples. Every one of those paths is resolved here
 * first, so a scenario cannot reach a file outside this package by declaring
 * `../../..` and no cleanup ever runs against an unverified path.
 */

/**
 * Resolved from this module rather than `process.cwd()`: the runner is started
 * from the repository root, so a cwd-relative root would place the guard's
 * boundary somewhere other than this package.
 */
export const BENCHMARK_PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../");

export class BenchmarkPathEscapeError extends Error {
  constructor(
    readonly requestedPath: string,
    readonly root: string,
  ) {
    super(`Path "${requestedPath}" resolves outside the benchmark workspace root "${root}".`);
    this.name = "BenchmarkPathEscapeError";
  }
}

/**
 * Resolves `relativePath` under `root` and returns it only when the result is
 * strictly inside. Absolute inputs, traversal and the root itself are rejected:
 * a caller that meant the root can name it directly, while a `..` that lands
 * back on the root is the traversal case this guard exists for.
 */
export function resolveInsideBenchmarkWorkspace(
  relativePath: string,
  root: string = BENCHMARK_PACKAGE_ROOT,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new BenchmarkPathEscapeError(relativePath, root);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const inside = path.relative(resolvedRoot, resolved);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new BenchmarkPathEscapeError(relativePath, resolvedRoot);
  }
  return resolved;
}

/** Non-throwing form for validation reporting, where one bad path must not abort the whole suite check. */
export function isInsideBenchmarkWorkspace(
  relativePath: string,
  root: string = BENCHMARK_PACKAGE_ROOT,
): boolean {
  try {
    resolveInsideBenchmarkWorkspace(relativePath, root);
    return true;
  } catch (error) {
    if (error instanceof BenchmarkPathEscapeError) return false;
    throw error;
  }
}
