// `task-dependencies` CLI adapteris (etalonas: interfaces/cli/task-dependencies/index.ts).
// list — bucket'ų `## Dependencies` metaduomenys; route-blocked — RANKINIS escape hatch
// (RT-07): visi queue task'ai su `blocked_by: <blocker>` žymimi ir keliami į human-review.
// Exit kodai 1:1: usage/klaida 2; route-blocked su bent vienu maršrutu — 1 (signalas CI).

import {
  readTaskDependencyMetadata,
  routeBlockedTasksToHumanReview,
  type BlockedTaskRoutingPorts,
} from "../../../application/task-execution/task-graph-import.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type TaskDependenciesCommandDeps = {
  ports: BlockedTaskRoutingPorts;
  io?: CliIo;
};

export async function printTaskDependencies(args: string[], deps: TaskDependenciesCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const asJson = args.includes("--json");
    const subcommand = args.find((arg) => !arg.startsWith("--")) ?? "list";

    if (subcommand === "list") {
      const metadata = await readTaskDependencyMetadata(deps.ports, ["queue", "active", "delegated", "human-review"]);
      if (asJson) {
        io.out(JSON.stringify(metadata, null, 2));
        return 0;
      }
      for (const task of metadata) {
        io.out(`${task.task_id}: ${task.blocked_by.length > 0 ? task.blocked_by.join(",") : "no-dependencies"}`);
      }
      return 0;
    }

    if (subcommand === "route-blocked") {
      const blocker = args.find((arg, index) => index > args.indexOf(subcommand) && !arg.startsWith("--"));
      if (!blocker) throw new Error("Usage: verqestra task-dependencies route-blocked <task-id> [--json]");
      const result = await routeBlockedTasksToHumanReview(deps.ports, blocker);
      if (asJson) {
        // Etalono elgesys 1:1: --json kelias grąžina PRIEŠ exit kodo sprendimą, tad
        // routed>0 čia NEkelia 1 — signalinis kodas galioja tik žmogui skirtai išvesčiai.
        io.out(JSON.stringify(result, null, 2));
        return 0;
      }
      io.out(`blocker: ${result.blocker}`);
      io.out(`scanned: ${result.scanned}`);
      io.out(`routed: ${result.routed.length}`);
      for (const item of result.routed) io.out(`routed: ${item.from} -> ${item.to}`);
      return result.routed.length > 0 ? 1 : 0;
    }

    throw new Error("Usage: verqestra task-dependencies [list|route-blocked <task-id>] [--json]");
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
