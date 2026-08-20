// `spec-drift` CLI adapteris (etalonas: interfaces/cli/spec-drift/index.ts). Skaičiavimas
// ir rezultato kontraktas — application/quality-gates/spec-drift (per SpecDriftPorts);
// čia tik etalono console eilutės ir exit kodas: `review-required` → 1, kitaip 0.

import { specDrift, type SpecDriftPorts } from "../../../application/quality-gates/spec-drift.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type SpecDriftCommandDeps = {
  ports: SpecDriftPorts;
  projectRoot: string;
  io?: CliIo;
};

export async function specDriftCommand(deps: SpecDriftCommandDeps, args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await specDrift(deps.ports, args, deps.projectRoot);
    io.out(`spec-drift: ${result.status}`);
    io.out(`change: ${result.change_id}`);
    io.out(`outside_scope: ${result.outside_scope.length}`);
    if (result.outside_scope.length > 0) {
      for (const file of result.outside_scope) io.out(`- ${file}`);
    }
    return result.status === "review-required" ? 1 : 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
