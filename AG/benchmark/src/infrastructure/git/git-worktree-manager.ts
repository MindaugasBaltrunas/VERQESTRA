import { rm } from "node:fs/promises";

import type {
  IsolatedCleanupOutcome,
  IsolatedWorkspaceCapture,
  IsolatedWorkspacePort,
} from "../../application/run/isolated-run-record.js";
import { redactSecrets } from "../../application/secret-redaction.js";
import type { WorktreeCleanupResult } from "../../domain/result.js";
import type {
  IsolatedWorktree,
  IsolatedWorktreeRequest,
} from "../../application/ports/worktree-port.js";
import {
  FixtureRepositoryStore,
  isDirectory,
  type FixtureRepository,
  type FixtureRepositoryStoreOptions,
} from "../fixtures/fixture-repository.js";
import {
  describeThrown,
  execFileGitRunner,
  parseObjectId,
  runGit,
  splitNulSeparated,
  type GitCommandOptions,
  type GitRunner,
} from "./git-runner.js";
import {
  createTemporaryRunRoot,
  isTemporaryRunRoot,
  samePath,
  VerifiedRoot,
  WorktreeRootEscapeError,
} from "./verified-root.js";

/**
 * One Git worktree per sample (BENCH-4).
 *
 * Isolation here is layered, and each layer answers a different way for a run to
 * contaminate another:
 *
 * 1. **A per-run root.** Every checkout of a run lives under one verified
 *    directory outside the repository under measurement.
 * 2. **A per-fixture repository.** Fixtures are materialized into that root as
 *    fresh repositories, so no branch is ever created in, and no commit ever
 *    added to, the repository the benchmark itself runs from.
 * 3. **A per-sample worktree and branch.** Each sample gets its own checkout on
 *    its own branch off the fixture's base commit. The base branch is never
 *    checked out and never moves, so one sample's work cannot become another's
 *    starting state.
 *
 * Cleanup is where the guarantees are actually spent, and it is deliberately
 * timid. It removes only a checkout this manager created, only while that
 * checkout still lies inside the verified root, only while Git still lists it as
 * belonging to the fixture repository, and only when it is clean. Anything else
 * is reported and left alone. A force removal would resolve all four cases at
 * once, which is precisely why BENCH-4 forbids it: the situations where cleanup
 * is unsure are the situations where the thing it would delete is someone's
 * evidence.
 */

/** Branch names are `benchmark/<run>/<sample>`, so every branch a run makes is visible as a group. */
export const BENCHMARK_BRANCH_NAMESPACE = "benchmark";

/**
 * Run and scenario ids reach Git as a branch name and a directory name. Bounding
 * them to lowercase kebab-case keeps both meanings safe at once: no traversal,
 * no leading dash that Git would read as an option, and nothing that changes
 * meaning on a case-insensitive filesystem.
 */
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Recorded diff text is bounded; `changedFiles` stays complete regardless. */
export const MAX_DIFF_CHARACTERS = 256 * 1024;

/**
 * Toolchain paths the measured diff never describes.
 *
 * 2026-08-22, first paid `ag-loop` run: 45 % of the cells were discarded with
 * `stdout maxBuffer length exceeded`. The cause was not the buffer. The execution agent
 * provisions its own Python runtime into the process working directory — the scenario
 * checkout — and `capture` commits whatever the cell left behind, so a 36 MB archive landed
 * inside the sample's diff. The cells that did survive were no better: their `outOfScopeFiles`
 * described a toolchain, not an executed change.
 *
 * The exclusion belongs here, in the measuring instrument, rather than in a hope that every
 * host tool will keep its files to itself.
 *
 * ## Why this list stays SHORT
 *
 * This same diff is the scope gate (BENCH-4): a path excluded here is invisible to
 * `outOfScopeFiles`, so an agent writing there would not be caught. That is acceptable only for
 * paths no scenario can legitimately name — a language runtime, an installed dependency tree,
 * an agent's own configuration. A wildcard here would quietly turn the scope gate off, so every
 * new entry needs the same argument: *the fixture could never be asked to change this.*
 */
export const TOOLCHAIN_EXCLUDED_PATHS = ["Python", "node_modules", ".venv", "__pycache__", ".claude"] as const;

/**
 * The harness's own bookkeeping, for the same reason and by the same test.
 *
 * The `ag-loop` mode runs a real orchestrator inside the scenario checkout, and an orchestrator
 * keeps a runtime: the task it was handed, the spec change it was pointed at, its state, ledgers,
 * logs and supervisor decisions. None of that is the agent's answer to the scenario — it is the
 * instrument writing in its own notebook, in a checkout it happens to share with the fixture.
 *
 * 2026-08-22 pilot: every `ag-loop` cell was rejected with `out-of-scope-change`, and all 26
 * offending paths were these. Not one of them was produced by an agent editing the fixture. Left
 * in, the scope gate would report a structural `acceptedRate` of zero for exactly one mode, and
 * the comparison the benchmark exists for would be a comparison of that artefact.
 *
 * The list passes the test the block above sets, checked against the frozen suite: no scenario
 * names a path under `AG/`, `vq/` or `.claude` in `allowedPaths` or `forbiddenPaths` — every
 * declared prefix is `src`, `test`, `docs`, `README.md` or `CHANGELOG.md`. A fixture could not be
 * asked to change these, so excluding them takes nothing away from the gate.
 */
export const HARNESS_EXCLUDED_PATHS = ["AG", "vq"] as const;

/** `-- . ':(exclude)<path>' …` — the pathspec both diff reads are scoped by. */
const measuredPathspec = (): string[] => [
  "--",
  ".",
  ...TOOLCHAIN_EXCLUDED_PATHS.map((path) => `:(exclude)${path}`),
  ...HARNESS_EXCLUDED_PATHS.map((path) => `:(exclude)${path}`),
];

export class UnsafeIdentifierError extends Error {
  constructor(kind: string, value: string) {
    super(
      `The ${kind} "${value}" is not a lowercase kebab-case identifier, so it cannot be used as a branch or directory name.`,
    );
    this.name = "UnsafeIdentifierError";
  }
}

function assertSafeIdentifier(kind: string, value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new UnsafeIdentifierError(kind, value);
  return value;
}

/** A checkout this manager created, with everything cleanup has to verify against. */
interface WorktreeEntry {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly repository: FixtureRepository;
  readonly startCommit: string;
}

/** A checkout that outlived the run that made it, as {@link GitWorktreeManager.reclaimAbandoned} reports it. */
export interface AbandonedWorktree {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly repositoryPath: string;
  /** Whether the directory is still on disk. */
  readonly exists: boolean;
  /** Whether Git still lists it as a worktree of its fixture repository. */
  readonly registered: boolean;
}

export interface RunRootDisposal {
  readonly removed: boolean;
  /** `<code>: <detail>`; empty only when the run root was removed. */
  readonly reason: string;
}

export interface GitWorktreeManagerOptions extends FixtureRepositoryStoreOptions {
  /** Shared with the fixture store unless one is supplied. */
  readonly fixtures?: FixtureRepositoryStore;
  /**
   * Whether {@link GitWorktreeManager.dispose} may remove the run root. Only a
   * manager that created the root sets this; a caller-supplied directory is
   * never deleted by a class that was merely pointed at it.
   */
  readonly ownsRunRoot?: boolean;
}

export class GitWorktreeManager implements IsolatedWorkspacePort {
  readonly #runId: string;
  readonly #root: VerifiedRoot;
  readonly #runner: GitRunner;
  readonly #fixtures: FixtureRepositoryStore;
  readonly #ownsRunRoot: boolean;
  readonly #entries = new Map<string, WorktreeEntry>();
  #created = 0;

  constructor(runId: string, root: VerifiedRoot, options: GitWorktreeManagerOptions = {}) {
    this.#runId = assertSafeIdentifier("run id", runId);
    this.#root = root;
    this.#runner = options.runner ?? execFileGitRunner;
    this.#fixtures =
      options.fixtures ??
      new FixtureRepositoryStore(root, {
        runner: this.#runner,
        ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
      });
    this.#ownsRunRoot = options.ownsRunRoot ?? false;
  }

  /** The verified root every checkout of this run lives under. */
  get runRoot(): string {
    return this.#root.path;
  }

  /** Checkouts this manager created and has not removed, in creation order. */
  get openWorktrees(): readonly IsolatedWorktree[] {
    return [...this.#entries.values()].map((entry) => ({
      id: entry.id,
      path: entry.path,
      startCommit: entry.startCommit,
    }));
  }

  async create(request: IsolatedWorktreeRequest): Promise<IsolatedWorktree> {
    const scenarioId = assertSafeIdentifier("scenario id", request.scenarioId);
    const repository = await this.#fixtures.materialize(request.fixturePath);

    this.#created += 1;
    const id = `${scenarioId}-${String(this.#created).padStart(4, "0")}`;
    const branch = `${BENCHMARK_BRANCH_NAMESPACE}/${this.#runId}/${id}`;
    const worktreePath = this.#root.resolve("worktrees", id);

    await runGit(
      this.#runner,
      // `-b` creates the sample's own branch at the fixture's base commit. The
      // base branch is neither named nor checked out, so it cannot be moved.
      ["worktree", "add", "-b", branch, worktreePath, repository.baseCommit],
      { cwd: repository.path },
      `Creating an isolated worktree for scenario "${scenarioId}"`,
    );

    this.#entries.set(id, {
      id,
      path: worktreePath,
      branch,
      repository,
      startCommit: repository.baseCommit,
    });
    return { id, path: worktreePath, startCommit: repository.baseCommit };
  }

  /**
   * The published port's read-shaped view of {@link capture}. It carries that
   * method's write: reaching an end commit means committing what the execution
   * left behind, and there is no meaningful object id to report without doing
   * so. Callers that want the full evidence should use `capture` directly.
   */
  async changedFiles(worktree: IsolatedWorktree): Promise<{
    readonly endCommit: string;
    readonly changedFiles: readonly string[];
  }> {
    const capture = await this.capture(worktree);
    return { endCommit: capture.finalCommit, changedFiles: capture.changedFiles };
  }

  async capture(worktree: IsolatedWorktree): Promise<IsolatedWorkspaceCapture> {
    const entry = this.#requireEntry(worktree);
    const at: GitCommandOptions = { cwd: entry.path };

    // Whatever the execution left behind is committed onto the sample's own
    // branch. That is what makes a final commit id meaningful — an uncommitted
    // working tree has no object id to record — and it is also what lets cleanup
    // remove the checkout later without a force operation.
    if ((await this.#workingTreeEntries(entry.path)).length > 0) {
      await runGit(this.#runner, ["add", "--all"], at, "Staging the executed change");
      await runGit(
        this.#runner,
        ["commit", "--message", `benchmark sample ${entry.id}`],
        at,
        "Committing the executed change",
      );
    }

    const finalCommit = parseObjectId(
      await runGit(this.#runner, ["rev-parse", "HEAD"], at, "Reading the final commit"),
      "Reading the final commit",
    );
    if (finalCommit === entry.startCommit) {
      return {
        baseCommit: entry.startCommit,
        finalCommit,
        changedFiles: [],
        diff: { text: "", truncated: false, byteLength: 0 },
      };
    }

    // `--no-renames` keeps a rename visible as the removal and the addition it
    // is. Scope is decided per path, and a scenario that forbids a directory is
    // violated by a file arriving there however it got there.
    const names = await runGit(
      this.#runner,
      ["diff", "--no-renames", "--name-only", "-z", entry.startCommit, finalCommit, ...measuredPathspec()],
      at,
      "Listing the changed files",
    );
    const raw = await runGit(
      this.#runner,
      ["diff", "--no-renames", entry.startCommit, finalCommit, ...measuredPathspec()],
      at,
      "Reading the executed diff",
    );
    return {
      baseCommit: entry.startCommit,
      finalCommit,
      changedFiles: [...splitNulSeparated(names)].sort(),
      diff: boundDiff(raw),
    };
  }

  /** {@link IsolatedWorkspacePort.cleanupIsolated} without the reason, for the published port. */
  async cleanup(worktree: IsolatedWorktree): Promise<WorktreeCleanupResult> {
    return (await this.cleanupIsolated(worktree)).result;
  }

  async cleanupIsolated(worktree: IsolatedWorktree): Promise<IsolatedCleanupOutcome> {
    const entry = this.#entries.get(worktree.id);
    if (entry === undefined) {
      return refused(
        "unknown-worktree",
        `"${worktree.id}" was not created by this run, so nothing was removed`,
      );
    }
    if (!samePath(entry.path, worktree.path)) {
      return refused(
        "path-mismatch",
        `"${worktree.id}" was created at "${entry.path}" but cleanup was asked for "${worktree.path}"`,
      );
    }
    try {
      this.#root.assertContains(entry.path);
    } catch (error) {
      if (!(error instanceof WorktreeRootEscapeError)) throw error;
      return refused("outside-verified-root", error.message);
    }

    // A checkout whose directory is already gone needs no removal, only for Git
    // to stop listing it. Without this the entry would be refused as
    // `not-registered` forever and would block disposal of the run root, which
    // is a leak dressed up as caution.
    if (!(await isDirectory(entry.path))) {
      await this.#runner(["worktree", "prune"], { cwd: entry.repository.path });
      this.#entries.delete(entry.id);
      return { result: "removed", reason: "" };
    }

    const registered = await this.#registeredWorktrees(entry.repository.path);
    if (!registered.some((candidate) => samePath(candidate, entry.path))) {
      return refused(
        "not-registered",
        `Git no longer lists "${entry.path}" as a worktree of "${entry.repository.path}"`,
      );
    }

    let remaining: readonly string[];
    try {
      remaining = await this.#workingTreeEntries(entry.path);
    } catch (error) {
      return refused("unreadable-worktree", describeThrown(error));
    }
    if (remaining.length > 0) {
      return {
        result: "kept-for-diagnosis",
        reason: `dirty-worktree: ${remaining.length} uncommitted status entr${
          remaining.length === 1 ? "y" : "ies"
        } remain at "${entry.path}"; removing it would need a force operation`,
      };
    }

    const removal = await this.#runner(["worktree", "remove", entry.path], {
      cwd: entry.repository.path,
    });
    if (!removal.ok) {
      return refused("removal-refused", removal.stderr.trim());
    }
    this.#entries.delete(entry.id);
    // The sample's branch stays in the fixture repository. Deleting an unmerged
    // branch needs `git branch -D`, a force operation; the whole repository is
    // scratch and goes with the run root instead.
    return { result: "removed", reason: "" };
  }

  /**
   * The checkouts of *this run* that have not been cleaned up — what an
   * interrupted execution leaves for someone to look at.
   *
   * `worktree prune` runs first, which drops Git's registration for directories
   * that are already gone and never touches one that is still there. What comes
   * back is therefore the real remainder, each with the branch and repository
   * needed to inspect it.
   *
   * Scope worth stating: this reads the manager's own registry, so it reports
   * what the current process created. Checkouts left by a process that died
   * outright are found by their run root, which is where a future
   * cross-process reclaim would have to start.
   */
  async reclaimAbandoned(): Promise<readonly AbandonedWorktree[]> {
    const repositories = new Map<string, FixtureRepository>();
    for (const entry of this.#entries.values()) {
      repositories.set(entry.repository.path, entry.repository);
    }
    for (const repository of repositories.values()) {
      await this.#runner(["worktree", "prune"], { cwd: repository.path });
    }

    const abandoned: AbandonedWorktree[] = [];
    for (const entry of [...this.#entries.values()].sort((left, right) =>
      left.id < right.id ? -1 : 1,
    )) {
      const registered = await this.#registeredWorktrees(entry.repository.path);
      abandoned.push({
        id: entry.id,
        path: entry.path,
        branch: entry.branch,
        repositoryPath: entry.repository.path,
        exists: await isDirectory(entry.path),
        registered: registered.some((candidate) => samePath(candidate, entry.path)),
      });
    }
    return abandoned;
  }

  /**
   * Removes the run root, but only once nothing is being kept in it. A run that
   * crashed leaves its checkouts behind on purpose, and a disposal that ignored
   * that would delete the evidence the crash path went out of its way to save.
   */
  async dispose(): Promise<RunRootDisposal> {
    if (!this.#ownsRunRoot) {
      return {
        removed: false,
        reason: `not-owned: the run root "${this.#root.path}" was supplied by the caller and is theirs to remove`,
      };
    }
    if (this.#entries.size > 0) {
      return {
        removed: false,
        reason: `evidence-kept: ${this.#entries.size} worktree(s) under "${this.#root.path}" have not been cleaned up`,
      };
    }
    // The class contract says the root was verified; this asks the filesystem
    // instead of trusting it. `ownsRunRoot` is a public option, so a caller that
    // constructed a root over the wrong directory would otherwise have handed a
    // recursive delete a target that cannot be taken back.
    if (!(await isTemporaryRunRoot(this.#root.path))) {
      return {
        removed: false,
        reason: `unverified-root: "${this.#root.path}" is not a benchmark run root inside the system temporary directory`,
      };
    }
    await rm(this.#root.path, { recursive: true, force: true });
    return { removed: true, reason: "" };
  }

  /** The entry a checkout belongs to, refusing anything this manager did not create. */
  #requireEntry(worktree: IsolatedWorktree): WorktreeEntry {
    const entry = this.#entries.get(worktree.id);
    if (entry === undefined || !samePath(entry.path, worktree.path)) {
      throw new WorktreeRootEscapeError(worktree.path, this.#root.path);
    }
    return entry;
  }

  /** Uncommitted paths, including untracked ones. Empty means the checkout is clean. */
  async #workingTreeEntries(worktreePath: string): Promise<readonly string[]> {
    const output = await runGit(
      this.#runner,
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      { cwd: worktreePath },
      "Reading the worktree status",
    );
    // `-z` terminates each entry with NUL and, for a rename, follows it with the
    // original path as a separate field. Both are paths, and cleanup only counts
    // them, so no further parsing is needed here.
    return splitNulSeparated(output);
  }

  /** Absolute paths Git currently lists as worktrees of `repositoryPath`. */
  async #registeredWorktrees(repositoryPath: string): Promise<readonly string[]> {
    const result = await this.#runner(["worktree", "list", "--porcelain"], {
      cwd: repositoryPath,
    });
    if (!result.ok) return [];
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  }
}

function refused(code: string, detail: string): IsolatedCleanupOutcome {
  return { result: "failed", reason: `${code}: ${detail}` };
}

/**
 * Redacts and bounds a diff. Redaction runs before truncation, so a credential
 * cannot survive by sitting across the cut; `byteLength` reports the size Git
 * produced, which is what tells a reader how much was left out.
 *
 * The cut is pulled back off a lone high surrogate. Slicing between the halves
 * of an astral character would leave an unpaired code unit, and the record this
 * text ends up in is a JSON Lines file — one malformed character there is a line
 * the ledger's reader reports as corrupt.
 */
function boundDiff(raw: string): IsolatedWorkspaceCapture["diff"] {
  const byteLength = Buffer.byteLength(raw, "utf8");
  const redacted = redactSecrets(raw);
  if (redacted.length <= MAX_DIFF_CHARACTERS) {
    return { text: redacted, truncated: false, byteLength };
  }
  const cut = redacted.slice(0, MAX_DIFF_CHARACTERS);
  const last = cut.charCodeAt(cut.length - 1);
  const whole = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return { text: whole, truncated: true, byteLength };
}

/**
 * A manager with a temporary run root of its own, which it may also remove.
 * The ordinary entry point: a caller that has not already decided where scratch
 * checkouts belong should not have to.
 */
export async function createGitWorktreeManager(
  runId: string,
  options: GitWorktreeManagerOptions = {},
): Promise<GitWorktreeManager> {
  // Validated before anything is created: the id becomes a directory name, and a
  // rejected run must not leave a directory behind that names it.
  assertSafeIdentifier("run id", runId);
  const root = await createTemporaryRunRoot(runId);
  return new GitWorktreeManager(runId, root, { ...options, ownsRunRoot: true });
}
