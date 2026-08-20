// Codex vykdymo adapteris (etalonas 1:1): `codex exec --sandbox workspace-write` su
// context-pack per stdin; neįjungtas — not_implemented be jokio išorinio darbo.

import { runWithInput } from "../process/run-process.js";
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from "../../domain/agents/execution-port.js";
import type { AdapterRuntime } from "./adapter-runtime.js";
import type { ExecutionProcessRunner } from "./process-runner.js";

export type CodexAdapterOptions = {
  enabled?: boolean;
  runner?: ExecutionProcessRunner;
  timeoutMs?: number;
  runtime?: AdapterRuntime;
};

export class CodexAdapter implements ExecutionAdapter {
  readonly kind = "codex" as const;
  readonly #enabled: boolean;
  readonly #runner: ExecutionProcessRunner;
  readonly #timeoutMs: number;
  readonly #runtime?: AdapterRuntime;

  constructor(options: CodexAdapterOptions = {}) {
    this.#enabled = options.enabled === true;
    this.#runner = options.runner ?? runWithInput;
    this.#timeoutMs = options.timeoutMs ?? options.runtime?.config.timeoutMs ?? 15 * 60 * 1000;
    if (options.runtime !== undefined) this.#runtime = options.runtime;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!this.#enabled) {
      return {
        adapter: this.kind,
        status: "not_implemented",
        exitCode: 2,
        stdout: "",
        stderr: "Codex adapter is not implemented unless explicitly enabled; no external work was performed.",
        reason: "codex_adapter_not_implemented",
      };
    }
    if (!request.contextPack) {
      return {
        adapter: this.kind,
        status: "failed",
        exitCode: 2,
        stdout: "",
        stderr: "Codex execution requires context-pack content.",
        reason: "codex_context_pack_missing",
      };
    }

    const cwd = request.cwd ?? process.cwd();
    if (this.#runtime) await this.#runtime.prepare(cwd);
    const args = ["exec", "--sandbox", "workspace-write", "--cd", cwd, "--ephemeral", "-"];
    const result = await this.#runner("codex", args, JSON.stringify(request.contextPack), cwd, this.#timeoutMs);
    if (this.#runtime) return this.#runtime.normalize(this.kind, result, "codex_completed");
    const timedOut = result.code === 124;
    return {
      adapter: this.kind,
      status: result.code === 0 ? "completed" : timedOut ? "timed_out" : "failed",
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      reason: result.code === 0 ? "codex_completed" : timedOut ? "codex_timeout" : "codex_exit_" + result.code,
    };
  }
}
