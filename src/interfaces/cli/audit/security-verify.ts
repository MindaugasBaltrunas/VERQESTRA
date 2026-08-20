// `security-verify` CLI adapteris (etalonas: interfaces/cli/security-verify/index.ts).
// Skenas — application/quality-gates/security-verify per SecurityVerifyPorts; čia tik
// etalono console eilutės ir exit kontraktas: blocked → 1, kitaip 0.

import { securityVerify, type SecurityVerifyPorts } from "../../../application/quality-gates/security-verify.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type SecurityVerifyCommandDeps = {
  ports: SecurityVerifyPorts;
  projectRoot: string;
  io?: CliIo;
};

export async function securityVerifyCommand(deps: SecurityVerifyCommandDeps, args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await securityVerify(deps.ports, args, deps.projectRoot);
    io.out(`security-verify: ${result.status}`);
    io.out(`files: ${result.files.length}`);
    io.out(`blocked_paths: ${result.blocked_paths.length}`);
    io.out(`text_findings: ${result.text_findings.length}`);
    return result.status === "blocked" ? 1 : 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
