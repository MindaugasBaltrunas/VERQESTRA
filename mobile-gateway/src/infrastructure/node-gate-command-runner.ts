import { spawn } from "node:child_process";
import path from "node:path";
import type {
  GateCommandOutcome,
  GateCommandRunRequest,
  GateCommandRunnerPort,
} from "../application/ports/gate-command-runner-port.js";

/**
 * Host execution of one quality gate.
 *
 * A gate runs code the repository author wrote — a build script, a test suite —
 * so this adapter treats the child as untrusted in both directions:
 *
 * - **Its output is discarded by the operating system.** The child inherits no
 *   pipes at all, so there is no buffer for the gateway to leak, log or forward,
 *   and no way for a printed secret to reach a phone. The gateway learns the
 *   exit code and nothing else.
 * - **It inherits almost no environment.** Passing the operator's environment
 *   through would hand every API token, session cookie and cloud credential on
 *   the host to whatever the repository decided to run. Only the variables in
 *   {@link GATE_ENVIRONMENT_ALLOWLIST} — the ones a compiler genuinely needs to
 *   locate its toolchain and a temporary directory — survive the filter.
 *
 * Known limitation: `child.kill()` terminates the process this adapter created,
 * not the tree it spawned. On Windows a build tool's own children can therefore
 * outlive the time budget, and on POSIX the usual fix — signalling the process
 * group by negative pid — is exactly the foreign-process control this package's
 * boundary tests forbid. The time budget bounds the gateway's wait, not the
 * host's process table.
 */

/**
 * Variables a gate may see. `PATH` is here because a toolchain that cannot be
 * located cannot run at all; everything else is what compilers and test runners
 * need to find a temporary directory and the platform's own libraries.
 */
export const GATE_ENVIRONMENT_ALLOWLIST = Object.freeze({
  win32: Object.freeze([
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "windir",
    "ComSpec",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "NUMBER_OF_PROCESSORS",
  ]),
  posix: Object.freeze(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]),
});

/** Time a terminated gate is given to exit before it is killed outright. */
const KILL_GRACE_MS = 5_000;

/**
 * Time an unkillable gate is waited on before the adapter answers without it.
 *
 * A child stuck in an uninterruptible state never emits `close`, and a promise
 * that waits for one would hang the whole gate run — the exact failure the time
 * budget exists to prevent. The adapter reports the timeout it already knows
 * about and stops waiting; the host's process table is not its to guarantee.
 */
const ABANDON_MS = 5_000;

/** Characters that would split or truncate a path handed to the OS. */
const UNUSABLE_CHARACTER = /[\0\r\n]/;

/**
 * The two properties the launch itself depends on, re-checked here.
 *
 * `session-gate-policy.ts` already validates the whole command, and that stays
 * the place where gate policy lives. This is a different question: the process
 * is created HERE, so the file that calls `spawn` must not depend on a caller's
 * discipline for the invariant that keeps the child out of the worktree's hands.
 * A relative program name is resolved by the operating system — on Windows
 * `CreateProcess` may consult the current directory, which is the tree the agent
 * just wrote to — and a relative working directory would run the gate somewhere
 * the gateway never chose.
 *
 * A refusal is thrown rather than reported as an outcome: nothing ran, so there
 * is no verdict to report, and the caller records the gate as `errored`.
 */
function assertLaunchable(request: GateCommandRunRequest): void {
  if (!path.isAbsolute(request.executable) || UNUSABLE_CHARACTER.test(request.executable)) {
    throw new Error("Quality gate executable must be an absolute path without control characters");
  }
  if (!path.isAbsolute(request.cwd) || UNUSABLE_CHARACTER.test(request.cwd)) {
    throw new Error("Quality gate working directory must be an absolute path without control characters");
  }
}

export type NodeGateCommandRunnerOptions = Readonly<{
  /** Environment to filter; defaults to the gateway's own. */
  env?: Readonly<Record<string, string | undefined>>;
}>;

export class NodeGateCommandRunner implements GateCommandRunnerPort {
  private readonly source: Readonly<Record<string, string | undefined>>;

  constructor(options: NodeGateCommandRunnerOptions = {}) {
    this.source = options.env ?? process.env;
  }

  private gateEnvironment(): Record<string, string> {
    const allowed = process.platform === "win32"
      ? GATE_ENVIRONMENT_ALLOWLIST.win32
      : GATE_ENVIRONMENT_ALLOWLIST.posix;
    const environment: Record<string, string> = {};
    for (const name of allowed) {
      const value = this.source[name];
      if (typeof value === "string") environment[name] = value;
    }
    return environment;
  }

  async run(request: GateCommandRunRequest): Promise<GateCommandOutcome> {
    assertLaunchable(request);
    const startedAt = Date.now();
    return new Promise<GateCommandOutcome>((resolve) => {
      let settled = false;
      let timedOut = false;
      let budget: NodeJS.Timeout | undefined;
      let grace: NodeJS.Timeout | undefined;
      let abandon: NodeJS.Timeout | undefined;

      const settle = (outcome: Omit<GateCommandOutcome, "durationMs">): void => {
        if (budget !== undefined) clearTimeout(budget);
        if (grace !== undefined) clearTimeout(grace);
        if (abandon !== undefined) clearTimeout(abandon);
        if (settled) return;
        settled = true;
        resolve(Object.freeze({ ...outcome, durationMs: Date.now() - startedAt }));
      };

      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: this.gateEnvironment(),
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });

      budget = setTimeout(() => {
        timedOut = true;
        child.kill();
        // A process that ignores the polite signal still has to stop: the
        // operator is waiting on a bounded answer, not on the gate's goodwill.
        grace = setTimeout(() => {
          child.kill("SIGKILL");
          abandon = setTimeout(() => {
            settle({ timedOut: true, startFailed: false });
          }, ABANDON_MS);
        }, KILL_GRACE_MS);
      }, request.timeoutMs);

      // Failure to start is not a verdict about the code under test, so it is
      // reported as its own fact rather than as a red gate.
      child.on("error", () => {
        settle({ timedOut, startFailed: true });
      });

      child.on("close", (code) => {
        settle(code === null
          ? { timedOut, startFailed: false }
          : { exitCode: code, timedOut, startFailed: false });
      });
    });
  }
}
