// `task-generate` CLI adapteris (etalonas: interfaces/cli/task-generate/index.ts 1:1).
// Komandai priklauso TIK argumentų parsinimas ir išvesties render'is; visas planavimas —
// application/task-planning. Portus (fs) paduoda composition, ne šis modulis.

import {
  taskGenerate,
  type TaskGeneratePorts,
  type TaskGenerateOptions,
} from "../../../application/task-planning/generate.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type TaskGenerateCommandDeps = {
  ports: TaskGeneratePorts;
  projectRoot?: string;
  /** VERQESTRA runtime šaknis (`<root>/vq`); nenurodžius — use-case default'as. */
  runtimeRoot?: string;
  io?: CliIo;
};

export async function printTaskGenerate(args: string[], deps: TaskGenerateCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const projectRoot = deps.projectRoot ?? process.cwd();
    const result = await taskGenerate(deps.ports, parseTaskGenerateOptions(args), projectRoot, deps.runtimeRoot);
    io.out(`AG task generation ready: ${result.specId}`);
    io.out(`tasks: ${result.tasksPath}`);
    io.out(`created: ${result.created.length}`);
    io.out(`skipped: ${result.skipped.length}`);
    for (const created of result.created) io.out(`created: ${created}`);
    for (const skipped of result.skipped) io.out(`skipped: ${skipped}`);
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function parseTaskGenerateOptions(args: string[]): TaskGenerateOptions {
  const options: TaskGenerateOptions = { startIndex: 1 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--openspec" || arg === "--change") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error(`${arg} requires a change id`);
      options.openspecChangeId = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--openspec=")) {
      options.openspecChangeId = arg.slice("--openspec=".length).trim();
      continue;
    }
    if (arg === "--start") {
      options.startIndex = parsePositiveInteger(args[index + 1], "--start");
      index += 1;
      continue;
    }
    if (arg?.startsWith("--start=")) {
      options.startIndex = parsePositiveInteger(arg.slice("--start=".length), "--start");
      continue;
    }
    if (arg !== undefined && arg.startsWith("--")) {
      throw new Error(`Unknown flag: "${arg}". Use --openspec <change-id> and --start <number>.`);
    }
    throw new Error(`Unknown positional argument: "${arg}". Use --openspec <change-id> and --start <number>.`);
  }
  return options;
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}
