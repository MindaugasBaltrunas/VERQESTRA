// Spawn runner'is su ribota išvestimi, timeout ir išoriniu abort. Elgesio etalonas:
// AG_loop core/process.ts (Windows spawn EINVAL pamoka — .cmd/.bat per cmd.exe be shell
// sluoksnio; task 1203 abort kelias; head+tail truncation).

import { spawn } from "node:child_process";
import { killTree, timeoutFallbackGraceMsForPlatform, type KillTreeResult } from "./process-tree.js";

/**
 * Nenužudyti proceso medžio nariai — į TĄ PAČIĄ žinutę, kurią mato operatorius (2026-08-24).
 *
 * Iki tol tree-kill verifikuodavo tik root PID, tad likę palikuonys būdavo tyli sėkmė: agentas
 * po timeout'o galėjo toliau suktis ir naudoti biudžetą, o žinutė apie tai nesakydavo nieko.
 * Tuščias sąrašas nieko neprideda — pranešama TIK tada, kai realiai kas nors liko.
 */
export function withSurvivorNote(message: string | undefined, survivors: readonly number[]): string | undefined {
  if (survivors.length === 0 || message === undefined) return message;
  return `${message}\n[process tree: ${survivors.length} process(es) still alive after forced cleanup: ${survivors.join(", ")}]`;
}

export type SupportedPlatform = NodeJS.Platform;
export type ShellInvocation = { command: string; args: string[] };

export function shellInvocationForPlatform(command: string, platform: SupportedPlatform = process.platform): ShellInvocation {
  return platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { command: "sh", args: ["-lc", command] };
}

export function packageManagerExecutable(name: string, platform: SupportedPlatform = process.platform): string {
  const normalized = name.trim();
  if (!normalized) throw new Error("Package manager executable name is required");
  return platform === "win32" && !normalized.toLowerCase().endsWith(".cmd") ? `${normalized}.cmd` : normalized;
}

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

export const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/**
 * Nutraukimas iš IŠORĖS (task 1203): kvietėjas turi savo stabdiklį, kurio `timeoutMs`
 * išreikšti negali (pvz. mid-dispatch token biudžetas). Veikia kaip timeout kelias —
 * `killTree` + fallback, jei OS niekada nepraneša `close`.
 */
export type ProcessAbortOptions = {
  signal: AbortSignal;
  /** Kodas, kurį `CommandResult.code` gauna, kai nutraukė BŪTENT šis signalas. */
  exitCode: number;
  /** Priežastis į `stderr` — kaip timeout'o žinutė. */
  reason?: string;
};

export type ProcessObserverOptions = {
  /** Kviečiama KIEKVIENAM stdout chunk'ui PO `BoundedOutput.append`. Mesta klaida nutildoma. */
  onStdout?: (chunk: Buffer) => void;
  abort?: ProcessAbortOptions;
};

type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxOutputBytes?: number;
} & ProcessObserverOptions;

class BoundedOutput {
  #chunks: Buffer[] = [];
  #bytes = 0;
  #headChunks: Buffer[] = [];
  #headBytes = 0;
  #tailChunks: Buffer[] = [];
  #tailBytes = 0;
  #truncated = false;
  readonly #headMaxBytes: number;
  readonly #tailMaxBytes: number;

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("maxOutputBytes must be a positive integer");
    this.#headMaxBytes = maxBytes === 1 ? 0 : Math.max(1, Math.floor(maxBytes / 5));
    this.#tailMaxBytes = maxBytes - this.#headMaxBytes;
  }

  append(chunk: Buffer): void {
    if (!this.#truncated && this.#bytes + chunk.byteLength <= this.maxBytes) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.byteLength;
      return;
    }

    if (!this.#truncated) {
      const buffered = Buffer.concat([...this.#chunks, chunk], this.#bytes + chunk.byteLength);
      this.#chunks = [];
      this.#bytes = buffered.byteLength;
      this.#truncated = true;
      this.#headChunks = this.#headMaxBytes > 0 ? [buffered.subarray(0, this.#headMaxBytes)] : [];
      this.#headBytes = this.#headMaxBytes;
      this.#tailChunks = this.#tailMaxBytes > 0 ? [buffered.subarray(buffered.byteLength - this.#tailMaxBytes)] : [];
      this.#tailBytes = this.#tailMaxBytes;
      return;
    }

    this.#bytes += chunk.byteLength;
    this.#appendTail(chunk);
  }

  #appendTail(chunk: Buffer): void {
    if (this.#tailMaxBytes <= 0) return;
    if (chunk.byteLength >= this.#tailMaxBytes) {
      this.#tailChunks = [chunk.subarray(chunk.byteLength - this.#tailMaxBytes)];
      this.#tailBytes = this.#tailMaxBytes;
      return;
    }

    this.#tailChunks.push(chunk);
    this.#tailBytes += chunk.byteLength;
    while (this.#tailBytes > this.#tailMaxBytes) {
      const first = this.#tailChunks[0];
      if (!first) break;
      const excess = this.#tailBytes - this.#tailMaxBytes;
      if (first.byteLength <= excess) {
        this.#tailChunks.shift();
        this.#tailBytes -= first.byteLength;
      } else {
        this.#tailChunks[0] = first.subarray(excess);
        this.#tailBytes -= excess;
      }
    }
  }

  result(stream: "stdout" | "stderr"): { value: string; truncated: boolean } {
    if (!this.#truncated) {
      return { value: Buffer.concat(this.#chunks, this.#bytes).toString("utf8"), truncated: false };
    }

    const head = Buffer.concat(this.#headChunks, this.#headBytes).toString("utf8");
    const tail = Buffer.concat(this.#tailChunks, this.#tailBytes).toString("utf8");
    const marker = `\n[${stream} truncated; retained first ${this.#headMaxBytes} bytes and last ${this.#tailMaxBytes} bytes]\n`;
    return { value: `${head}${marker}${tail}`, truncated: true };
  }
}

function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Node ≥18.20/20.12/22 (CVE-2024-27980) atsisako spawn'inti Windows .cmd/.bat
    // tiesiogiai ir meta EINVAL; o shell:true savo ruožtu kelia DEP0190 (args
    // neescape'inami). Saugiausia .cmd/.bat (pnpm.cmd/npm.cmd) paleisti per cmd.exe
    // (.exe — spawn'inamas tiesiogiai, args lieka atskiri argv elementai, be shell
    // sluoksnio).
    const isWindowsBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const spawnCommand = isWindowsBatch ? "cmd.exe" : command;
    const spawnArgs = isWindowsBatch ? ["/d", "/s", "/c", command, ...args] : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stdout = new BoundedOutput(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    const stderr = new BoundedOutput(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    let settled = false;
    let timedOut = false;
    let timeoutMessage: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutFallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutCleanup: KillTreeResult | undefined;
    let aborted = false;
    let abortMessage: string | undefined;
    let abortCleanup: KillTreeResult | undefined;
    let abortFallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const abortOptions = options.abort;
    const abortExitCode = abortOptions?.exitCode ?? 1;

    const finish = (code: number, stderrOverride?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(timeoutFallbackTimer);
      clearTimeout(abortFallbackTimer);
      timeoutCleanup?.cancel();
      abortCleanup?.cancel();
      abortOptions?.signal.removeEventListener("abort", onAbort);
      const out = stdout.result("stdout");
      const err = stderr.result("stderr");
      resolve({
        code,
        stdout: out.value,
        stderr: stderrOverride ?? err.value,
        stdoutTruncated: out.truncated,
        stderrTruncated: stderrOverride === undefined && err.truncated,
      });
    };

    // Veidrodis timeout keliui. PRIORITETAS: timeout laimi, jei suveikė pirmas — jo 124
    // semantika lieka nepakitusi, o abort'as tada tyliai pasitraukia (kitaip ta pati
    // sesija turėtų du skirtingus paaiškinimus).
    const onAbort = (): void => {
      if (settled || timedOut || aborted) return;
      aborted = true;
      abortMessage = abortOptions?.reason ?? `Command aborted: ${command} ${args.join(" ")}`;
      abortCleanup = killTree(child);
      // Kaip timeout kelyje: normali baigtis laukia vaiko `close`, o šis fallback'as tik
      // neleidžia runner'iui pakibti, jei OS `close` niekada nepraneša.
      abortFallbackTimer = setTimeout(() => {
        finish(abortExitCode, `${abortMessage}\n[abort fallback: process did not report close after forced cleanup]`);
      }, timeoutFallbackGraceMsForPlatform());
      abortFallbackTimer.unref?.();
    };

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (settled || aborted) return;
        timedOut = true;
        timeoutMessage = `Command timed out after ${Math.round(options.timeoutMs! / 1000)}s: ${command} ${args.join(" ")}`;
        timeoutCleanup = killTree(child);
        timeoutFallbackTimer = setTimeout(() => {
          const fallbackMessage = `${timeoutMessage}\n[timeout fallback: process did not report close after forced cleanup]`;
          finish(124, fallbackMessage);
        }, timeoutFallbackGraceMsForPlatform());
        timeoutFallbackTimer.unref?.();
      }, options.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      if (options.onStdout) {
        try {
          options.onStdout(chunk);
        } catch {
          // stebėtojas niekada nenutraukia paleidimo
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error) => finish(127, error.message));
    child.on("close", (code) => {
      if (timedOut && timeoutCleanup) {
        // finish() privalo įvykti nepriklausomai nuo to, ar kill-tree cleanup pavyko —
        // atmestas cleanup kitaip paliktų runner'į kabėti amžinai.
        timeoutCleanup.done.then(
          (survivors) => finish(124, withSurvivorNote(timeoutMessage, survivors)),
          () => finish(124, timeoutMessage),
        );
        return;
      }
      if (aborted && abortCleanup) {
        abortCleanup.done.then(
          (survivors) => finish(abortExitCode, withSurvivorNote(abortMessage, survivors)),
          () => finish(abortExitCode, abortMessage),
        );
        return;
      }
      finish(code ?? 1);
    });
    if (abortOptions) {
      abortOptions.signal.addEventListener("abort", onAbort, { once: true });
      // Jau nutrauktas signalas: `addEventListener` tokiam nieko nebekviečia, tad procesą
      // reikia nužudyti iškart — kitaip kvietėjo stabdiklis būtų tyliai praleistas.
      if (abortOptions.signal.aborted) onAbort();
    }
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number } & ProcessObserverOptions = {},
): Promise<CommandResult> {
  return runProcess(command, args, options);
}

export function runShell(
  command: string,
  cwd = process.cwd(),
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): Promise<CommandResult> {
  const invocation = shellInvocationForPlatform(command);
  return runProcess(invocation.command, invocation.args, {
    cwd,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(env === undefined ? {} : { env }),
    maxOutputBytes,
  });
}

export function runWithInput(
  command: string,
  args: string[],
  input: string,
  cwd = process.cwd(),
  timeoutMs?: number,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  observer: ProcessObserverOptions = {},
): Promise<CommandResult> {
  return runProcess(command, args, {
    cwd,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    input,
    maxOutputBytes,
    ...observer,
  });
}

export async function commandExists(command: string, cwd = process.cwd()): Promise<boolean> {
  if (process.platform === "win32") {
    const result = await run("where", [command], { cwd });
    return result.code === 0;
  }
  const result = await run("sh", ["-lc", 'command -v "$1"', "sh", command], { cwd });
  return result.code === 0;
}
