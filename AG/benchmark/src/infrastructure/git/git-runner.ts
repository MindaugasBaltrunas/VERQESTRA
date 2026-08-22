import { execFile, type ExecFileException } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { redactSecrets } from "../../application/secret-redaction.js";

/**
 * The single seam through which this package executes Git (BENCH-4).
 *
 * Every Git invocation the benchmark makes goes through here, which is what
 * makes three properties checkable in one place rather than argued about per
 * call site:
 *
 * - **No shell.** The program is spawned directly, so neither a scenario id, a
 *   fixture name nor a path can be reinterpreted as syntax. Scenario data is
 *   input to a benchmark, and a benchmark that lets its input choose commands is
 *   measuring the wrong thing.
 * - **An allowlist, not a denylist.** Only the subcommands this package needs
 *   can be issued, and no force argument can be issued at all. A runner that
 *   merely refused `reset --hard` today would permit whatever destructive verb
 *   were added tomorrow; refusing everything not named here keeps the blast
 *   radius equal to the feature.
 * - **A hermetic configuration.** System and global Git configuration are
 *   switched off and identity, dates and line-ending handling are supplied
 *   explicitly. Otherwise the host's `core.autocrlf`, `core.hooksPath` or commit
 *   signing would silently change what a fixture repository contains, and two
 *   machines would compute different object ids for identical fixture content —
 *   which BENCH-8 reads as two incomparable baselines.
 */

export interface GitCommandResult {
  /** False when Git exited non-zero, was killed, or could not be spawned at all. */
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  /** Redacted: Git echoes remote URLs, and a URL can carry a credential. */
  readonly stderr: string;
}

export interface GitCommandOptions {
  /** Absolute working directory. Git resolves the repository from it, so it is required, never defaulted. */
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export type GitRunner = (
  args: readonly string[],
  options: GitCommandOptions,
) => Promise<GitCommandResult>;

/** A Git command that has not answered within this is killed; a hung clone must not hang a suite. */
export const GIT_COMMAND_TIMEOUT_MS = 120_000;

/** A diff of a fixture-sized change fits easily; anything past this is refused rather than buffered. */
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Everything the worktree runner needs, and nothing else. `push`, `remote`,
 * `clean`, `reset`, `checkout` and `clone` are absent on purpose: the runner
 * operates on a throwaway repository it created itself and has no reason to
 * reach a network or to discard a working tree.
 */
export const ALLOWED_GIT_SUBCOMMANDS = [
  "init",
  "symbolic-ref",
  "add",
  "commit",
  "rev-parse",
  "status",
  "diff",
  "worktree",
  "log",
] as const;

export type AllowedGitSubcommand = (typeof ALLOWED_GIT_SUBCOMMANDS)[number];

/**
 * Arguments that turn a refusal into a deletion. BENCH-4 forbids force
 * operations outright, so they are rejected before a process is spawned rather
 * than being trusted not to be passed.
 */
const FORBIDDEN_GIT_ARGUMENTS = new Set(["--hard", "--force-with-lease", "--force-if-includes"]);

/** Raised for a command this package will not issue. Never a Git failure — a refusal to ask. */
export class GitCommandRefusedError extends Error {
  constructor(
    readonly args: readonly string[],
    reason: string,
  ) {
    super(`Refused to run "git ${args.join(" ")}": ${reason}.`);
    this.name = "GitCommandRefusedError";
  }
}

/** Raised when Git ran and failed. Carries the result so a caller can classify it. */
export class GitCommandError extends Error {
  constructor(
    readonly purpose: string,
    readonly args: readonly string[],
    readonly result: GitCommandResult,
  ) {
    const status =
      result.signal !== null
        ? `was killed by ${result.signal}`
        : `exited ${result.exitCode === null ? "without a status" : result.exitCode}`;
    super(
      `${purpose} failed: "git ${args.join(" ")}" ${status}${
        result.stderr === "" ? "" : `: ${result.stderr}`
      }`,
    );
    this.name = "GitCommandError";
  }
}

/**
 * A cluster of short options carrying `f` or `D`.
 *
 * Git's option parser expands `-ff` into `-f -f` and `-fq` into `-f -q`, so a
 * check against the exact spellings above would let `git worktree remove -ff`
 * through — a force removal written so that it does not look like one. Every
 * short cluster containing either letter is refused instead; none of the
 * commands this package issues uses one.
 */
const FORCE_SHORT_OPTION_CLUSTER = /^-[A-Za-z]*[fD]/;

/**
 * Rejects any command outside the allowlist, any force argument and any
 * argument carrying a NUL byte — the one character that could split a single
 * argument into two once it reaches the operating system.
 */
export function assertSafeGitArguments(args: readonly string[]): void {
  if (args.length === 0) {
    throw new GitCommandRefusedError(args, "no subcommand was given");
  }
  for (const argument of args) {
    // A runtime check rather than a type one: this function is the guard a
    // JavaScript consumer of the published package reaches too.
    if (typeof argument !== "string") {
      throw new GitCommandRefusedError(args, "an argument is not a string");
    }
    if (argument.includes("\0")) {
      throw new GitCommandRefusedError(args, "an argument carries a NUL byte");
    }
    const forced = argument.startsWith("--")
      ? FORBIDDEN_GIT_ARGUMENTS.has(argument) || argument.startsWith("--force")
      : FORCE_SHORT_OPTION_CLUSTER.test(argument);
    if (forced) {
      throw new GitCommandRefusedError(
        args,
        `"${argument}" is a force operation, which BENCH-4 forbids`,
      );
    }
  }
  const subcommand = args[0];
  if (!(ALLOWED_GIT_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new GitCommandRefusedError(
      args,
      `"${subcommand}" is not one of the allowed subcommands (${ALLOWED_GIT_SUBCOMMANDS.join(", ")})`,
    );
  }
}

/** The identity every benchmark commit is authored under; never the host user's. */
export const BENCHMARK_COMMIT_IDENTITY = {
  name: "AG Benchmark Runner",
  email: "benchmark@ag-loop.invalid",
} as const;

/**
 * A fixed authorship date, in Git's raw format.
 *
 * A commit id is a hash of its tree, parents, message *and* dates, so a
 * wall-clock date would give the same fixture content a different base commit on
 * every run. Pinning it makes the base commit a pure function of what the
 * fixture holds, which is what lets two runs on two machines agree that they
 * started from the same state. Elapsed time is measured by the runner and
 * recorded as a duration; it is never read back out of a commit.
 */
export const BENCHMARK_COMMIT_DATE = "1577836800 +0000";

/**
 * A private directory holding the paths Git is pointed at instead of the host's
 * configuration and hooks.
 *
 * Neither path is ever created: Git reads a missing configuration file as an
 * empty one and a missing hooks directory as no hooks at all, which is what is
 * wanted. What matters is *where* they are missing. A fixed name directly in the
 * shared temporary directory could be created by any other local user before
 * this process looks — and a `.gitconfig` under someone else's control means
 * `core.pager`, `core.sshCommand` or `diff.external` running as this process.
 * `mkdtemp` gives a directory only this user can write, so the absent files stay
 * absent.
 *
 * Created on first use rather than at import, so merely loading this module does
 * not touch the filesystem, and removed when the process exits.
 */
let privateGitHome: string | undefined;

function gitHome(): string {
  if (privateGitHome === undefined) {
    const created = mkdtempSync(path.join(os.tmpdir(), "ag-benchmark-git-"));
    privateGitHome = created;
    process.once("exit", () => {
      try {
        rmSync(created, { recursive: true, force: true });
      } catch {
        // Exit-time cleanup is best effort: a temporary directory that outlives
        // the process is untidy, and throwing here would be worse.
      }
    });
  }
  return privateGitHome;
}

/** Configuration supplied per invocation, so no host setting can change the result. */
function hermeticConfigArguments(): readonly string[] {
  return [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    // Windows path length is a property of the host, not of the fixture.
    "-c",
    "core.longpaths=true",
    // Hooks are disabled outright. The commit this package makes to record a
    // sample happens *after* an agent has written freely into the worktree, and
    // the worktree shares its `.git/hooks` with the fixture repository — so a
    // hook left behind there would be an agent's code running in the harness,
    // after the agent's own execution window has closed.
    "-c",
    `core.hooksPath=${path.join(gitHome(), "absent-hooks")}`,
    // A signing key the host happens to configure would make a commit fail here
    // and succeed elsewhere.
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    `user.name=${BENCHMARK_COMMIT_IDENTITY.name}`,
    "-c",
    `user.email=${BENCHMARK_COMMIT_IDENTITY.email}`,
  ];
}

/**
 * The process environment with every inherited `GIT_*` variable removed and this
 * package's own set put back.
 *
 * Removal is by prefix rather than by name. A list of known-dangerous variables
 * would have to stay complete against Git's, and the ones that matter most are
 * the least famous: `GIT_CONFIG_PARAMETERS` is equivalent to an arbitrary `-c`
 * and would undo every setting above, `GIT_EXTERNAL_DIFF` and `GIT_TEMPLATE_DIR`
 * are code execution, `GIT_DIR` redirects the whole operation at another
 * repository. Dropping the prefix wholesale removes the class rather than the
 * examples.
 */
function hermeticEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase().startsWith("GIT_")) delete environment[name];
  }
  const absentConfig = path.join(gitHome(), "absent-gitconfig");
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: absentConfig,
    GIT_CONFIG_GLOBAL: absentConfig,
    GIT_ATTR_NOSYSTEM: "1",
    // Nothing here may block on a human: a credential prompt in a benchmark is a
    // hang, and a hang is indistinguishable from a slow agent.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: BENCHMARK_COMMIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: BENCHMARK_COMMIT_IDENTITY.email,
    GIT_AUTHOR_DATE: BENCHMARK_COMMIT_DATE,
    GIT_COMMITTER_NAME: BENCHMARK_COMMIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: BENCHMARK_COMMIT_IDENTITY.email,
    GIT_COMMITTER_DATE: BENCHMARK_COMMIT_DATE,
    // Stable message text, so a diagnosis reads the same in every locale.
    LC_ALL: "C",
  };
}

/**
 * Spawns Git directly. A refused command throws before anything is spawned; a
 * command that ran and failed is reported as `ok: false` with its output, since
 * "the worktree is dirty" and "the repository does not exist" are outcomes the
 * caller classifies rather than errors it cannot act on.
 */
export const execFileGitRunner: GitRunner = async (args, options) => {
  assertSafeGitArguments(args);
  return new Promise<GitCommandResult>((resolve) => {
    execFile(
      "git",
      [...hermeticConfigArguments(), ...args],
      {
        cwd: options.cwd,
        env: hermeticEnvironment(),
        timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const safeStderr = redactSecrets(stderr);
        if (error === null) {
          resolve({ ok: true, exitCode: 0, signal: null, stdout, stderr: safeStderr });
          return;
        }
        const failure = error as ExecFileException;
        resolve({
          ok: false,
          exitCode: typeof failure.code === "number" ? failure.code : null,
          signal: failure.signal ?? null,
          stdout,
          // A spawn failure (`git` missing, `ENOENT`) reports nothing on stderr;
          // the exception message is then the only description of what happened.
          stderr: safeStderr === "" ? redactSecrets(failure.message) : safeStderr,
        });
      },
    );
  });
};

/** Runs a command that must succeed and returns its stdout. */
export async function runGit(
  runner: GitRunner,
  args: readonly string[],
  options: GitCommandOptions,
  purpose: string,
): Promise<string> {
  const result = await runner(args, options);
  if (!result.ok) throw new GitCommandError(purpose, args, result);
  return result.stdout;
}

/**
 * A redacted description of a thrown value, safe to build inside a `catch`.
 *
 * `(error as Error).message` is the usual shorthand and it is wrong precisely
 * where it matters: a value thrown that is not an `Error` leaves `message`
 * `undefined`, and the redaction that follows would then throw from inside a
 * handler whose entire contract is that it does not.
 */
export function describeThrown(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Splits `-z` output, which terminates every field with NUL rather than separating with newlines. */
export function splitNulSeparated(output: string): readonly string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

/** A full SHA-1 or SHA-256 object id, as BENCH-5 stores it. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Reads a commit id from `rev-parse` output, refusing anything that is not one.
 * Git reports some errors on stdout, and recording `fatal: …` as a base commit
 * would produce a sample that compares equal to nothing and unequal to
 * everything.
 */
export function parseObjectId(output: string, purpose: string): string {
  const candidate = output.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!OBJECT_ID.test(candidate)) {
    // The rejected value is quoted back because it is usually the explanation,
    // and redacted because it is output this package did not author.
    throw new Error(
      `${purpose} did not report a commit id: "${redactSecrets(candidate).slice(0, 120)}"`,
    );
  }
  return candidate;
}
