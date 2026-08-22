import type { AgentProcessPort } from "../../application/ports/agent-process-port.js";
import { redactSecrets } from "../../application/secret-redaction.js";
import type {
  CheckExecutionPort,
  CheckExecutionRequest,
  CheckExecutionResult,
} from "../../application/verify/check-execution-port.js";

/**
 * Runs a scenario's declared check as a real process.
 *
 * It composes the package's one hardened spawn rather than adding a second: the
 * no-shell, explicit-environment, mandatory-timeout, bounded-output discipline
 * lives in the agent process runner and is worth exactly as much to a check as
 * to an agent. What this adds is the one rule a check needs and an agent does
 * not — a guard on which program a scenario may name.
 *
 * ## Why the program is guarded
 *
 * A check command comes from a scenario file, and a scenario also ships a
 * fixture directory that the agent under test can write into. Without a guard, a
 * scenario could name `./tools/check` and an agent could make its own check pass
 * by writing that file — the change would be graded by a program the change
 * itself produced. Requiring a bare program name, resolved through `PATH`, keeps
 * the grader outside the thing being graded.
 *
 * Nothing is passed on standard input and no variable beyond what a process
 * needs to start reaches the child: a check reads a checkout, and anything else
 * it could read is a way for the harness's own environment to change the result.
 */

/** Beyond this the recorded output is cut. Diagnosis detail, not a transcript. */
const MAX_RECORDED_OUTPUT = 4_000;

/** Separators, drive letters and traversal — everything that turns a name into a location. */
const PROGRAM_LOCATION = /[/\\]|^[A-Za-z]:/;

/** Raised for a check this package will not execute. Never a failed check — a refusal to run one. */
export class CheckCommandRefusedError extends Error {
  constructor(reason: string) {
    super(`Refused to run the check command: ${reason}.`);
    this.name = "CheckCommandRefusedError";
  }
}

/**
 * Rejects a command whose program is anything but a bare name on `PATH`, and any
 * argument that could not be passed through a vector unchanged.
 */
export function assertSafeCheckCommand(command: string, args: readonly string[]): void {
  if (command.trim() === "") {
    throw new CheckCommandRefusedError("no program was named");
  }
  if (PROGRAM_LOCATION.test(command)) {
    throw new CheckCommandRefusedError(
      `"${command}" names a location rather than a program; a check is resolved through PATH so a fixture cannot supply its own grader`,
    );
  }
  if (command === "." || command === "..") {
    throw new CheckCommandRefusedError(`"${command}" is not a program name`);
  }
  for (const value of [command, ...args]) {
    if (typeof value !== "string") {
      throw new CheckCommandRefusedError("an argument is not a string");
    }
    if (value.includes("\0")) {
      throw new CheckCommandRefusedError("an argument carries a NUL byte");
    }
  }
}

/** The tail of the combined streams: a test runner states its failures last. */
function recordedOutput(stdout: string, stderr: string): string {
  const combined = `${stdout}${stdout !== "" && stderr !== "" ? "\n" : ""}${stderr}`.trim();
  const redacted = redactSecrets(combined);
  return redacted.length <= MAX_RECORDED_OUTPUT
    ? redacted
    : `…${redacted.slice(-MAX_RECORDED_OUTPUT)}`;
}

export class ProcessCheckRunner implements CheckExecutionPort {
  readonly #processes: AgentProcessPort;

  constructor(processes: AgentProcessPort) {
    this.#processes = processes;
  }

  async run(request: CheckExecutionRequest): Promise<CheckExecutionResult> {
    assertSafeCheckCommand(request.command, request.args);
    if (request.cwd.trim() === "") {
      throw new CheckCommandRefusedError("no checkout was given to run the check in");
    }
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new CheckCommandRefusedError(
        `the timeout ${String(request.timeoutMs)} is not a positive whole number of milliseconds`,
      );
    }

    const result = await this.#processes.run({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      // A check is given nothing to authenticate with and nothing to read from
      // standard input: both would be ways for something other than the change
      // to decide the result.
      env: {},
      stdin: "",
    });

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      output: recordedOutput(result.stdout, result.stderr),
    };
  }
}
