// `context-pack` CLI adapteris (etalonas: interfaces/cli/context-pack/index.ts). Visa
// pack surinkimo logika — application/context-pack/assemble; čia tik rendinimas ir exit.
// `assemble` funkcijos portas leidžia testams pakeisti sunkų use-case'ą fake'u nekuriant
// pilno fixture (kompozicija paduoda realų assembleContextPack — numatytoji reikšmė).

import path from "node:path";
import {
  assembleContextPack,
  type AssembleContextPackDeps,
  type ContextPackResult,
} from "../../../application/context-pack/assemble/assemble.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type ContextPackCommandDeps = {
  assembleDeps: AssembleContextPackDeps;
  projectRoot: string;
  io?: CliIo;
  assemble?: (args: string[], projectRoot: string, deps: AssembleContextPackDeps) => Promise<ContextPackResult>;
};

export async function contextPackCommand(deps: ContextPackCommandDeps, args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const assemble = deps.assemble ?? assembleContextPack;
  try {
    const result = await assemble(args, deps.projectRoot, deps.assembleDeps);
    io.out(`context pack: ${path.relative(deps.projectRoot, result.outputPath)}`);
    io.out(`task: ${result.pack.task_id}`);
    io.out(`allowed_paths: ${result.pack.allowed_paths.length}`);
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
