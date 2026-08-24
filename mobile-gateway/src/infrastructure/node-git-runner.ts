import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitRunnerPort, GitRunResult } from "../application/ports/git-runner-port.js";

const execFileAsync = promisify(execFile);

export class NodeGitRunner implements GitRunnerPort {
  async run(cwd: string, args: readonly string[]): Promise<GitRunResult> {
    try {
      const result = await execFileAsync("git", [...args], {
        cwd,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
      };
    }
  }
}
