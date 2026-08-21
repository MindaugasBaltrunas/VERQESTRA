// Architekturos ir kodo intelekto komandu registro pjuvis (VQ-504).
//
// Bendra tema: sios komandos SKAITO produkto medi (indeksas, simboliu skenas, kodo zemelapis)
// ir raso architekturos busena. Visos jos dalijasi VIENU failu sistemos portu -- antra kopija
// reikstu, kad vartai ir komanda gali matyti skirtinga ta pati medi.

import type { CliCommand } from "../interfaces/cli/registry.js";
import type { CliRegistryDeps } from "./cli-registry-types.js";
import { architectureCommand } from "../interfaces/cli/architecture/command.js";
import { codeGraphCommand } from "../interfaces/cli/code-intel/code-graph.js";
import { codeIndexCommand } from "../interfaces/cli/code-intel/code-index.js";
import { contextPackCommand } from "../interfaces/cli/code-intel/context-pack.js";
import { architectureGraphStore, architectureWavePorts, assembleContextPackDeps } from "./architecture-adapters.js";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";
import { codeIntelligenceFs, policyConfigFs } from "./node-adapters.js";

export function architectureCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  return [
    {
      name: "code-index",
      usage: "[build|check|architecture-check]",
      description: "Kodo indeksas (skenas, simboliai, sviezumas)",
      run: (args) =>
        codeIndexCommand(
          {
            codeFs: codeIntelligenceFs(deps.roots.projectRoot),
            policyFs: policyConfigFs,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "code-graph",
      usage: "query <file-or-symbol> [--json] [--fuzzy]",
      description: "Kodo grafo uzklausos (priklausomybes, simboliai)",
      run: (args) =>
        codeGraphCommand(
          { codeFs: codeIntelligenceFs(deps.roots.projectRoot), projectRoot: deps.roots.projectRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "context-pack",
      usage: "<task-file> [--with-code-graph]",
      description: "Surenka konteksto paketą užduočiai (retrieval, biudžetas, kešas)",
      run: (args) =>
        contextPackCommand(
          {
            assembleDeps: assembleContextPackDeps(
              deps.roots.projectRoot,
              deps.roots.runtimeRoot,
              noRuntimeAttemptResolution,
            ),
            projectRoot: deps.roots.projectRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "architecture",
      usage: "[init|check|import-mmd|next-node|synthesize-node|verify-node|run-tree|code-map]",
      description: "Architekturos grafas, banga, verifikacija ir kodo zemelapis",
      run: (args) =>
        architectureCommand(
          {
            wave: architectureWavePorts(deps.roots.projectRoot),
            codeFs: codeIntelligenceFs(deps.roots.projectRoot),
            graphStore: architectureGraphStore,
            projectRoot: deps.roots.projectRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
  ];
}
