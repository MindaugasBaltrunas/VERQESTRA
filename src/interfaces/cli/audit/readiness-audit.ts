// `readiness-audit` CLI adapteris (etalonas: interfaces/cli/readiness-audit/index.ts).
// Auditas — application/release-readiness/readiness-audit; VERQESTRA skirtumai (žr.
// application modulio antraštę): reikalavimų sąrašai — PRIVALOMA deps įvestis, o rezultato
// persist'inimas — per writeResult portą (etalono runReadinessAudit(root, true) atitikmuo).

import {
  renderReadinessAudit,
  runReadinessAudit,
  type ReadinessAuditResult,
  type ReadinessPorts,
  type ReadinessRequirements,
} from "../../../application/release-readiness/readiness-audit.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type ReadinessAuditCommandDeps = {
  ports: ReadinessPorts;
  requirements: ReadinessRequirements;
  projectRoot: string;
  /** Persistina verdiktą (kelias — readinessAuditResultPath; rašo kompozicijos adapteris). */
  writeResult(result: ReadinessAuditResult): Promise<void>;
  io?: CliIo;
};

export async function readinessAuditCommand(deps: ReadinessAuditCommandDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const unknown = args.filter((arg) => arg !== "--json");
    if (unknown.length > 0) throw new Error(`Unknown readiness-audit argument: ${unknown[0]}`);
    const result = await runReadinessAudit(deps.ports, deps.projectRoot, deps.requirements);
    await deps.writeResult(result);
    io.out(args.includes("--json") ? JSON.stringify(result, null, 2) : renderReadinessAudit(result));
    return result.status === "ok" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
