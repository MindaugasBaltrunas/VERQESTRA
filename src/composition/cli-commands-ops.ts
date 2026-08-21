// Operatoriaus ir loop aptarnavimo komandu registro pjuvis (VQ-504): projekto rezimas,
// sablonu diegimas, smoke, atkurimas is stable-ref, retry vartai ir stop-bridge.
//
// Dali siu komandu kviecia NE operatorius, o loop skriptas (`retry-guard`, `on-stop-bridge`).

import type { CliCommand } from "../interfaces/cli/registry.js";
import type { CliRegistryDeps } from "./cli-registry-types.js";
import { compoundInitCommand } from "../interfaces/cli/bootstrap/compound-init.js";
import { installCommand } from "../interfaces/cli/bootstrap/install.js";
import { rollbackStableCommand } from "../interfaces/cli/bootstrap/rollback-stable.js";
import { projectModeCommand } from "../interfaces/cli/bootstrap/project-mode.js";
import { restoreStableCommand } from "../interfaces/cli/bootstrap/restore-stable.js";
import { smokeCommand } from "../interfaces/cli/bootstrap/smoke.js";
import { printCodexDispatch } from "../interfaces/cli/dispatch/codex-dispatch.js";
import { printDispatch } from "../interfaces/cli/dispatch/dispatch.js";
import { onStopBridge } from "../interfaces/cli/dispatch/on-stop-bridge.js";
import { retryGuard } from "../interfaces/cli/dispatch/retry-guard.js";
import { ensureRuntimeDirs } from "../infrastructure/state/runtime-dirs.js";
import {
  compoundInitPorts,
  installPorts,
  projectModePorts,
  restoreStablePorts,
  rollbackStablePorts,
  smokePorts,
} from "./bootstrap-adapters.js";
import { createAdapterWithOptions, dispatchAdapters, onStopBridgeAdapters, retryGuardAdapters } from "./loop-adapters.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { tryParseJson } from "../shared/json.js";
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
