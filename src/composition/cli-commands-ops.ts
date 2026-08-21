// Operatoriaus ir loop aptarnavimo komandu registro pjuvis (VQ-504): projekto rezimas,
// sablonu diegimas, smoke, atkurimas is stable-ref, retry vartai ir stop-bridge.
//
// Dali siu komandu kviecia NE operatorius, o loop skriptas (`retry-guard`, `on-stop-bridge`).

import type { CliCommand } from "../interfaces/cli/registry.js";
import type { CliRegistryDeps } from "./cli-registry-types.js";
import { bootstrapProjectCommand } from "../interfaces/cli/bootstrap/bootstrap-project.js";
import { runUiCommand } from "./ui-command.js";
import { consoleCliIo } from "../interfaces/cli/registry.js";
import { compoundInitCommand } from "../interfaces/cli/bootstrap/compound-init.js";
import { installCommand } from "../interfaces/cli/bootstrap/install.js";
import { rollbackStableCommand } from "../interfaces/cli/bootstrap/rollback-stable.js";
import { projectModeCommand } from "../interfaces/cli/bootstrap/project-mode.js";
import { restoreStableCommand } from "../interfaces/cli/bootstrap/restore-stable.js";
import { smokeCommand } from "../interfaces/cli/bootstrap/smoke.js";
import { printCodexDispatch } from "../interfaces/cli/dispatch/codex-dispatch.js";
import { printDispatch } from "../interfaces/cli/dispatch/dispatch.js";
import { claudeDiagnose } from "../interfaces/cli/dispatch/claude-diagnose/index.js";
import { claudeDispatch } from "../interfaces/cli/dispatch/claude-dispatch/command.js";
import { claudePreflight } from "../interfaces/cli/dispatch/claude-preflight/index.js";
import { loopGuard } from "../interfaces/cli/dispatch/loop-guard.js";
import { onStopBridge } from "../interfaces/cli/dispatch/on-stop-bridge.js";
import { retryGuard } from "../interfaces/cli/dispatch/retry-guard.js";
import { ensureRuntimeDirs } from "../infrastructure/state/runtime-dirs.js";
import {
  bootstrapProjectPorts,
  compoundInitPorts,
  installPorts,
  projectModePorts,
  restoreStablePorts,
  rollbackStablePorts,
  smokePorts,
} from "./bootstrap-adapters.js";
import {
  createAdapterWithOptions,
  dispatchAdapters,
  loopPreconditionPorts,
  onStopBridgeAdapters,
  reapDeadLeases,
  retryGuardAdapters,
} from "./loop-adapters.js";
import { evaluateLoopPreconditions } from "../application/scheduling/loop-preconditions.js";
import { claudeDiagnosePorts } from "./diagnose-adapters.js";
import { claudePreflightPorts } from "./claude-preflight-adapters.js";
import { claudeDispatchPorts } from "./claude-dispatch-adapters.js";
import { activeAttemptResolution } from "../infrastructure/state/active-attempt.js";
import { packageRoot } from "./runtime-context.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { tryParseJson } from "../shared/json.js";
import { runLoopCommand } from "./loop-command.js";
import { emptyQueuePorts, finalAuditRepairPorts } from "./loop-empty-queue-adapters.js";
import { processFinalAuditRepairTask } from "../application/quality-gates/final-audit-repair.js";
import { createRunCoordinator } from "../application/task-execution/run-coordinator.js";
import { taskRunPorts } from "./coordinator-execution-adapters.js";
import { cliChildRunner } from "./coordinator-adapters.js";
import { createTaskStateStore } from "../infrastructure/state/task-state-store.js";
import { consumeLoopStopRequest } from "../interfaces/http/loop-lifecycle.js";
import { appendLogLine } from "./loop-adapters.js";
import { processLifecyclePorts } from "./ui-lifecycle-adapters.js";
import path from "node:path";
import { cliEntryPath, templatesRoot } from "./runtime-context.js";

export function opsCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  return [
    {
      name: "project-mode",
      usage: "[--json]",
      description: "Nustato projekto režimą (naujas, tęsiamas, nutrūkęs)",
      run: (args) =>
        projectModeCommand(
          {
            ports: projectModePorts,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "ui",
      usage: "",
      description: "Paleidžia dashboard'ą ant 127.0.0.1 (prievadas — iš vq/state/ui-server.json)",
      run: () => runUiCommand(deps, io ?? consoleCliIo),
    },
    {
      name: "bootstrap-project",
      usage: "[--json]",
      description: "Paruošia architektūros grafą ir pirmąsias eilės užduotis iš README",
      run: (args) =>
        bootstrapProjectCommand(
          {
            ports: bootstrapProjectPorts(deps.roots.projectRoot, deps.roots.runtimeRoot),
            projectRoot: deps.roots.projectRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "compound-init",
      usage: "<aprašymas> [--force]",
      description: "Paruošia darbo erdvę ir projekto profilį",
      run: (args) =>
        compoundInitCommand(
          {
            ports: compoundInitPorts,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "install",
      usage: "[--dry-run]",
      description: "Įdiegia šablonus į projektą (esamų failų neperrašo)",
      run: (args) =>
        installCommand(
          { ports: installPorts, templatesRoot: templatesRoot(), ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "smoke",
      usage: "",
      description: "Aplinkos ir eilės smoke patikra (nieko nekeičia)",
      run: () =>
        smokeCommand({
          ports: smokePorts(deps.roots.agRoot, deps.roots.runtimeRoot),
          projectRoot: deps.roots.projectRoot,
          runtimeRoot: deps.roots.runtimeRoot,
          cliEntry: cliEntryPath(),
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "restore-stable",
      usage: "[--execute]",
      description: "Atkuria medį iš stable-ref (be --execute tik parodo planą)",
      run: (args) =>
        restoreStableCommand(
          {
            ports: restoreStablePorts,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "rollback-stable",
      usage: "[--task-scope] [--ref <sha>]",
      description: "Grąžina medį į stable-ref su untracked snapshot'u",
      run: (args) =>
        rollbackStableCommand(
          {
            ports: rollbackStablePorts(deps.roots.runtimeRoot),
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "claude-dispatch",
      usage: "<task-file> [--task-id <id>]",
      description: "Paleidžia vykdytojo modelį su maršrutu, biudžetu ir stop-bridge įrodymu",
      run: (args) =>
        claudeDispatch(
          args,
          claudeDispatchPorts({
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            agRoot: deps.roots.agRoot,
            resolution: activeAttemptResolution({
              projectRoot: deps.roots.projectRoot,
              runtimeRoot: deps.roots.runtimeRoot,
              // Dispatch'as PRADEDA bandymą, tad jis vienintelis kuria namespace'ą.
              create: true,
            }),
          }),
        ),
    },
    {
      name: "claude-preflight",
      usage: "<task-file>",
      description: "LLM preflight: performulavimas, spec kontekstas, agentai, biudžetas",
      run: (args) =>
        claudePreflight(
          args,
          claudePreflightPorts({
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            agRoot: deps.roots.agRoot,
            resolution: activeAttemptResolution({ projectRoot: deps.roots.projectRoot, runtimeRoot: deps.roots.runtimeRoot }),
            ...(io === undefined ? {} : { io }),
          }),
        ),
    },
    {
      name: "claude-diagnose",
      usage: "<task-file>",
      description: "Diagnozuoja nepavykusį bandymą ir parašo repair sprendimą",
      run: (args) =>
        claudeDiagnose(
          args,
          claudeDiagnosePorts({
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            agRoot: deps.roots.agRoot,
            // Diagnozė SKAITO įrodymus, tad `create` jai neduodamas: bandymą pradeda dispatch'as.
            resolution: activeAttemptResolution({ projectRoot: deps.roots.projectRoot, runtimeRoot: deps.roots.runtimeRoot }),
            ...(io === undefined ? {} : { io }),
          }),
        ),
    },
    {
      name: "loop",
      usage: "",
      description: "Eilės vykdymo ciklas: bangos, slot'ai ir integracija iki tuščios eilės",
      run: async () => {
        await ensureRuntimeDirs(deps.roots.agRoot, deps.roots.runtimeRoot);
        const emptyQueueDeps = {
          roots: deps.roots,
          out: (message: string) => (io ?? consoleCliIo).out(message),
          // Vaiko žingsniai (`claude-dispatch`, `quality-gates`) eina per TĄ PAČIĄ CLI, kurią
          // suka loop'as — kitaip remontas dirbtų su kito build'o semantika.
          runCommand: (args: string[]) => cliChildRunner(deps.roots.projectRoot).runCli(args),
          taskStore: createTaskStateStore({ runtimeRoot: deps.roots.runtimeRoot, agRoot: deps.roots.agRoot }),
        };
        return await runLoopCommand({
          roots: deps.roots,
          log: (message: string) => appendLogLine(deps.roots.runtimeRoot, "orchestrator.log", message),
          out: (message) => (io ?? consoleCliIo).out(message),
          emptyQueue: emptyQueuePorts(emptyQueueDeps),
          preconditions: loopPreconditionPorts(),
          // Task'ų enumeracija eina per tą patį FS adapterį kaip visur kitur: antra kopija
          // duotų kitą rūšiavimą, o eilės tvarka yra kontraktas.
          taskSelection: {
            listMarkdownFilePaths: async (dir: string) => {
              const names = (await nodeFsAdapter.listDirectoryIfExists(dir)) ?? [];
              return names.filter((name) => name.endsWith(".md")).map((name) => path.join(dir, name)).sort();
            },
          },
          consumeStopRequest: () =>
            consumeLoopStopRequest({
              ports: processLifecyclePorts({ projectRoot: deps.roots.projectRoot, runtimeRoot: deps.roots.runtimeRoot }),
              runtimeRoot: deps.roots.runtimeRoot,
            }),
          // Nutrūkęs task'as tęsiamas TUO PAČIU koordinatoriumi kaip naujas: „tęsimas" nėra
          // atskira semantika, o tik kitas įėjimo taškas į tą patį ciklą.
          resumeTask: (task) =>
            createRunCoordinator(
              taskRunPorts({
                projectRoot: deps.roots.projectRoot,
                runtimeRoot: deps.roots.runtimeRoot,
                agRoot: deps.roots.agRoot,
                resolution: activeAttemptResolution({
                  projectRoot: deps.roots.projectRoot,
                  runtimeRoot: deps.roots.runtimeRoot,
                  create: true,
                }),
                ...cliChildRunner(deps.roots.projectRoot),
              }),
            ).start(path.resolve(deps.roots.projectRoot, task.file)),
          processAuditRepairTask: async (content) => {
            await processFinalAuditRepairTask(finalAuditRepairPorts(emptyQueueDeps), content);
          },
        });
      },
    },
    {
      name: "loop-guard",
      usage: "",
      description: "Pre-loop patikros be loop'o starto (0 = saugu, 1 = blokuota)",
      run: () =>
        loopGuard({
          ensureDirs: () => ensureRuntimeDirs(deps.roots.agRoot, deps.roots.runtimeRoot),
          evaluate: () =>
            evaluateLoopPreconditions(
              loopPreconditionPorts(),
              deps.roots.projectRoot,
              // Dist šviežumas tikrinamas ŠIO diegimo pakete, ne vartotojo projekte: loop'as
              // vykdo būtent šio paketo `dist`, o taikinio medyje jo išvis gali nebūti.
              packageRoot(),
              path.join(deps.roots.runtimeRoot, "state"),
              Date.now(),
              { reapDeadLeases },
            ),
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "dispatch",
      usage: "<task-file> [--adapter <kind>]",
      description: "Paleidžia vykdymo adapterį PO preflight, biudžeto ir context-pack vartų",
      run: (args) =>
        printDispatch(args, {
          ...dispatchAdapters(deps.roots.projectRoot, deps.roots.runtimeRoot),
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "codex-dispatch",
      usage: "<task-id> [--adapter codex]",
      description: "Codex adapterio kelias (be --adapter codex — dry-run)",
      run: (args) =>
        printCodexDispatch(args, {
          createAdapter: createAdapterWithOptions,
          readContextPack: async (absolutePath) => {
            const raw = await nodeFsAdapter.readTextFile(absolutePath);
            const parsed = tryParseJson<Record<string, unknown>>(raw);
            // Sugadintas context-pack META: tuščias objektas atrodytų kaip teisėtas paketas
            // be leistinų kelių, ir adapteris dirbtų be jokio scope.
            if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
              throw new Error(`context pack is invalid: ${absolutePath}`);
            }
            return parsed.value;
          },
          resolvePath: (candidate) => path.resolve(candidate),
          cwd: () => deps.roots.projectRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "retry-guard",
      usage: "[--task-id <id>]",
      description: "Retry skaitikliai ir limitas prieš human-review nusileidimą",
      run: (args) =>
        retryGuard(args, {
          ensureDirs: () => ensureRuntimeDirs(deps.roots.agRoot, deps.roots.runtimeRoot),
          ...retryGuardAdapters(deps.roots.runtimeRoot),
        }),
    },
    {
      name: "on-stop-bridge",
      usage: "<status> [reason]",
      description: "Įrašo Stop-bridge įrodymą (attempt + globalus veidrodis)",
      run: (args) => onStopBridge(args, onStopBridgeAdapters(deps.roots.projectRoot, deps.roots.runtimeRoot)),
    },
  ];
}
