import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import {
  UNAVAILABLE_TOOL_VERSION,
  type RunEnvironmentPort,
  type RunEnvironmentRecord,
  type ToolVersion,
} from "../application/run-environment.js";
import { redactSecrets } from "../application/secret-redaction.js";
import type { BenchmarkEnvironment } from "../domain/baseline.js";
import { BENCHMARK_PACKAGE_ROOT } from "./benchmark-workspace-paths.js";

/**
 * Host environment capture (BENCH-8).
 *
 * Two sources, kept apart because they fail differently. Platform, architecture,
 * Node version, core count and OS release come from the running process and
 * cannot fail. The Git commit and the tool versions come from external programs,
 * every one of which may be missing, slow or hostile, so each is bounded by a
 * timeout, reduced to its first line, redacted and capped in length. A tool that
 * does not answer is recorded as unavailable; it never aborts a run and never
 * produces a value that was not actually observed.
 *
 * The adapter reads exactly the facts it records. It does not enumerate
 * environment variables, the command line, the user or the host name: an
 * environment capture is written into a baseline file that is committed and
 * shared, and a credential reaches such a file through a well-meant "capture
 * everything" far more often than through an attack.
 */

/** A tool that has not answered within this is treated as unavailable. */
const COMMAND_TIMEOUT_MS = 5_000;

/** A version line is a version line; anything longer is output this package will not store. */
const MAX_CAPTURED_VALUE_LENGTH = 200;

/** Same shape BENCH-5 accepts for a stored commit: a full SHA-1 or SHA-256 object id. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Version reported by the package manager that launched this process, e.g. `pnpm/9.15.9 …`. */
const PACKAGE_MANAGER_USER_AGENT = /\bpnpm\/(\S+)/;

export interface CommandResult {
  /** False when the command was missing, failed, timed out or was killed. */
  readonly ok: boolean;
  readonly output: string;
}

export interface CommandOptions {
  readonly cwd?: string;
}

/**
 * The seam between this adapter and process execution. Injecting it keeps every
 * test deterministic: an environment capture that shells out is a test that
 * passes or fails according to what happens to be installed.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

const execFileAsync = promisify(execFile);

/**
 * Runs a program directly — no shell, so neither a command name nor an argument
 * can be reinterpreted as syntax. A failure of any kind is reported as
 * `ok: false` with no output, because for this adapter "git is not installed"
 * and "git exited 128" lead to the same recorded fact.
 *
 * A consequence worth stating: on Windows a `.cmd` shim (`pnpm`) cannot be
 * spawned without a shell, and this package will not open one to read a version
 * string. {@link HostEnvironmentAdapter} falls back to the launching package
 * manager's user agent for that case instead.
 */
export const execFileCommandRunner: CommandRunner = async (command, args, options) => {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return { ok: true, output: stdout };
  } catch {
    return { ok: false, output: "" };
  }
};

/**
 * Redaction before truncation: cutting first could split a token across the
 * boundary and leave a fragment no pattern recognises.
 */
function sanitize(value: string): string {
  return redactSecrets(value.trim()).slice(0, MAX_CAPTURED_VALUE_LENGTH);
}

function firstLine(output: string): string {
  return output.split(/\r?\n/, 1)[0] ?? "";
}

export interface HostEnvironmentOptions {
  readonly runner?: CommandRunner;
  /** Directory the Git commit is resolved from; defaults to this package. */
  readonly cwd?: string;
  /** Overrides `npm_config_user_agent`, which names the package manager that started the run. */
  readonly packageManagerUserAgent?: string;
}

export class HostEnvironmentAdapter implements RunEnvironmentPort {
  readonly #runner: CommandRunner;
  readonly #cwd: string;
  readonly #userAgent: string;

  constructor(options: HostEnvironmentOptions = {}) {
    this.#runner = options.runner ?? execFileCommandRunner;
    this.#cwd = options.cwd ?? BENCHMARK_PACKAGE_ROOT;
    this.#userAgent = options.packageManagerUserAgent ?? process.env["npm_config_user_agent"] ?? "";
  }

  async capture(): Promise<BenchmarkEnvironment> {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      // Reports what this process may actually use, which on a container is not
      // the machine's core count and is the number a duration should be read
      // against.
      cpuCount: os.availableParallelism(),
    };
  }

  async captureRunEnvironment(): Promise<RunEnvironmentRecord> {
    const [environment, agCommit, gitVersion, pnpmVersion] = await Promise.all([
      this.capture(),
      this.#captureCommit(),
      this.#captureToolVersion("git"),
      this.#capturePackageManagerVersion(),
    ]);
    // Fixed order rather than a sort: the list is a declared set of tools, so
    // two captures of the same host serialise identically without one.
    const toolVersions: readonly ToolVersion[] = [
      { tool: "git", version: gitVersion },
      { tool: "node", version: process.version },
      { tool: "pnpm", version: pnpmVersion },
    ];
    return {
      environment,
      osRelease: sanitize(`${os.type()} ${os.release()}`),
      agCommit,
      toolVersions,
    };
  }

  /**
   * The commit under measurement, or `""`. Output that is not a full object id
   * is discarded rather than stored: `git` reports its errors on stdout in some
   * configurations, and a baseline naming `fatal: not a git repository` as its
   * commit would compare equal to nothing and unequal to everything.
   */
  async #captureCommit(): Promise<string> {
    const result = await this.#runner("git", ["rev-parse", "HEAD"], { cwd: this.#cwd });
    if (!result.ok) return "";
    const candidate = firstLine(result.output).trim();
    return COMMIT_ID.test(candidate) ? candidate : "";
  }

  async #captureToolVersion(tool: string): Promise<string> {
    const result = await this.#runner(tool, ["--version"], { cwd: this.#cwd });
    if (!result.ok) return UNAVAILABLE_TOOL_VERSION;
    const version = sanitize(firstLine(result.output));
    return version === "" ? UNAVAILABLE_TOOL_VERSION : version;
  }

  /**
   * pnpm, with the launcher's user agent as a fallback. On Windows the shim is a
   * `.cmd` file that cannot be executed without a shell, so on the platform this
   * repository is developed on the spawn always fails while
   * `npm_config_user_agent` — set by the very pnpm that started the run — states
   * the answer exactly.
   */
  async #capturePackageManagerVersion(): Promise<string> {
    const spawned = await this.#captureToolVersion("pnpm");
    if (spawned !== UNAVAILABLE_TOOL_VERSION) return spawned;
    const match = PACKAGE_MANAGER_USER_AGENT.exec(this.#userAgent);
    const declared = match === null ? "" : sanitize(match[1] ?? "");
    return declared === "" ? UNAVAILABLE_TOOL_VERSION : declared;
  }
}
