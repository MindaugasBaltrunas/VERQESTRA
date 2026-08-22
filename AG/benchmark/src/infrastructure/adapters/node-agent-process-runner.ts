import { execFile, spawn, type ChildProcess } from "node:child_process";

import type {
  AgentProcessPort,
  AgentProcessResult,
  AgentProcessSpec,
} from "../../application/ports/agent-process-port.js";
import { redactSecrets } from "../../application/secret-redaction.js";

/**
 * The one place this package starts an agent process.
 *
 * It mirrors the Git runner's posture, for the same reason: scenario data is
 * input to a benchmark, and input that can choose what runs is not input. So the
 * program is spawned directly with an argument vector, the environment is
 * composed rather than inherited, the timeout is mandatory, and output is
 * bounded before it can decide how much memory a run needs.
 */

/** Beyond this a stream is cut. Generous for a telemetry envelope, bounded for a runaway log. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024;

/** A process that ignored the kill gets this long before it is killed unconditionally. */
const KILL_GRACE_MS = 5_000;

/**
 * The host variables a child needs merely to start: an interpreter to find, a
 * temporary directory to use, a stable locale to report in. Everything beyond
 * this — a credential above all — reaches the child only because an adapter's
 * caller put it in {@link AgentProcessSpec.env}.
 *
 * An allowlist rather than a filtered copy of `process.env`: the harness runs
 * inside the AG repository, whose own environment carries the AG runtime's
 * settings, and a benchmarked agent inheriting those would be measured under
 * conditions no one chose.
 */
const INHERITED_ENVIRONMENT_VARIABLES = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "NUMBER_OF_PROCESSORS",
] as const;

function baseEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of INHERITED_ENVIRONMENT_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  // Stable message text, so a diagnosis reads the same in every locale.
  environment["LC_ALL"] = "C";
  // Nothing here may block on a human: a prompt in a benchmark is a hang, and a
  // hang is indistinguishable from a slow agent until the timeout fires.
  environment["CI"] = "1";
  return environment;
}

/** Windows has neither process groups nor real signals, so the two hosts end a tree differently. */
const IS_WINDOWS = process.platform === "win32";

/** Bounded time to confirm a killed tree is actually gone before the caller is allowed to move on. */
const TREE_VERIFY_TIMEOUT_MS = 2_000;
const TREE_VERIFY_POLL_MS = 50;
/** Bounded time for the Windows tree-discovery query; a hung query must not hang the sample. */
const TREE_ENUMERATE_TIMEOUT_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** True while `pid` still names a live process, on either host. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `stillAlive` until it turns false or `timeoutMs` has passed. Never throws. */
async function waitUntilGone(stillAlive: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (stillAlive() && performance.now() < deadline) {
    await delay(TREE_VERIFY_POLL_MS);
  }
}

/**
 * Every pid in `rootPid`'s tree, root included, as Windows currently reports it.
 *
 * One PowerShell call walks the whole tree itself (breadth-first over
 * `Win32_Process`, following `ParentProcessId`) rather than this process asking
 * once per level: the walk reads the live process table and follows the parent
 * links already recorded on each process, so a grandchild survives being found
 * even when the intermediate that spawned it has already exited by the time the
 * timeout fires — the case that let a `node --test` grandchild outlive a killed
 * `taskkill /T` target in the field.
 *
 * Falls back to `[rootPid]` alone when PowerShell cannot answer in time; the
 * caller still kills and verifies at least the pid it was given.
 */
async function windowsProcessTree(rootPid: number): Promise<readonly number[]> {
  const script =
    `$ErrorActionPreference='SilentlyContinue';` +
    `$all=@(${rootPid});$frontier=@(${rootPid});` +
    `while($frontier.Count -gt 0){` +
    `$procs=Get-CimInstance Win32_Process;` +
    `$children=@($procs | Where-Object { $frontier -contains $_.ParentProcessId } | Select-Object -ExpandProperty ProcessId);` +
    `$new=@($children | Where-Object { $all -notcontains $_ });` +
    `$all+=$new;$frontier=$new};` +
    `$all | ForEach-Object { Write-Output $_ }`;

  return new Promise((resolve) => {
    try {
      execFile(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: TREE_ENUMERATE_TIMEOUT_MS },
        (error, stdout) => {
          if (error !== null) {
            resolve([rootPid]);
            return;
          }
          const pids = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^\d+$/.test(line))
            .map(Number);
          resolve(pids.length > 0 ? pids : [rootPid]);
        },
      );
    } catch {
      resolve([rootPid]);
    }
  });
}

/** `taskkill /T /F` against one pid. Nothing here throws — a pid already gone is not a failure. */
function taskkillOne(pid: number): void {
  try {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } catch {
    // Already reaped: there is nothing left to end.
  }
}

/**
 * Ends the child and everything the child started, and does not resolve until
 * the tree is confirmed gone or a bounded wait has passed.
 *
 * Signalling the one pid is not enough: the agents this harness measures spawn
 * their own children — `agent-solo` runs a CLI which runs more processes still —
 * and a grandchild that outlives the timeout keeps calling a paid model, outside
 * the sample it belonged to and outside any bound at all. That unmeasured spend
 * is the whole reason the timeout exists, so the kill has to reach the tree, and
 * the caller has to know the tree is actually gone before it starts the next
 * sample in the same workspace.
 *
 * Nothing here throws. A group that is already gone, a `taskkill` that is not
 * installed, a pid the platform no longer knows — none of them is a run that
 * failed, and the `close` handler still reports `timedOut`.
 */
async function endProcessTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill(signal);
    } catch {
      // Already reaped: there is nothing left to end.
    }
    return;
  }

  if (IS_WINDOWS) {
    const tree = await windowsProcessTree(pid);
    for (const treePid of tree) taskkillOne(treePid);
    await waitUntilGone(() => tree.some(isPidAlive), TREE_VERIFY_TIMEOUT_MS);
    return;
  }

  try {
    // Negative pid: the process group the child leads, which is why it is spawned
    // detached below. ESRCH here means the group already exited.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already reaped: there is nothing left to end.
    }
    return;
  }
  await waitUntilGone(() => {
    try {
      // Signal 0 to the group: throws once every member has exited.
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  }, TREE_VERIFY_TIMEOUT_MS);
}

/** Raised for a spec this package will not spawn. Never a process failure — a refusal to start one. */
export class AgentProcessRefusedError extends Error {
  constructor(reason: string) {
    super(`Refused to start the agent process: ${reason}.`);
    this.name = "AgentProcessRefusedError";
  }
}

/**
 * Rejects anything that could turn one argument into two, or one command into a
 * different one, once it reaches the operating system.
 */
export function assertSafeProcessSpec(spec: AgentProcessSpec): void {
  if (spec.command.trim() === "") {
    throw new AgentProcessRefusedError("no command was given");
  }
  if (spec.cwd.trim() === "") {
    throw new AgentProcessRefusedError("no working directory was given");
  }
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new AgentProcessRefusedError(
      `the timeout ${String(spec.timeoutMs)} is not a positive whole number of milliseconds`,
    );
  }
  for (const value of [spec.command, spec.cwd, ...spec.args]) {
    if (typeof value !== "string") {
      throw new AgentProcessRefusedError("an argument is not a string");
    }
    if (value.includes("\0")) {
      throw new AgentProcessRefusedError("an argument carries a NUL byte");
    }
  }
  for (const [name, value] of Object.entries(spec.env)) {
    if (name.includes("\0") || name.includes("=") || value.includes("\0")) {
      throw new AgentProcessRefusedError(`the environment variable "${name}" is not well formed`);
    }
  }
}

/** Accumulates a stream up to a ceiling and remembers whether it was reached. */
class BoundedStream {
  #chunks: string[] = [];
  #length = 0;
  truncated = false;

  append(chunk: string): void {
    if (this.truncated) return;
    const remaining = MAX_STREAM_BYTES - this.#length;
    if (chunk.length >= remaining) {
      this.#chunks.push(chunk.slice(0, remaining));
      this.#length = MAX_STREAM_BYTES;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  text(): string {
    return this.#chunks.join("");
  }
}

/**
 * Spawns the agent and resolves once it has exited and both streams have closed.
 *
 * A process that ran and failed resolves with its status: "the agent exited 1" is
 * a measurement the benchmark is there to record. Only being unable to start one
 * rejects, because that is the harness failing rather than the agent.
 */
export class NodeAgentProcessRunner implements AgentProcessPort {
  async run(spec: AgentProcessSpec): Promise<AgentProcessResult> {
    assertSafeProcessSpec(spec);

    return new Promise<AgentProcessResult>((resolve, reject) => {
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...baseEnvironment(), ...spec.env },
        // No shell: neither a scenario id nor a path can be reinterpreted as syntax.
        shell: false,
        windowsHide: true,
        // A group of its own, so the timeout can end the whole tree rather than
        // just its root. Not on Windows, where `detached` would instead let the
        // child outlive this process; there the tree is ended with `taskkill /T`.
        detached: !IS_WINDOWS,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const childStdout = child.stdout;
      const childStderr = child.stderr;
      const childStdin = child.stdin;
      if (childStdout === null || childStderr === null || childStdin === null) {
        // Not a process outcome: without the pipes there is nowhere for the
        // telemetry envelope to arrive, so nothing could be measured anyway.
        child.kill("SIGKILL");
        reject(new AgentProcessRefusedError("the child's standard streams were not piped"));
        return;
      }

      const stdout = new BoundedStream();
      const stderr = new BoundedStream();
      let timedOut = false;
      let settled = false;
      // The most recent (or only) tree-kill in flight; `close` waits on whichever
      // this holds at the moment it fires, so a timeout never reports itself
      // resolved before the tree it killed is confirmed gone.
      let pendingKill: Promise<void> = Promise.resolve();

      let forceKillTimer: NodeJS.Timeout | undefined;
      const killTimer = setTimeout(() => {
        timedOut = true;
        pendingKill = endProcessTree(child, "SIGTERM");
        // A child that ignores the polite signal must not outlive the sample it
        // belongs to; the grace period is the only chance it gets to flush.
        forceKillTimer = setTimeout(() => {
          pendingKill = endProcessTree(child, "SIGKILL");
        }, KILL_GRACE_MS);
        forceKillTimer.unref();
      }, spec.timeoutMs);
      killTimer.unref();

      const stopTimers = (): void => {
        clearTimeout(killTimer);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      };

      childStdout.setEncoding("utf8");
      childStderr.setEncoding("utf8");
      childStdout.on("data", (chunk: string) => stdout.append(chunk));
      childStderr.on("data", (chunk: string) => stderr.append(chunk));

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        stopTimers();
        reject(error);
      });

      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        stopTimers();
        const finish = (): void => {
          resolve({
            exitCode,
            signal,
            stdout: stdout.text(),
            // Redacted here rather than at the caller: this is the last point
            // before an agent's own output becomes something the harness records.
            stderr: redactSecrets(stderr.text()),
            timedOut,
            outputTruncated: stdout.truncated || stderr.truncated,
          });
        };
        // Only a timeout ever starts a tree-kill, so only a timeout waits for one:
        // the happy path resolves exactly as fast as it always did.
        if (timedOut) {
          pendingKill.then(finish, finish);
        } else {
          finish();
        }
      });

      // A stdin that cannot be written — the child exited immediately, the pipe
      // broke — is the child's outcome to report, not an error to throw over.
      childStdin.on("error", () => undefined);
      childStdin.end(spec.stdin);
    });
  }
}
