// infrastructure/adapters barrel + fabrikas (etalonas: AG_loop infrastructure/adapters).
// Domain ExecutionAdapter porto implementacijos: procesų egzekucija, fs prielaidų
// validacija ir išvesties normalizacija gyvena čia, kad pats portas liktų grynas.

import type { ExecutionAdapter, ExecutionAdapterKind } from "../../domain/agents/execution-port.js";
import { DryRunAdapter } from "./dry-run-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { ClaudeAdapter } from "./claude-adapter.js";

export * from "./adapter-runtime.js";
export * from "./process-runner.js";
export * from "./dry-run-adapter.js";
export * from "./codex-adapter.js";
export * from "./claude-adapter.js";
export * from "./integration-reviewer.js";
export * from "./claude-decision.js";
export * from "./claude-usage.js";
export * from "./claude-tool-schema.js";
export * from "./claude-headless.js";
// E4 VQ-404 (2/2): provider tier -> modelio ID mapping'as (claude-model-env), matomas
// PowerShell dispatch paleidiklis su nonce watchdog'u (claude-launcher), adapterių
// galimybių deklaracijos ir realus IntegrationPort (IVER-3 pilnoji pusė).
export * from "./claude-model-env.js";
export * from "./claude-launcher.js";
export * from "./adapter-capabilities.js";
export * from "./integration-review-adapter.js";

export function createExecutionAdapter(kind: ExecutionAdapterKind): ExecutionAdapter {
  if (kind === "dry-run") return new DryRunAdapter();
  if (kind === "codex") return new CodexAdapter();
  if (kind === "claude") return new ClaudeAdapter();
  const exhaustive: never = kind;
  throw new Error("Unknown execution adapter: " + String(exhaustive));
}
