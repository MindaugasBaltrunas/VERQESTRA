// Spec ir plano komandu registro pjuvis (VQ-504). Atskirtas nuo `cli-registry.ts` del dydzio
// varto: registras auga su kiekviena surista komanda, tad jis dalijamas pagal TEMA, o ne pagal
// eiluciu skaiciu -- kitaip pjuviu ribos judetu su kiekvienu papildymu.
//
// Sios komandos dirba su specifikacija: schemu ir kontraktu eksportas, planas, uzduociu
// generavimas is spec, drift'as ir OpenSpec sutikrinimas.

import type { CliCommand } from "../../interfaces/cli/registry.js";
import type { CliRegistryDeps } from "./registry-types.js";
import { exportApiContractCommand } from "../../interfaces/cli/spec/export-api-contract.js";
import { exportJsonSchemaCommand } from "../../interfaces/cli/spec/export-json-schema.js";
import { openSpecReconcileCommand } from "../../interfaces/cli/spec/openspec-reconcile.js";
import { planCommand } from "../../interfaces/cli/spec/plan.js";
import { specDriftCommand } from "../../interfaces/cli/spec/spec-drift.js";
import { learningCommand } from "../../interfaces/cli/audit/learning.js";
import { printTaskGenerate } from "../../interfaces/cli/task-queue/task-generate.js";
import {
  apiContractExportPorts,
  jsonSchemaExportPorts,
  learningFs,
  openSpecReconcileFs,
  planPorts,
  specDriftPorts,
  taskGeneratePorts,
} from "../runtime/node-adapters.js";

export function specCommands(deps: CliRegistryDeps): CliCommand[] {
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
      name: "export-api-contract",
      usage: "[--out <file>]",
      description: "Eksportuoja aktyvaus spec pakeitimo API kontraktą",
      run: (args) =>
        exportApiContractCommand(
          { ports: apiContractExportPorts, projectRoot: deps.roots.projectRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "learning",
      usage: "<list|approve|reject> [id]",
      description: "Learning atminties įrašai ir rekomendacijų sprendimai",
      run: (args) =>
        learningCommand({ fs: learningFs, runtimeRoot: deps.roots.runtimeRoot, ...(io === undefined ? {} : { io }) }, args),
    },
    {
      name: "plan",
      usage: "[--force]",
      description: "Sukuria architektūros kontraktą iš aktyvios spec'ifikacijos",
      run: (args) =>
        planCommand(
          { ports: planPorts, projectRoot: deps.roots.projectRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "task-generate",
      usage: "[--change <id>] [--start <n>]",
      description: "Generuoja eilės užduotis iš spec plano",
      run: (args) =>
        printTaskGenerate(args, {
          ports: taskGeneratePorts,
          projectRoot: deps.roots.projectRoot,
          runtimeRoot: deps.roots.runtimeRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "spec-drift",
      usage: "<change-id>",
      description: "Lygina pakeistus failus su spec change scope",
      run: (args) =>
        specDriftCommand(
          {
            ports: specDriftPorts(deps.roots.projectRoot, deps.roots.runtimeRoot),
            projectRoot: deps.roots.projectRoot,
            ...(io === undefined ? {} : { io }),
          },
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
