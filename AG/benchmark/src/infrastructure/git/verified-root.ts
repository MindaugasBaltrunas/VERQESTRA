import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The verified root every worktree operation is bounded by (design §Saugumas).
 *
 * The design states that a worktree root must be resolved and verified *before*
 * create and cleanup, and this class is what "verified" means concretely: one
 * absolute, symlink-free directory, decided once, against which every later path
 * is checked. Cleanup is the reason it exists. Creating a directory in the wrong
 * place wastes disk; removing one in the wrong place destroys work, and the
 * caller's path is derived from a scenario id, a run id and a Git listing — data
 * this package did not author.
 *
 * The root is resolved through `realpath` at construction because the comparison
 * would otherwise be wrong on two ordinary systems: macOS hands out `/var/…`
 * temporary directories that Git reports back as `/private/var/…`, and Windows
 * hands out short `~1` path forms. In both cases a textual prefix check would
 * declare this package's own worktree foreign and refuse to clean it up.
 */

export class WorktreeRootEscapeError extends Error {
  constructor(
    readonly requestedPath: string,
    readonly root: string,
  ) {
    super(`Path "${requestedPath}" resolves outside the verified worktree root "${root}".`);
    this.name = "WorktreeRootEscapeError";
  }
}

/** Raised for a root that cannot bound anything, as opposed to a path that escaped one. */
export class UnverifiableRootError extends Error {
  constructor(readonly requestedRoot: string) {
    super(`A verified worktree root must be an absolute path; "${requestedRoot}" is not.`);
    this.name = "UnverifiableRootError";
  }
}

/**
 * The spelling of a path this host's filesystem treats as canonical. Case is
 * folded on Windows and macOS, where two spellings of one name address one file
 * and a case-sensitive comparison would let a caller escape a containment check
 * by changing a letter.
 */
function canonical(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

/** Compares two absolute paths as the host's filesystem would. */
export function samePath(left: string, right: string): boolean {
  return canonical(left) === canonical(right);
}

export class VerifiedRoot {
  readonly path: string;

  /** `root` must already be absolute and symlink-resolved; use {@link createTemporaryRunRoot} to obtain one. */
  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new UnverifiableRootError(root);
    }
    this.path = path.resolve(root);
  }

  /**
   * Whether `candidate` lies strictly inside this root. The root itself is not
   * inside itself: a caller that meant the root names it directly, while a `..`
   * that happens to land back on the root is exactly the traversal this guard
   * exists to catch.
   *
   * The comparison is made in the host's canonical spelling, the same one
   * {@link samePath} uses, so a checkout is not judged foreign by one guard and
   * familiar by the other because of a difference in case.
   */
  contains(candidate: string): boolean {
    const relative = path.relative(canonical(this.path), canonical(candidate));
    if (relative === "" || path.isAbsolute(relative)) return false;
    const segments = relative.split(path.sep);
    return !segments.includes("..");
  }

  /** Resolves path segments under this root, throwing rather than clamping when they escape it. */
  resolve(...segments: readonly string[]): string {
    const resolved = path.resolve(this.path, ...segments);
    if (!this.contains(resolved)) {
      throw new WorktreeRootEscapeError(path.join(...segments), this.path);
    }
    return resolved;
  }

  /** Throws unless `candidate` is strictly inside this root. */
  assertContains(candidate: string): string {
    if (!this.contains(candidate)) {
      throw new WorktreeRootEscapeError(candidate, this.path);
    }
    return path.resolve(candidate);
  }
}

/** The prefix every directory this package creates in the temporary directory is named with. */
export const BENCHMARK_TEMPORARY_PREFIX = "ag-benchmark-";

/**
 * Creates a fresh, symlink-resolved run root under the operating system's
 * temporary directory.
 *
 * Deliberately outside the repository. Scratch checkouts inside it would appear
 * in `git status`, could be committed by a hook that stages broadly, and would
 * put a nested repository inside the very tree the benchmark is measuring.
 */
export async function createTemporaryRunRoot(label = "run"): Promise<VerifiedRoot> {
  const created = await mkdtemp(path.join(os.tmpdir(), `${BENCHMARK_TEMPORARY_PREFIX}${label}-`));
  return new VerifiedRoot(await realpath(created));
}

/**
 * Whether a path is a run root this package created — a directory named with the
 * benchmark prefix, directly inside the system temporary directory, once
 * symbolic links on both sides are resolved.
 *
 * Used immediately before a recursive removal. The class contract says a root is
 * verified; this asks the filesystem rather than trusting that, because a caller
 * that constructed a {@link VerifiedRoot} over the wrong directory would
 * otherwise have handed a recursive delete a target it can never take back.
 */
export async function isTemporaryRunRoot(candidate: string): Promise<boolean> {
  let resolved: string;
  let temporaryDirectory: string;
  try {
    resolved = await realpath(candidate);
    temporaryDirectory = await realpath(os.tmpdir());
  } catch {
    return false;
  }
  if (!path.basename(resolved).startsWith(BENCHMARK_TEMPORARY_PREFIX)) return false;
  return samePath(path.dirname(resolved), temporaryDirectory);
}
