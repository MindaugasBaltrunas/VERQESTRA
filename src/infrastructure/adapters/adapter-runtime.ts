// Bendra adapterių runtime aplinka (etalonas: AG_loop infrastructure/adapters/
// adapter-runtime.ts): timeout/output konfigas, prielaidų validacija (context-pack +
// budget status DISKE, budget_enforcement.ok) ir proceso rezultato normalizacija.
// VERQESTRA keliai: vq/supervisor/context-pack.json + vq/state/token-budget-status.json.

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInsideProject } from "../../shared/paths.js";
import type { CommandResult } from "../process/run-process.js";
import type { ExecutionAdapterKind, ExecutionResult } from "../../domain/agents/execution-port.js";

export type AdapterRuntimeConfig = {
  timeoutMs: number;
  maxOutputBytes: number;
};

export type AdapterPrerequisites = {
  projectRoot: string;
  cwd: string;
  contextPack: Record<string, unknown>;
  budgetStatus: Record<string, unknown>;
};

export const DEFAULT_ADAPTER_RUNTIME_CONFIG: AdapterRuntimeConfig = {
  timeoutMs: 15 * 60 * 1000,
  maxOutputBytes: 1024 * 1024,
};

export function resolveAdapterRuntimeConfig(input: Partial<AdapterRuntimeConfig> = {}): AdapterRuntimeConfig {
  const config = { ...DEFAULT_ADAPTER_RUNTIME_CONFIG, ...input };
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error("adapter timeoutMs must be a positive integer");
  }
  if (!Number.isInteger(config.maxOutputBytes) || config.maxOutputBytes <= 0) {
    throw new Error("adapter maxOutputBytes must be a positive integer");
  }
  return config;
}

export async function validateAdapterPrerequisites(
  projectRoot: string,
  cwd: string,
  runtimeRoot?: string,
): Promise<AdapterPrerequisites> {
  const root = await validatedDirectory(projectRoot, "project root");
  const workdir = await validatedDirectory(cwd, "working directory");
  // Kanoninė „relative escapes root" patikra: šaknis pati laikoma viduje, tad darbo
  // katalogas gali būti projekto šaknis, bet ne tėvas/brolis/kitas diskas.
  if (!isPathInsideProject(root, workdir)) {
    throw new Error("adapter working directory must be inside project root");
  }

  const vqRoot = runtimeRoot ?? path.join(root, "vq");
  const contextPack = await readRequiredObject(path.join(vqRoot, "supervisor", "context-pack.json"), "context-pack");
  const budgetStatus = await readRequiredObject(path.join(vqRoot, "state", "token-budget-status.json"), "budget status");
  const enforcement = budgetStatus["budget_enforcement"];
  if (!enforcement || typeof enforcement !== "object" || (enforcement as { ok?: unknown }).ok !== true) {
    throw new Error("adapter budget status is missing a successful budget_enforcement result");
  }
  return { projectRoot: root, cwd: workdir, contextPack, budgetStatus };
}

export function normalizeAdapterProcessResult(
  adapter: ExecutionAdapterKind,
  result: CommandResult,
  successReason: string,
  config: AdapterRuntimeConfig = DEFAULT_ADAPTER_RUNTIME_CONFIG,
): ExecutionResult {
  const resolved = resolveAdapterRuntimeConfig(config);
  const timedOut = result.code === 124;
  return {
    adapter,
    status: result.code === 0 ? "completed" : timedOut ? "timed_out" : "failed",
    exitCode: result.code,
    stdout: limitUtf8(result.stdout, resolved.maxOutputBytes),
    stderr: limitUtf8(result.stderr, resolved.maxOutputBytes),
    reason: result.code === 0 ? successReason : timedOut ? adapter + "_timeout" : adapter + "_exit_" + result.code,
  };
}

export class AdapterRuntime {
  readonly config: AdapterRuntimeConfig;
  readonly projectRoot: string;
  readonly runtimeRoot: string;

  constructor(projectRoot: string, config: Partial<AdapterRuntimeConfig> = {}, runtimeRoot?: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.runtimeRoot = runtimeRoot ?? path.join(this.projectRoot, "vq");
    this.config = resolveAdapterRuntimeConfig(config);
  }

  prepare(cwd: string): Promise<AdapterPrerequisites> {
    return validateAdapterPrerequisites(this.projectRoot, cwd, this.runtimeRoot);
  }

  normalize(adapter: ExecutionAdapterKind, result: CommandResult, successReason: string): ExecutionResult {
    return normalizeAdapterProcessResult(adapter, result, successReason, this.config);
  }
}

async function validatedDirectory(value: string, label: string): Promise<string> {
  const resolved = await realpath(path.resolve(value)).catch(() => {
    throw new Error("adapter " + label + " does not exist: " + value);
  });
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("adapter " + label + " is not a directory: " + value);
  return resolved;
}

async function readRequiredObject(filePath: string, label: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("adapter " + label + " is missing", { cause: error });
    throw error;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
    return value as Record<string, unknown>;
  } catch (error: unknown) {
    throw new Error("adapter " + label + " is invalid: " + (error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
}

function limitUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  return encoded.byteLength <= maxBytes ? value : encoded.subarray(0, maxBytes).toString("utf8");
}
