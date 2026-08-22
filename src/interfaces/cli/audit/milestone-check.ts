// `milestone-check` CLI adapteris (etalonas: commands/milestone-check.ts). Logika —
// application/release-readiness/milestone-check; čia tik santrauka ir exit kontraktas:
// ok → 0, bet kuri kita baigtis → 1, klaida → 2.

import {
  runMilestoneCheck,
  type MilestoneCheckPorts,
  type MilestoneCheckRunners,
} from "../../../application/release-readiness/milestone-check.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type MilestoneCheckCommandDeps = {
  ports: MilestoneCheckPorts;
  runners: MilestoneCheckRunners;
  io?: CliIo;
};

export async function milestoneCheckCommand(deps: MilestoneCheckCommandDeps, _args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await runMilestoneCheck(deps.ports, deps.runners);
    io.out(`milestone-check: ${result.status}`);
    io.out(`failed_parts: ${result.failed_parts.length === 0 ? "none" : result.failed_parts.join(", ")}`);
    return result.status === "ok" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
