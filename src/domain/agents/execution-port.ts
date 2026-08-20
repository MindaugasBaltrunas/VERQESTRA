// Grynas agentų dispatch portas: kontraktas, kurį implementuoja išoriniai vykdymo
// adapteriai (Claude, Codex, dry-run). Jokių process/fs importų — konkreti procesų
// egzekucija gyvena infrastructure/adapters. Etalonas: AG_loop domain/agents/execution-port.
// FQC-12: adapterio rūšis NE dubliuojama — tai ta pati domain/policies AgentAdapterKind.

import type { AgentAdapterKind } from "../policies/agent-selection.js";

export type ExecutionAdapterKind = AgentAdapterKind;

export type ExecutionRequest = {
  taskId: string;
  prompt?: string;
  contextPackPath?: string;
  contextPack?: Record<string, unknown>;
  allowedPaths?: string[];
  cwd?: string;
  model?: string;
};

export type ExecutionStatus = "completed" | "failed" | "timed_out" | "not_implemented";

export type ExecutionResult = {
  adapter: ExecutionAdapterKind;
  status: ExecutionStatus;
  exitCode: number;
  stdout: string;
  stderr: string;
  reason: string;
  structuredOutput?: unknown;
};

export interface ExecutionAdapter {
  readonly kind: ExecutionAdapterKind;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
