// `build-gate` CLI adapteris (etalonas: commands/build-gate.ts). Patikra —
// application/release-readiness/build-gate per BuildGatePorts; čia tik ataskaitos spausdinimas
// ir exit kontraktas: fresh → 0, stale → 1, klaida → 2.
//
// Stale ataskaita eina į `stderr`, o ne į `stdout`: ji yra GEDIMO pranešimas, ir CI, kuris
// stdout'ą naudoja kaip duomenis, neturi jo su ja sumaišyti.

import { runBuildGate, type BuildGatePorts } from "../../../application/release-readiness/build-gate.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type BuildGateCommandDeps = {
  ports: BuildGatePorts;
  /** Paketo šaknis, kurioje gyvena `src` ir `dist` (VERQESTRA — repo šaknis). */
  packageRoot: string;
  io?: CliIo;
};

export async function buildGateCommand(deps: BuildGateCommandDeps, _args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await runBuildGate(deps.ports, deps.packageRoot);
    if (result.status === "ok") {
      io.out(result.report);
      return 0;
    }
    io.error(result.report);
    return 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
