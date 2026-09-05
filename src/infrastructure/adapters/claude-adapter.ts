// Claude vykdymo adapteris (etalonas 1:1). PARKED / REFERENCE etalone: testinis Claude
// kvietimo kelias; kanoninis produkcinis dispatch eina per atskirą CLI kelią (E5) su
// stream-json ir modelio eskalacija — abu keliai SĄMONINGAI nesujungti (DUP-09/RT-03
// sprendimas perkeliamas nepakeistas).

import { runWithInput } from "../process/run-process.js";
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from "../../domain/agents/execution-port.js";
import type { AdapterRuntime } from "./adapter-runtime.js";
import type { ExecutionProcessRunner } from "./process-runner.js";

export type ClaudeAdapterOptions = {
  enabled?: boolean;
  runner?: ExecutionProcessRunner;
  timeoutMs?: number;
  runtime?: AdapterRuntime;
};

export class ClaudeAdapter implements ExecutionAdapter {
  readonly kind = "claude" as const;
  readonly #enabled: boolean;
  readonly #runner: ExecutionProcessRunner;
  readonly #timeoutMs: number;
  readonly #runtime?: AdapterRuntime;

  constructor(options: ClaudeAdapterOptions = {}) {
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
        stderr: "Claude adapter is not implemented; no external work was performed.",
        reason: "claude_adapter_not_implemented",
      };
    }
    if (!request.contextPack) {
      return this.failure("Claude execution requires context-pack content.", "claude_context_pack_missing");
    }
    const model = request.model?.trim();
    if (!model) {
      return this.failure("Claude execution requires a model selected by policy.", "claude_model_missing");
    }

    const cwd = request.cwd ?? process.cwd();
    if (this.#runtime) await this.#runtime.prepare(cwd);
    const args = ["-p", "--output-format", "json", "--model", model];
    const result = await this.#runner("claude", args, JSON.stringify(request.contextPack), cwd, this.#timeoutMs);
    if (this.#runtime) {
      const normalized = this.#runtime.normalize(this.kind, result, "claude_completed");
      // `normalized.stdout` gali būti nukirptas (`AdapterRuntime.normalize` riboja
      // `maxOutputBytes`); JSON parsinamas iš NEAPKIRPTO `result.stdout`, kad validus CLI
      // atsakymas tyliai nedingtų vien dėl to, kad viršija runtime limitą. Jei apkirpo pats
      // runner'is (`result.stdoutTruncated`), stdout jau NEPILNAS ir jame — reikšmė ar ne —
      // negali būti pasitikima, tad structuredOutput neteikiamas ir priežastis pažymima.
      if (result.stdoutTruncated) {
        return { ...normalized, reason: `${normalized.reason}_claude_output_truncated` };
      }
      return { ...normalized, ...parseStructuredOutput(result.stdout) };
    }
    const timedOut = result.code === 124;
    return {
      adapter: this.kind,
      status: result.code === 0 ? "completed" : timedOut ? "timed_out" : "failed",
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      reason: result.code === 0 ? "claude_completed" : timedOut ? "claude_timeout" : "claude_exit_" + result.code,
      ...parseStructuredOutput(result.stdout),
    };
  }

  private failure(stderr: string, reason: string): ExecutionResult {
    return { adapter: this.kind, status: "failed", exitCode: 2, stdout: "", stderr, reason };
  }
}

function parseStructuredOutput(stdout: string): Pick<ExecutionResult, "structuredOutput"> | Record<string, never> {
  try {
    return { structuredOutput: JSON.parse(stdout) as unknown };
  } catch {
    return {};
  }
}
