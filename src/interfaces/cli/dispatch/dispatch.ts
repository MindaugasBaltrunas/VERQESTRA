// `dispatch` CLI adapteris (etalonas: interfaces/cli/dispatch/index.ts). Argv/render/exit
// sluoksnis čia; maršrutizavimo SPRENDIMAS — application/task-execution/adapter-routing
// (tas pats resolveDispatchAdapter, kurį naudoja production loop). Adapterio konstravimą ir
// patį dispatch vykdymą (etalono runExecutionDispatch — prielaidų vartai + rezultato
// artefaktas) paduoda composition per portus.
//
// PARKED / REFERENCE pastaba perkelta 1:1 (etalono DUP-09): `codex`/`claude` adapteriai be
// `enabled: true` visada grąžina `not_implemented` — realiai vykdo tik `dry-run`. Produkcinis
// Claude/Codex dispatch eina per dedikuotas `claude-dispatch`/`codex-dispatch` komandas.

import { resolveDispatchAdapter } from "../../../application/task-execution/adapter-routing.js";
import type { AgentPolicy } from "../../../domain/policies/agent-selection.js";
import type { ExecutionAdapter, ExecutionAdapterKind } from "../../../domain/agents/execution-port.js";
import { consoleCliIo, type CliIo } from "../registry.js";

/** Etalono `DispatchResult` forma 1:1 — ją grąžina composition paduotas vykdytojas. */
export type ExecutionDispatchResult = {
  adapter: string;
  status: "completed" | "failed";
  task_id: string;
  summary: string;
  result_path: string;
};

export type DispatchCommandDeps = {
  /** Task teksto skaitymas maršrutizavimui; klaida/nesamas failas → "" (etalono semantika). */
  readTaskText(taskFile: string): Promise<string>;
  loadAgentPolicy(): Promise<AgentPolicy>;
  createAdapter(kind: ExecutionAdapterKind): ExecutionAdapter;
  /** Etalono `runExecutionDispatch`: prielaidų vartai + adapterio vykdymas + rezultato artefaktas. */
  runDispatch(taskFile: string, adapter: ExecutionAdapter): Promise<ExecutionDispatchResult>;
  io?: CliIo;
};

const PRODUCTION_ADAPTER_COMMAND: Record<string, string> = {
  claude: "claude-dispatch",
  codex: "codex-dispatch",
};

const ADAPTER_NOT_IMPLEMENTED_REASONS = new Set(["claude_adapter_not_implemented", "codex_adapter_not_implemented"]);

export async function dispatch(args: string[], deps: DispatchCommandDeps): Promise<ExecutionDispatchResult> {
  const taskFile = args.find((arg) => !arg.startsWith("--"))?.trim();
  if (!taskFile) {
    throw new Error(
      "Usage: verqestra dispatch <task-file> [--adapter=dry-run|auto|codex|claude] " +
        "(only dry-run executes; codex/claude are parked/reference — use codex-dispatch/claude-dispatch for production execution)",
    );
  }

  // Kanoninė routing paslauga (etalono task 889): numatytasis lieka dry-run (saugu);
  // `--adapter=auto` parenka pagal vaidmenį.
  const taskText = await deps.readTaskText(taskFile);
  const policy = await deps.loadAgentPolicy();
  const requestedAdapter = args.find((arg) => arg.startsWith("--adapter="))?.slice("--adapter=".length) ?? "dry-run";
  const decision = resolveDispatchAdapter(taskText, policy, requestedAdapter);

  const result = await deps.runDispatch(taskFile, deps.createAdapter(decision.adapter));
  return withProductionAdapterGuidance(result, decision.adapter);
}

// codex/claude visada baigiasi `<adapter>_adapter_not_implemented` (žr. PARKED pastabą) —
// vietoj pliko reason kodo parodomas sąžiningas produkcinis kelias.
function withProductionAdapterGuidance(result: ExecutionDispatchResult, adapterValue: string): ExecutionDispatchResult {
  if (!ADAPTER_NOT_IMPLEMENTED_REASONS.has(result.summary)) return result;
  const productionCommand = PRODUCTION_ADAPTER_COMMAND[adapterValue];
  if (!productionCommand) return result;
  return {
    ...result,
    summary:
      `${result.summary}: adapter '${adapterValue}' is parked/reference only (DUP-09) and never executes — ` +
      `use 'verqestra ${productionCommand} <task-file>' for production execution`,
  };
}

export async function printDispatch(args: string[], deps: DispatchCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await dispatch(args, deps);
    io.out("dispatch: " + result.status);
    io.out("adapter: " + result.adapter);
    io.out("task: " + result.task_id);
    io.out("summary: " + result.summary);
    return result.status === "completed" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
