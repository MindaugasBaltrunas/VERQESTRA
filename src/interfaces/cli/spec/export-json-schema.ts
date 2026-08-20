// `export-json-schema` CLI adapteris (etalonas: interfaces/cli/export-json-schema/
// index.ts). Schemų turinys ir eksporto logika — application/policy-governance/
// json-schema-export (per portą); čia lieka `--out` flag parsinimas ir console eilutės.

import path from "node:path";
import {
  exportJsonSchemas,
  type JsonSchemaExportPorts,
} from "../../../application/policy-governance/json-schema-export.js";
import { consoleCliIo, type CliIo } from "../registry.js";
import { flagValue } from "./flag-value.js";

export type ExportJsonSchemaCommandDeps = {
  ports: JsonSchemaExportPorts;
  projectRoot: string;
  io?: CliIo;
};

export async function exportJsonSchemaCommand(
  deps: ExportJsonSchemaCommandDeps,
  args: string[] = [],
): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const out = flagValue(args, "--out");
    const outputDir = out ? path.resolve(deps.projectRoot, out) : undefined;
    const result = await exportJsonSchemas(deps.ports, deps.projectRoot, outputDir);

    io.out(`json schemas: ${result.outputDir}`);
    for (const file of result.files) {
      io.out(`schema: ${file}`);
    }
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
