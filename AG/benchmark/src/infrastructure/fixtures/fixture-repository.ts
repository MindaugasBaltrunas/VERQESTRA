import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { FIXTURE_ROOT } from "../../application/validate-suite.js";
import {
  BENCHMARK_PACKAGE_ROOT,
  resolveInsideBenchmarkWorkspace,
} from "../benchmark-workspace-paths.js";
import {
  describeThrown,
  execFileGitRunner,
  parseObjectId,
  runGit,
  type GitRunner,
} from "../git/git-runner.js";
import type { VerifiedRoot } from "../git/verified-root.js";

/**
 * The verified root a sample's worktrees branch off (BENCH-4).
 *
 * A fixture is a plain directory of files, not a repository, so there is nothing
 * to take a worktree of until one is made. This module makes it, and where it
 * makes it is the whole point: the fixture content is copied into the run's own
 * scratch root and initialised as a fresh repository there. The repository under
 * measurement is therefore never the repository the benchmark is running from —
 * no branch of it is created, no commit of it is made, and its `main` cannot
 * move because Git is never pointed at it.
 *
 * The copy is not a convenience either. Taking worktrees of the fixture in place
 * would let an agent's run mutate the checked-in fixture, and the next scenario
 * would then start from a state no scenario declared.
 */

/**
 * The branch a fixture repository's baseline lives on. Named for what it is
 * rather than `main` or `master`, so that anything reading a benchmark
 * repository can tell at a glance that it is not looking at a project's trunk.
 */
export const FIXTURE_BASE_BRANCH = "benchmark-base";

const FIXTURE_BASE_COMMIT_MESSAGE = "benchmark fixture baseline";

/**
 * Entries a fixture may contain on a developer's disk but that are not part of
 * what the fixture declares. `.git` in particular: copying one would nest a
 * repository inside the fixture repository and make every later Git command
 * ambiguous about which one it is addressing.
 */
const EXCLUDED_ENTRY_NAMES: ReadonlySet<string> = new Set([".git", "node_modules", "dist"]);

export class FixtureMaterializationError extends Error {
  constructor(
    readonly fixture: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Fixture "${fixture}" could not be materialized: ${reason}.`, options ?? {});
    this.name = "FixtureMaterializationError";
  }
}

/** A fixture, copied into the run root and turned into a repository with exactly one commit. */
export interface FixtureRepository {
  /** Suite-relative fixture directory, as the scenario declared it. */
  readonly fixture: string;
  /** Absolute repository root, inside the run's verified root. */
  readonly path: string;
  readonly baseBranch: string;
  /**
   * The commit every sample of this fixture starts from. A pure function of the
   * fixture's content: authorship and dates are pinned by the runner, so two
   * hosts materializing the same fixture agree on the id.
   */
  readonly baseCommit: string;
}

export interface FixtureRepositoryStoreOptions {
  readonly runner?: GitRunner;
  /** Root the fixture path is resolved against; defaults to this package. */
  readonly workspaceRoot?: string;
}

/**
 * Directory name for a fixture, derived from its suite-relative path rather than
 * chosen by it.
 *
 * The readable part is lossy — every character a path may hold that a directory
 * name should not is folded to a dash — so `fixtures/task-service` and
 * `fixtures/task/service` would land on the same name and the second fixture
 * would be copied on top of the first. The digest of the exact declared path is
 * what actually separates them; the slug is only there so a directory listing
 * can be read by a person.
 */
function repositoryDirectoryName(fixture: string): string {
  const slug = fixture.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  const digest = createHash("sha256").update(fixture, "utf8").digest("hex").slice(0, 12);
  return `${slug === "" ? "fixture" : slug}-${digest}`;
}

/**
 * Copies one directory tree, entry by entry, refusing anything that is not a
 * plain file or directory.
 *
 * `fs.cp` would be shorter and would also follow a symlink out of the workspace
 * or reproduce a device node. A fixture is data under review, so an entry that
 * is neither a file nor a directory is reported as a fixture defect rather than
 * copied and hoped about. Entries are visited in name order, which keeps a
 * failure reproducible.
 */
async function copyTree(fixture: string, source: string, target: string): Promise<number> {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  let copied = 0;
  for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (EXCLUDED_ENTRY_NAMES.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      throw new FixtureMaterializationError(
        fixture,
        `"${path.relative(source, from)}" is a symbolic link, which could resolve to a file outside the benchmark workspace`,
      );
    }
    if (entry.isDirectory()) {
      copied += await copyTree(fixture, from, to);
      continue;
    }
    if (!entry.isFile()) {
      throw new FixtureMaterializationError(
        fixture,
        `"${path.relative(source, from)}" is neither a file nor a directory`,
      );
    }
    await copyFile(from, to);
    copied += 1;
  }
  return copied;
}

/**
 * Materializes fixtures into repositories under one run root, at most once each.
 *
 * Caching is a correctness property, not an optimisation: every sample of a
 * scenario must start from the same commit, and materializing twice would give
 * two repositories whose worktrees could not be compared to each other.
 */
export class FixtureRepositoryStore {
  readonly #root: VerifiedRoot;
  readonly #runner: GitRunner;
  readonly #workspaceRoot: string;
  /** Promises rather than values: two concurrent requests must not both materialize. */
  readonly #repositories = new Map<string, Promise<FixtureRepository>>();
  /** Repositories that finished materializing, in the order they finished. */
  readonly #completed: string[] = [];

  constructor(root: VerifiedRoot, options: FixtureRepositoryStoreOptions = {}) {
    this.#root = root;
    this.#runner = options.runner ?? execFileGitRunner;
    this.#workspaceRoot = options.workspaceRoot ?? BENCHMARK_PACKAGE_ROOT;
  }

  /** Absolute paths of the repositories materialized so far, in materialization order. */
  get materialized(): readonly string[] {
    return [...this.#completed];
  }

  async materialize(fixture: string): Promise<FixtureRepository> {
    const existing = this.#repositories.get(fixture);
    if (existing !== undefined) return existing;
    const created = this.#materialize(fixture);
    this.#repositories.set(fixture, created);
    created.then(
      (repository) => this.#completed.push(repository.path),
      () => {
        // A failed materialization must not be cached: the next sample would be
        // refused for a fault that may have been transient, with no way to
        // retry. Only this attempt is forgotten — a retry that already started
        // owns the entry now.
        if (this.#repositories.get(fixture) === created) this.#repositories.delete(fixture);
      },
    );
    return created;
  }

  async #materialize(fixture: string): Promise<FixtureRepository> {
    const source = await this.#resolveFixture(fixture);
    const repositoryPath = this.#root.resolve("repos", repositoryDirectoryName(fixture));
    const copied = await copyTree(fixture, source, repositoryPath);
    if (copied === 0) {
      throw new FixtureMaterializationError(
        fixture,
        "it contains no files, so there is nothing for a scenario to start from",
      );
    }
    await this.#initialize(fixture, repositoryPath);
    return {
      fixture,
      path: repositoryPath,
      baseBranch: FIXTURE_BASE_BRANCH,
      baseCommit: await this.#baseCommit(repositoryPath),
    };
  }

  /**
   * Resolves the declared fixture inside the benchmark workspace and confirms it
   * is a directory under `fixtures/`.
   *
   * Three checks, in the order that makes a failure say what actually went
   * wrong. The textual resolution rejects `../../etc` and absolute paths; the
   * prefix check rejects a path that stays in the package but reaches its source
   * or its results; and then the whole thing is resolved again through
   * `realpath`, because the first two only examine the spelling. A fixture
   * directory that is itself a symbolic link — or that sits under one — passes
   * both textual checks while addressing anything on the host, and copying what
   * it points at is how a file from outside the workspace would end up committed
   * into a fixture repository and printed in a diff.
   */
  async #resolveFixture(fixture: string): Promise<string> {
    let declared: string;
    try {
      declared = resolveInsideBenchmarkWorkspace(fixture, this.#workspaceRoot);
    } catch (error) {
      throw new FixtureMaterializationError(
        fixture,
        "it resolves outside the benchmark workspace",
        { cause: error },
      );
    }
    if (!isUnderFixtureRoot(this.#workspaceRoot, declared)) {
      throw new FixtureMaterializationError(
        fixture,
        `fixtures live under "${FIXTURE_ROOT}/", and this path does not`,
      );
    }
    if (!(await isDirectory(declared))) {
      throw new FixtureMaterializationError(fixture, "no such directory exists");
    }

    const actual = await realpath(declared);
    if (!isUnderFixtureRoot(await realpath(path.resolve(this.#workspaceRoot)), actual)) {
      throw new FixtureMaterializationError(
        fixture,
        `it resolves through a symbolic link to "${actual}", which is outside "${FIXTURE_ROOT}/"`,
      );
    }
    return actual;
  }

  async #initialize(fixture: string, repositoryPath: string): Promise<void> {
    const at = { cwd: repositoryPath };
    try {
      await runGit(this.#runner, ["init"], at, "Initialising the fixture repository");
      // Naming the branch through `symbolic-ref` before the first commit rather
      // than through `init -b` keeps this working on Git versions that predate
      // that flag, and never depends on the host's `init.defaultBranch`.
      await runGit(
        this.#runner,
        ["symbolic-ref", "HEAD", `refs/heads/${FIXTURE_BASE_BRANCH}`],
        at,
        "Naming the fixture base branch",
      );
      await runGit(this.#runner, ["add", "--all"], at, "Staging the fixture baseline");
      await runGit(
        this.#runner,
        ["commit", "--message", FIXTURE_BASE_COMMIT_MESSAGE],
        at,
        "Committing the fixture baseline",
      );
    } catch (error) {
      throw new FixtureMaterializationError(fixture, describeThrown(error), { cause: error });
    }
  }

  async #baseCommit(repositoryPath: string): Promise<string> {
    const output = await runGit(
      this.#runner,
      ["rev-parse", "HEAD"],
      { cwd: repositoryPath },
      "Reading the fixture base commit",
    );
    return parseObjectId(output, "Reading the fixture base commit");
  }
}

/** Whether a path names an existing directory; used to report a missing fixture as a fixture problem. */
export async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `candidate` sits strictly under `root`'s fixture directory. */
function isUnderFixtureRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  if (relative === "" || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  return segments[0] === FIXTURE_ROOT && !segments.includes("..");
}
