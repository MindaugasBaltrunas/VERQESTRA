// Isoriniu integraciju ir benchmark komandu registro pjuvis (VQ-504).
//
// Bendra tema: komandos, kurios liecia (arba galetu liesti) SVETIMA sistema -- GitHub API,
// atskira benchmark paketa, isorini optimizacijos matavima. GitHub kelias cia veikia BE
// tinklo kliento -- lygiai kaip etalone: politikos vartai, teksto sudarymas ir rezultato
// artefaktas gimsta lokaliai, o pats kvietimas lieka ipurskiamam klientui.

import type { CliCommand } from "../interfaces/cli/registry.js";
import type { CliRegistryDeps } from "./cli-registry-types.js";
import { benchmarkLoopCellCommand } from "../interfaces/cli/benchmark/benchmark-loop-cell.js";
import { benchmarkDriveCommand } from "../interfaces/cli/benchmark/benchmark-drive.js";
import { benchmarkCommand } from "../interfaces/cli/benchmark/benchmark-package.js";
import { optimizationBenchmarkCommand } from "../interfaces/cli/benchmark/optimization-benchmark.js";
import { githubIssueImportCommand } from "../interfaces/cli/github/issue-import.js";
import { githubPrCommand } from "../interfaces/cli/github/pull-request.js";
import {
  benchmarkCaptureFs,
  benchmarkDrivePorts,
  benchmarkLoopCellPorts,
  benchmarkPackageLoader,
  gitHubIssueImportPorts,
  gitHubPrPorts,
} from "./integration-adapters.js";
import { cliEntryPath } from "./runtime-context.js";

export function integrationsCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  return [
    {
      name: "benchmark",
      usage: "[--mode <režimas>] [--json]",
      description: "Paleidžia @verqestra/benchmark paketą",
      run: (args) =>
        benchmarkCommand(
          {
            packageLoader: benchmarkPackageLoader,
            projectRoot: deps.roots.projectRoot,
            // Mokamų režimų vaikas paleidžiamas TUO PAČIU node ir TUO PAČIU CLI įėjimu:
            // PATH'e rastas kitas `verqestra` matuotų ne tą diegimą, kurį paleido operatorius.
            nodeExecPath: process.execPath,
            cliEntry: cliEntryPath(),
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "benchmark-drive",
      usage: "--workdir <d> --model <m> --step-limit <n> --timeout-ms <n> [--prompt-file <f>]",
      description: "Vienas ribotas headless agento bėgimas benchmark scenarijui",
      run: (args) => benchmarkDriveCommand({ ports: benchmarkDrivePorts, ...(io === undefined ? {} : { io }) }, args),
    },
    {
      // `ag-loop` celė: PILNAS ciklas, o ne vienas agento kvietimas. Skirtumas nuo
      // `benchmark-drive` yra visas šio režimo matavimas — žr. modulio antraštę.
      name: "benchmark-loop-cell",
      usage: "--workdir <d> --model <m> --step-limit <n> --timeout-ms <n> --allowed-path <p> [--check <cmd>]",
      description: "Viena ag-loop benchmark celė: pilnas eilės ciklas scenarijaus kopijoje",
      run: (args) =>
        benchmarkLoopCellCommand({ ports: benchmarkLoopCellPorts, ...(io === undefined ? {} : { io }) }, args),
    },
    {
      name: "optimization-benchmark",
      usage: "[--capture|--compare] [--json]",
      description: "Optimizacijos matavimas prieš baseline",
      run: (args) =>
        optimizationBenchmarkCommand(
          { fs: benchmarkCaptureFs, runtimeRoot: deps.roots.runtimeRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "github-issue-import",
      usage: "--issue <numeris>",
      description: "Importuoja GitHub issue kaip užduoties juodraštį",
      run: (args) =>
        githubIssueImportCommand(
          {
            ports: gitHubIssueImportPorts,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "github-pr",
      usage: "[--create]",
      description: "Sudaro PR tekstą iš vartų būsenos (be --create tik juodraštis)",
      run: (args) =>
        githubPrCommand(
          {
            ports: gitHubPrPorts,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
  ];
}
