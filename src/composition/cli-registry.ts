// `verqestra` komandų registras (etalonas: AG_loop orchestrator/runtime/command-registry.ts).
//
// Registras yra VIENINTELIS komandų sąrašo šaltinis: iš jo statoma ir dispatch'o lentelė, ir
// `help` išvestis. Du sąrašai ilgainiui prasilenktų, ir `help` imtų meluoti apie tai, kas realiai
// veikia.
//
// Handler'iai čia surišami su portais (manual DI). Verslo logikos šiame faile nėra — kiekviena
// komanda tik gauna savo priklausomybes ir grąžina exit kodą.

import { exportJsonSchemaCommand } from "../interfaces/cli/spec/export-json-schema.js";
import { openSpecReconcileCommand } from "../interfaces/cli/spec/openspec-reconcile.js";
import { renderCliCommandList, type CliCommand, type CliIo } from "../interfaces/cli/registry.js";
import { jsonSchemaExportPorts, openSpecReconcileFs } from "./node-adapters.js";
import type { RuntimeRoots } from "./runtime-context.js";

export type CliRegistryDeps = {
  roots: RuntimeRoots;
  io?: CliIo;
};

/**
 * Migruotos ir surištos komandos. Sąrašas auga kartu su VQ-504 dalimis — kol komanda čia
 * neįrašyta, ji CLI neegzistuoja ir `help` jos nerodo. Tai sąmoninga: rodyti komandą, kurios
 * dispatch'as nepasiekia, reikštų meluoti operatoriui.
 */
export function buildCliCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  return [
    {
      name: "export-json-schema",
      usage: "[--out <dir>]",
      description: "Eksportuoja politikų JSON schemas į katalogą",
      run: (args) =>
        exportJsonSchemaCommand(
          { ports: jsonSchemaExportPorts, projectRoot: deps.roots.projectRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "openspec-reconcile",
      usage: "[--apply]",
      description: "Sutikrina OpenSpec pakeitimus su užduočių būsena",
      run: (args) =>
        openSpecReconcileCommand(
          { fs: openSpecReconcileFs, agRoot: deps.roots.agRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
  ];
}

/** `help` tekstas: antraštė plius registro eilutės deklaravimo tvarka. */
export function renderCliHelp(commands: readonly CliCommand[]): string[] {
  return ["Usage: verqestra <command> [args]", "", "Commands:", ...renderCliCommandList(commands).map((line) => `  ${line}`)];
}
