// `final-audit` CLI adapteris (etalonas: interfaces/cli/final-audit/index.ts). Užbaigimo
// vartų kompozicija — application/release-readiness/final-audit per FinalAuditPorts;
// čia tik argumentai, renderFinalAudit tekstas 1:1 ir exit kontraktas complete → 0.

import {
  runFinalAudit,
  type FinalAuditPorts,
  type FinalAuditResult,
} from "../../../application/release-readiness/final-audit.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type FinalAuditCommandDeps = {
  ports: FinalAuditPorts;
  projectRoot: string;
  runtimeRoot?: string;
  io?: CliIo;
};

export function renderFinalAudit(result: FinalAuditResult): string {
  const lines = [`Final audit: ${result.status}`, `Report: ${result.report_path}`];
  for (const [name, value] of Object.entries(result.checks)) {
    lines.push(`${name}: ${value.ok ? "ok" : "not_ok"}${value.issues.length ? ` (${value.issues.join(", ")})` : ""}`);
  }
  if (result.release_notes) lines.push(`Release notes: ${result.release_notes.status} ${result.release_notes.path}`);
  if (result.release_proof) lines.push(`Release proof: ${result.release_proof.summary_path}, ${result.release_proof.markdown_path}`);
  return lines.join("\n");
}

export async function finalAuditCommand(deps: FinalAuditCommandDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const unknown = args.filter((arg) => arg !== "--json");
    if (unknown.length > 0) throw new Error(`Unknown final-audit argument: ${unknown[0]}`);
    const result = await runFinalAudit(deps.ports, {
      projectRoot: deps.projectRoot,
      ...(deps.runtimeRoot === undefined ? {} : { runtimeRoot: deps.runtimeRoot }),
    });
    io.out(args.includes("--json") ? JSON.stringify(result, null, 2) : renderFinalAudit(result));
    return result.status === "complete" ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
