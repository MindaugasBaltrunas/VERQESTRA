import { constants } from "node:fs";
import { access } from "node:fs/promises";
import {
  delimiter,
  extname,
  isAbsolute,
  join,
} from "node:path";
import type {
  DirectAgentTerminalHandle,
  DirectAgentTerminalPort,
} from "../application/ports/direct-agent-terminal-port.js";

type Disposable = {
  dispose(): void;
};

type NodePtyProcess = {
  readonly pid: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

export type NodePtyModule = {
  spawn(
    executable: string,
    args: readonly string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      handleFlowControl: boolean;
    },
  ): NodePtyProcess;
};

export type NodePtyModuleLoader = () => Promise<NodePtyModule>;
export type DirectAgentExecutableResolver = (
  executable: string,
  environment: NodeJS.ProcessEnv,
) => Promise<string>;

export type DirectAgentExecutableConfig = Readonly<{
  "claude-code": string;
  codex: string;
}>;

/**
 * ETX — the interrupt byte an interactive agent reads as Ctrl+C. Named and
 * numeric for the same reason `domain/terminal-output-sanitizer.ts` does it: a
 * raw control byte in a source file does not survive every copy, and its loss
 * would compile cleanly while silently disabling the interrupt.
 */
const ETX = String.fromCharCode(0x03);

/**
 * The host-fixed executables. Exported because the provider probe must report on
 * exactly what this adapter would launch: a status derived from a different name
 * or a different lookup would be a status about a different program.
 */
export const DEFAULT_DIRECT_AGENT_EXECUTABLES: DirectAgentExecutableConfig = Object.freeze({
  "claude-code": "claude",
  codex: "codex",
});

async function defaultNodePtyLoader(): Promise<NodePtyModule> {
  const packageName = "node-pty";
  try {
    return await import(packageName) as unknown as NodePtyModule;
  } catch {
    throw new Error(
      "node-pty is unavailable; install the host-approved native dependency before enabling terminal runtime",
    );
  }
}

function inheritedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") environment[key] = value;
  }
  return environment;
}

/**
 * Rejects an executable configuration that is not a bare program name or an
 * absolute path. Shared with the provider probe so one rule — not two copies —
 * decides what the host is allowed to run.
 */
export function assertDirectAgentExecutable(executable: string): void {
  if (
    executable.trim() !== executable ||
    executable.length === 0 ||
    executable.length > 4096 ||
    executable.includes("\0") ||
    /[\r\n]/.test(executable) ||
    (!isAbsolute(executable) && /[\\/]/.test(executable))
  ) {
    throw new Error("Direct agent executable configuration is invalid");
  }
}

/**
 * Resolves a configured program name to the absolute executable the host would
 * run, walking `PATH` (and `PATHEXT` on Windows) itself instead of delegating to
 * a shell. Exported for the provider probe: presence detection and the eventual
 * spawn must agree on the same file.
 *
 * `NodeJS.ProcessEnv` yra index signature, tad `PATH`/`PATHEXT` skaitomi bracket forma —
 * `noPropertyAccessFromIndexSignature`. Reikšmės ir eiliškumas nepakito.
 */
export async function resolveDirectAgentExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const candidates: string[] = [];
  if (isAbsolute(executable)) {
    candidates.push(executable);
  } else {
    const pathEntries = (environment["PATH"] ?? environment["Path"] ?? "")
      .split(delimiter)
      .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
      // A relative `PATH` entry — `.` is the classic one — would resolve against
      // whatever directory the gateway happens to be running in, so a file
      // dropped there could become the agent. Only absolute entries are searched.
      .filter((entry) => entry.length > 0 && isAbsolute(entry));
    const extensions = process.platform === "win32" && extname(executable).length === 0
      ? (environment["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter((extension) => extension.length > 0)
      : [""];
    for (const directory of pathEntries) {
      for (const extension of extensions) {
        candidates.push(join(directory, `${executable}${extension.toLowerCase()}`));
        if (extension !== extension.toLowerCase()) {
          candidates.push(join(directory, `${executable}${extension}`));
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the host-controlled PATH candidate list.
    }
  }
  throw new Error("Configured direct agent executable is unavailable");
}

function validateStart(input: Parameters<DirectAgentTerminalPort["start"]>[0]): void {
  if (
    !isAbsolute(input.cwd) ||
    !Number.isSafeInteger(input.cols) ||
    input.cols < 20 ||
    input.cols > 500 ||
    !Number.isSafeInteger(input.rows) ||
    input.rows < 5 ||
    input.rows > 300
  ) {
    throw new Error("Direct agent PTY start request is invalid");
  }
}

export class NodePtyDirectAgentTerminalAdapter implements DirectAgentTerminalPort {
  private readonly activeSessionIds = new Set<string>();

  constructor(
    private readonly loadNodePty: NodePtyModuleLoader = defaultNodePtyLoader,
    private readonly executables: DirectAgentExecutableConfig = DEFAULT_DIRECT_AGENT_EXECUTABLES,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly resolveExecutable: DirectAgentExecutableResolver = resolveDirectAgentExecutable,
  ) {
    assertDirectAgentExecutable(executables["claude-code"]);
    assertDirectAgentExecutable(executables.codex);
  }

  async start(
    input: Parameters<DirectAgentTerminalPort["start"]>[0],
  ): Promise<DirectAgentTerminalHandle> {
    validateStart(input);
    if (this.activeSessionIds.has(input.sessionId)) {
      throw new Error("Direct agent PTY session id is already active");
    }
    const executable = await this.resolveExecutable(
      this.executables[input.provider],
      this.environment,
    );
    if (!isAbsolute(executable)) {
      throw new Error("Resolved direct agent executable must be absolute");
    }
    const nodePty = await this.loadNodePty();
    this.activeSessionIds.add(input.sessionId);
    let pty: NodePtyProcess;
    try {
      pty = nodePty.spawn(executable, [], {
        name: "xterm-256color",
        cols: input.cols,
        rows: input.rows,
        cwd: input.cwd,
        env: inheritedEnvironment(this.environment),
        handleFlowControl: true,
      });
    } catch (error) {
      this.activeSessionIds.delete(input.sessionId);
      throw error;
    }

    let exited = false;
    let stopped = false;
    let dataSubscription: Disposable = { dispose: () => undefined };
    let exitSubscription: Disposable = { dispose: () => undefined };
    dataSubscription = pty.onData((data) => {
      if (!exited) input.onOutput(data);
    });
    exitSubscription = pty.onExit((event) => {
      if (exited) return;
      exited = true;
      this.activeSessionIds.delete(input.sessionId);
      dataSubscription.dispose();
      exitSubscription.dispose();
      input.onExit(Number.isSafeInteger(event.exitCode) ? event.exitCode : null);
    });

    const assertLive = (): void => {
      if (exited || stopped) throw new Error("Direct agent PTY is not live");
    };
    const stop = (): void => {
      assertLive();
      stopped = true;
      try {
        pty.kill();
      } catch (error) {
        stopped = false;
        throw error;
      }
    };

    return Object.freeze({
      pid: pty.pid,
      // The host-resolved absolute path actually launched, so restart
      // reconciliation can reject a PID now owned by a different binary.
      executable,
      async write(text: string): Promise<void> {
        assertLive();
        pty.write(text);
      },
      async resize(cols: number, rows: number): Promise<void> {
        assertLive();
        if (
          !Number.isSafeInteger(cols) ||
          cols < 20 ||
          cols > 500 ||
          !Number.isSafeInteger(rows) ||
          rows < 5 ||
          rows > 300
        ) {
          throw new Error("Direct agent PTY dimensions are invalid");
        }
        pty.resize(cols, rows);
      },
      async interrupt(): Promise<void> {
        assertLive();
        pty.write(ETX);
      },
      async terminate(): Promise<void> {
        stop();
      },
      async close(): Promise<void> {
        stop();
      },
    });
  }
}
