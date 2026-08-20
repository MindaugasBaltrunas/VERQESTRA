// `plan` CLI adapteris (etalonas: interfaces/cli/plan/index.ts printPlan pusė). Aktyvios
// spec validacija ir kontrakto generavimas — application/task-planning/plan (per PlanPorts);
// čia lieka etalono console eilutės 1:1 ir exit kodas (klaida → 2).

import path from "node:path";
import { plan, type PlanPorts } from "../../../application/task-planning/plan.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type PlanCommandDeps = {
  ports: PlanPorts;
  projectRoot: string;
  io?: CliIo;
};

export async function planCommand(deps: PlanCommandDeps, args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await plan(deps.ports, args, deps.projectRoot);
    io.out(`AG plan ready: ${result.specId}`);
    io.out(`architecture contract: ${path.relative(deps.projectRoot, result.contractPath)}`);
    io.out(`state: ${result.state}`);
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
