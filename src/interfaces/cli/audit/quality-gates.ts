// `quality-gates` CLI adapteris (etalonas: commands/quality-gates.ts).
//
// Sprendimą priima `runQualityGates` use case; čia lieka tik trys dalykai: argumentų perdavimas,
// žmogui skirtas atvaizdas ir exit kodas.
//
// Exit kodas imamas IŠ STATUSO, o ne perskaičiuojamas: statusas keliauja ir į
// `quality-gates-status.json`, kurį skaito kiti vartai, tad antras skaičiavimas čia reikštų, kad
// tas pats paleidimas gali turėti du skirtingus verdiktus.

import { runQualityGates, type QualityGatesPorts } from "../../../application/quality-gates/quality-gates.js";
import type { QualityGatesStatus } from "../../../application/quality-gates/quality-gates-status.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type QualityGatesCommandDeps = {
  ports: QualityGatesPorts;
  projectRoot: string;
  io?: CliIo;
};

/** Žmogui skirta santrauka: praėję vartai — viena eilutė, kritę — su komandomis ir kodais. */
export function renderQualityGates(status: QualityGatesStatus): string {
  const lines: string[] = [];
  lines.push(`quality-gates scope=${status.scope} ${status.passed ? "PASSED" : "FAILED"} (exit ${status.exit_code})`);
  if (!status.has_commands) {
    lines.push(status.message ?? `Nėra sukonfigūruotų komandų scope'ui '${status.scope}'.`);
    return `${lines.join("\n")}\n`;
  }
  for (const result of status.results) {
    lines.push(`  ${result.exit_code === 0 ? "OK  " : "FAIL"} ${result.name}: ${result.command} (exit ${result.exit_code})`);
  }
  if (status.failed_gates.length > 0) lines.push(`Krito: ${status.failed_gates.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export async function qualityGatesCommand(deps: QualityGatesCommandDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const status = await runQualityGates(deps.ports, args, { projectRoot: deps.projectRoot });

  if (args.includes("--json")) {
    io.out(`${JSON.stringify(status, null, 2)}\n`);
    return status.exit_code;
  }

  const text = renderQualityGates(status);
  if (status.passed) io.out(text);
  else io.error(text);
  return status.exit_code;
}
