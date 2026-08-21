// Uzduociu eiles komandu registro pjuvis (VQ-504): ledger'io sinchronizacija, perkelimai,
// grazinimas i eile, busena ir priklausomybes.
//
// Bendra sio pjuvio savybe: visos komandos JUDINA arba skaito eiles busena, tad jos gauna ta
// pacia task busenos saugykla kaip loop'as -- rankinis kelias be lock'o butu lenktynes.

import type { CliCommand } from "../interfaces/cli/registry.js";
import type { CliRegistryDeps } from "./cli-registry-types.js";
import { statusCommand } from "../interfaces/cli/admin/status.js";
import { processQueuedTaskCommand } from "../interfaces/cli/task-queue/process-queued-task.js";
import { createRunCoordinator } from "../application/task-execution/run-coordinator.js";
import { ensureRuntimeDirs } from "../infrastructure/state/runtime-dirs.js";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";
import { taskRunPorts } from "./coordinator-execution-adapters.js";
import { cliChildRunner } from "./coordinator-adapters.js";
import { printTaskDependencies } from "../interfaces/cli/task-queue/task-dependencies.js";
import { requeueTask } from "../interfaces/cli/task-queue/requeue.js";
import { moveTask } from "../interfaces/cli/task-queue/task-move.js";
import { taskLedgerSyncCommand } from "../interfaces/cli/task-queue/task-ledger-sync.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import {
  blockedTaskRoutingPorts,
  isFile,
  statusPorts,
  taskLedgerStore,
  taskStateStore,
  tokenBudgetPorts,
} from "./node-adapters.js";

const nodeListFiles = (absoluteDir: string): Promise<string[]> => nodeFsAdapter.listFiles(absoluteDir);

export function tasksCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  return [
    {
      name: "task-ledger-sync",
      description: "Sutikrina task ledger'į su realiais bucket'ų failais",
      run: () =>
        taskLedgerSyncCommand({
          ledger: taskLedgerStore(deps.roots.runtimeRoot),
          listFiles: (absoluteDir) => nodeListFiles(absoluteDir),
          agRoot: deps.roots.agRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "task-move",
      usage: "<task-file> <target-dir>",
      description: "Perkelia užduoties failą į kitą bucket'ą",
      run: (args) =>
        moveTask(args, {
          store: taskStateStore(deps.roots.agRoot, deps.roots.runtimeRoot),
          isFile,
          projectRoot: deps.roots.projectRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "requeue",
      usage: "<task-file-or-name>",
      description: "Grąžina užduotį į eilę (ledger + biudžeto atstatymas)",
      run: (args) =>
        requeueTask(args, {
          store: taskStateStore(deps.roots.agRoot, deps.roots.runtimeRoot),
          ledger: taskLedgerStore(deps.roots.runtimeRoot),
          budget: tokenBudgetPorts(deps.roots.runtimeRoot),
          isFile,
          projectRoot: deps.roots.projectRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "status",
      usage: "",
      description: "Eilės, einamojo task'o, tokenų ir stop įrodymo santrauka",
      run: () =>
        statusCommand({
          ports: statusPorts(deps.roots.projectRoot, deps.roots.runtimeRoot, deps.roots.agRoot),
          projectRoot: deps.roots.projectRoot,
          runtimeRoot: deps.roots.runtimeRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "process-queued-task",
      usage: "<task-file>",
      description: "Vieno eilės task'o pilnas ciklas (loop child vykdytojas)",
      run: (args) =>
        processQueuedTaskCommand(args, {
          ensureDirs: () => ensureRuntimeDirs(deps.roots.agRoot, deps.roots.runtimeRoot),
          processQueuedTask: (taskFile) =>
            createRunCoordinator(
              taskRunPorts({
                projectRoot: deps.roots.projectRoot,
                runtimeRoot: deps.roots.runtimeRoot,
                agRoot: deps.roots.agRoot,
                resolution: noRuntimeAttemptResolution,
                ...cliChildRunner(deps.roots.projectRoot),
              }),
            ).start(taskFile),
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "task-dependencies",
      usage: "[list|route-blocked <task-id>] [--json]",
      description: "Užduočių priklausomybės ir blokuotų užduočių maršrutizavimas",
      run: (args) =>
        printTaskDependencies(args, {
          ports: blockedTaskRoutingPorts(deps.roots.projectRoot, deps.roots.agRoot, deps.roots.runtimeRoot),
          ...(io === undefined ? {} : { io }),
        }),
    },
  ];
}
