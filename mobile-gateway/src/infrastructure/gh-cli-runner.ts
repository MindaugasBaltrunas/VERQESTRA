import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Host execution of the GitHub CLI.
 *
 * Three properties are deliberate and are asserted by the contract tests:
 *
 * - **No shell, ever.** Every call is one `execFile` with a host-fixed argument
 *   vector. Nothing a client sends becomes a command line, so an untrusted
 *   phrase — a voice transcription included — has nowhere to become one.
 * - **Non-interactive by construction.** The child inherits no writable input
 *   channel from the gateway, so a CLI that decides to prompt simply blocks and
 *   is reaped by the timeout below. That is the intended outcome: a prompt is a
 *   failure to answer, never something the gateway tries to satisfy.
 * - **Credentials are inherited, never read.** The environment is passed through
 *   with only the non-interactive overrides applied; no code here — or in the
 *   adapter above it — indexes a token variable, so a credential cannot be
 *   copied into a result, a log or an error message.
 */

/** Result of one GitHub CLI invocation. `stdout`/`stderr` stay inside the adapter. */
export type GhCliResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * The process never ran because the executable does not exist. Negative codes
 * cannot collide with a real exit status, which is 0-255 on every supported
 * host, so the caller can tell "not installed" from "said no".
 */
export const GH_CLI_NOT_INSTALLED = -2;

/** The process could not run to completion: spawn failure, timeout or signal. */
export const GH_CLI_UNAVAILABLE = -1;

export type GhCliRunner = (args: readonly string[]) => Promise<GhCliResult>;

/** Long enough for a slow network round trip, short enough to reap a prompt. */
const GH_TIMEOUT_MS = 20_000;

/** JSON listings are bounded by `--limit`; anything larger is not an answer. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Overrides that keep the CLI from paging, colouring or prompting. They are
 * applied on top of the inherited environment so the operator's existing GitHub
 * CLI session — whatever holds it — keeps working untouched.
 */
const NON_INTERACTIVE_ENVIRONMENT = Object.freeze({
  GH_PAGER: "",
  PAGER: "",
  NO_COLOR: "1",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
});

const execFileAsync = promisify(execFile);

/**
 * Creates a runner for the configured GitHub CLI executable.
 *
 * On Windows `gh` is usually a `.cmd` shim, which `execFile` refuses to launch
 * without a shell — and a shell is exactly what this package may not open. The
 * executable is therefore configurable so a host can point at the real program
 * (an absolute path to `gh.exe`); when it cannot be launched the adapter reports
 * a disconnected GitHub connection instead of falling back to a shell.
 */
export function createGhCliRunner(executable = "gh"): GhCliRunner {
  if (executable.length === 0 || /[\0\r\n]/.test(executable)) {
    throw new Error("GitHub CLI executable configuration is invalid");
  }
  return async (args: readonly string[]): Promise<GhCliResult> => {
    try {
      const result = await execFileAsync(executable, [...args], {
        shell: false,
        windowsHide: true,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, ...NON_INTERACTIVE_ENVIRONMENT },
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as Error & {
        code?: number | string;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      if (failure.code === "ENOENT") {
        return { exitCode: GH_CLI_NOT_INSTALLED, stdout: "", stderr: "" };
      }
      // A numeric `code` is the CLI's own exit status; anything else (EACCES,
      // EINVAL for a shim Node declines to launch) or a timeout kill means the
      // answer is "could not run", which is not the same as "said no".
      if (typeof failure.code === "number" && failure.killed !== true) {
        return {
          exitCode: failure.code,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
      }
      return { exitCode: GH_CLI_UNAVAILABLE, stdout: "", stderr: "" };
    }
  };
}
