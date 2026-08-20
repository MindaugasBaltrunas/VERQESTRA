// `loop-guard` CLI adapteris (etalonas: interfaces/cli/loop-guard/index.ts). Standalone
// pasiruošimo patikra: tie patys deterministiniai pre-loop tikrinimai kaip `loop`, bet
// NESTARTUOJA loop'o. Exit 0 = saugu, 1 = blokuota. Pati vartų logika —
// application/scheduling/loop-preconditions (portus ir higienos reaper'į suriša VQ-504).

import {
  renderLoopPreconditionReport,
  type LoopPreconditionReport,
} from "../../../application/scheduling/loop-preconditions.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type LoopGuardCommandDeps = {
  /** Gitignored runtime katalogų paruošimas (etalono ensureDirs). */
  ensureDirs(): Promise<void>;
  /** Pilnas evaluateLoopPreconditions kvietimas su composition surištais portais. */
  evaluate(): Promise<LoopPreconditionReport>;
  io?: CliIo;
};

export async function loopGuard(deps: LoopGuardCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  await deps.ensureDirs();
  const report = await deps.evaluate();
  for (const line of renderLoopPreconditionReport(report)) io.out(line);
  return report.ok ? 0 : 1;
}
