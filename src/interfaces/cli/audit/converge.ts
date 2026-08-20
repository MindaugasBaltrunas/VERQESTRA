// `converge` CLI adapteris (etalonas: interfaces/cli/converge/index.ts). Patikra —
// application/release-readiness/converge-check per ConvergePorts; čia tik JSON print
// ir exit kontraktas: converged → 0, issues → 1, klaida → 2.

import { converge, type ConvergePorts } from "../../../application/release-readiness/converge-check.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type ConvergeCommandDeps = {
  ports: ConvergePorts;
  projectRoot: string;
  /** vq runtime šaknis; default — `<projectRoot>/vq`. */
  runtimeRoot?: string;
  io?: CliIo;
};

export async function convergeCommand(deps: ConvergeCommandDeps, _args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await converge(deps.ports, {
      projectRoot: deps.projectRoot,
      ...(deps.runtimeRoot === undefined ? {} : { runtimeRoot: deps.runtimeRoot }),
    });
    io.out(JSON.stringify(result, null, 2));
    return result.status === "converged" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
