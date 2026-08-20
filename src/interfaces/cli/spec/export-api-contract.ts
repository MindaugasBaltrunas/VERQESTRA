// `export-api-contract` CLI adapteris (etalonas: interfaces/cli/export-api-contract/
// index.ts). Eksporto logika — application/task-planning/api-contract-export (per portą);
// čia lieka `--out` flag parsinimas (etalono flagValue 1:1) ir console eilutės.

import path from "node:path";
import {
  exportActiveApiContract,
  type ApiContractExportPorts,
} from "../../../application/task-planning/api-contract-export.js";
import { consoleCliIo, type CliIo } from "../registry.js";
import { flagValue } from "./flag-value.js";

export type ExportApiContractCommandDeps = {
  ports: ApiContractExportPorts;
  projectRoot: string;
  io?: CliIo;
};

export async function exportApiContractCommand(
  deps: ExportApiContractCommandDeps,
  args: string[] = [],
): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const out = flagValue(args, "--out");
    const outputPath = out ? path.resolve(deps.projectRoot, out) : undefined;
    const result = await exportActiveApiContract(deps.ports, deps.projectRoot, outputPath);
    io.out(`api contract: ${path.relative(deps.projectRoot, result.outputPath)}`);
    io.out(`endpoints: ${result.contract.endpoints.length}`);
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
