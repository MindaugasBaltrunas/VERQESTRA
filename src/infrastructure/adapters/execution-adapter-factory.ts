// ExecutionAdapter fabrikas (iškeltas iš adapters/index.ts barrel'io, kad adapter-dispatch
// galėtų jį importuoti be barrel ciklo — acyclic gate). Elgesys nepakitęs.

import type { ExecutionAdapter, ExecutionAdapterKind } from "../../domain/agents/execution-port.js";
import { DryRunAdapter } from "./dry-run-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { ClaudeAdapter } from "./claude-adapter.js";

export function createExecutionAdapter(kind: ExecutionAdapterKind): ExecutionAdapter {
  if (kind === "dry-run") return new DryRunAdapter();
  if (kind === "codex") return new CodexAdapter();
  if (kind === "claude") return new ClaudeAdapter();
  const exhaustive: never = kind;
  throw new Error("Unknown execution adapter: " + String(exhaustive));
}
