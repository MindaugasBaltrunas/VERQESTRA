// `backlog-audit` CLI adapteris (etalonas: interfaces/cli/backlog-audit/index.ts).
// Auditas — application/release-readiness/backlog-audit per BacklogAuditPorts; bucket'ų
// šaknis — `<root>/AG/tasks` (etalonas 1:1).

import path from "node:path";
import {
  auditTaskStates,
  renderBacklogAudit,
  type BacklogAuditPorts,
} from "../../../application/release-readiness/backlog-audit.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type BacklogAuditCommandDeps = {
  ports: BacklogAuditPorts;
  projectRoot: string;
  io?: CliIo;
};

export async function backlogAuditCommand(deps: BacklogAuditCommandDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const unknown = args.filter((arg) => arg !== "--json");
    if (unknown.length > 0) throw new Error(`Unknown backlog-audit argument: ${unknown[0]}`);
    const result = await auditTaskStates(deps.ports, path.join(deps.projectRoot, "AG", "tasks"));
    io.out(args.includes("--json") ? JSON.stringify(result, null, 2) : renderBacklogAudit(result));
    return result.status === "complete" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
