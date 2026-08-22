// `release-check` CLI adapteris (etalonas: commands/release-check.ts). Logika —
// application/release-readiness/release-check; čia tik santrauka, verdikto failo kelias ir
// exit kontraktas: ok → 0, failed → 1, klaida → 2.

import {
  runReleaseCheck,
  type ReleaseCheckPorts,
  type ReleaseCheckRunners,
  type SourceStateInputs,
} from "../../../application/release-readiness/release-check.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type ReleaseCheckCommandDeps = {
  ports: ReleaseCheckPorts;
  runners: ReleaseCheckRunners;
  projectRoot: string;
  /** Source-state hash'o įėjimai; nesant — application default'as (kompozicija juos pina). */
  sourceStateInputs?: SourceStateInputs;
  io?: CliIo;
};

export async function releaseCheckCommand(deps: ReleaseCheckCommandDeps, _args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await runReleaseCheck(deps.ports, deps.runners, {
      projectRoot: deps.projectRoot,
      ...(deps.sourceStateInputs === undefined ? {} : { sourceStateInputs: deps.sourceStateInputs }),
    });
    io.out(`release-check: ${result.status}`);
    io.out(`failed_parts: ${result.failed_parts.length === 0 ? "none" : result.failed_parts.join(", ")}`);
    io.out(`result: ${result.result_path}`);
    return result.status === "ok" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
