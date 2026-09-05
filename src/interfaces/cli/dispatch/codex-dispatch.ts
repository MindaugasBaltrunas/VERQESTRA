// `codex-dispatch` CLI adapteris (etalonas: interfaces/cli/codex-dispatch/index.ts).
// Argv/render/exit sluoksnis čia; vykdymas — ExecutionAdapter (infrastructure), kurį
// per fabriko portą paduoda composition: `codex` rūšiai fabrikas privalo grąžinti
// ĮJUNGTĄ (enabled) CodexAdapter — tik šis kelias jį įjungia (etalono elgesys 1:1),
// visos kitos rūšys kuriamos numatytu (inert) režimu.

import type {
  ExecutionAdapter,
  ExecutionAdapterKind,
  ExecutionRequest,
  ExecutionResult,
} from "../../../domain/agents/execution-port.js";
import { flagValue } from "../spec/flag-value.js";
import { consoleCliIo, type CliIo } from "../registry.js";
import { positionalArgs } from "./dispatch.js";

export type CodexDispatchOptions = ExecutionRequest & {
  adapter?: ExecutionAdapterKind;
};

export type CodexDispatchCommandDeps = {
  /** `enabled` galioja tik `codex` rūšiai — kitoms fabrikas jį ignoruoja (inert adapteriai). */
  createAdapter(kind: ExecutionAdapterKind, options?: { enabled?: boolean }): ExecutionAdapter;
  /** JSON context-pack skaitymas iš absoliutaus kelio (parse klaida — metama). */
  readContextPack(absolutePath: string): Promise<Record<string, unknown>>;
  /** Absoliutaus kelio rezoliucija prieš proceso cwd (etalono path.resolve). */
  resolvePath(candidate: string): string;
  cwd(): string;
  io?: CliIo;
};

export async function codexDispatch(
  options: CodexDispatchOptions,
  deps: Pick<CodexDispatchCommandDeps, "createAdapter">,
): Promise<ExecutionResult> {
  if (options.adapter === "codex") {
    return await deps.createAdapter("codex", { enabled: true }).execute(options);
  }
  return await deps.createAdapter(options.adapter ?? "codex").execute(options);
}

export async function printCodexDispatch(args: string[], deps: CodexDispatchCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const selected = flagValue(args, "--adapter");
  const taskId = positionalArgs(args, ["--adapter", "--context-pack"])[0] ?? "unknown-task";
  if (selected !== "codex") {
    const result = await codexDispatch({ taskId, adapter: "dry-run" }, deps);
    return printResult(result, io);
  }

  const contextPackArg = flagValue(args, "--context-pack");
  if (!contextPackArg) {
    io.error(
      "Usage: verqestra codex-dispatch <task-id> --adapter codex --context-pack <file> " +
        "(--adapter=codex --context-pack=<file> also works)",
    );
    return 2;
  }

  try {
    const contextPackPath = deps.resolvePath(contextPackArg);
    const contextPack = await deps.readContextPack(contextPackPath);
    const result = await codexDispatch(
      { taskId, adapter: "codex", contextPack, contextPackPath, cwd: deps.cwd() },
      deps,
    );
    return printResult(result, io);
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function printResult(result: ExecutionResult, io: CliIo): number {
  io.out("adapter: " + result.adapter);
  io.out("status: " + result.status);
  io.out("reason: " + result.reason);
  if (result.stderr) io.error(result.stderr);
  return result.exitCode;
}
