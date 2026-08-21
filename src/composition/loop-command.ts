// `verqestra loop` — visos bangos mechanikos SURIŠIMAS (manual DI, LAY-2).
//
// Čia susitinka viskas, kas buvo migruota atskirai: planuoklis, aprūpinimas, integracija,
// papildymas, dispatch'as, slot'o vykdytojas ir išorinis ciklas. Nė vienas jų nežino apie diską ar
// git — visi jų portai suvedami būtent šiame faile.
//
// Trys sprendimai, kurie čia yra sąmoningi, o ne techniniai:
//   1. `runId` gimsta VIENĄ kartą per paleidimą ir keliauja į kiekvieną įvykį bei checkpoint'ą —
//      be jo dviejų bėgimų pėdsakai susilietų į vieną istoriją;
//   2. in-process kelias yra TAS PATS koordinatorius, kurį kviečia `process-queued-task`: vieno
//      slot'o banga privalo elgtis baitas į baitą taip pat, kaip vykdymas be paralelizmo;
//   3. vaikas paleidžiamas per TĄ PAČIĄ CLI, kurią suka loop'as (`cliEntryPath`) — kitaip
//      izoliuota kopija dirbtų su kito build'o semantika.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRunCoordinator } from "../application/task-execution/run-coordinator.js";
import { createWaveScheduler, type ProvisioningStateAccess, type WaveIntegrationIo } from "../application/scheduling/wave-scheduler.js";
import { createWaveProvisioningCoordinator, type WaveProvisioningCoordinator } from "../application/scheduling/wave-provisioning.js";
import { createSlotTaskRunner, buildChildEnvironment, PROCESS_QUEUED_TASK_COMMAND } from "../application/scheduling/slot-task-runner.js";
import { runLoopCycle, type LoopCyclePorts, type ResumableTask } from "../application/scheduling/loop-cycle.js";
import { handleEmptyQueue, AUDIT_REPAIR_TASK_CONTENT, type EmptyQueuePorts } from "../application/scheduling/loop-empty-queue.js";
import { productTreeDirtyEntries, type LoopPreconditionPorts } from "../application/scheduling/loop-preconditions.js";
import { readLoopControl } from "../application/scheduling/loop-control-store.js";
import { listWorkerLeases, heartbeatWorkerLease, readWorkerLease, releaseWorkerLease } from "../application/scheduling/worker-lease-store.js";
import { WAVE_SLOT_LEASE_TTL_MS } from "../application/scheduling/loop-runtime-config.js";
import { createWaveWorkerRequestReader } from "../application/scheduling/wave-worker-request.js";
import { readWorkerRequest } from "../application/scheduling/worker-request-store.js";
import { selectNextResumableTask, type TaskSelectionPorts } from "../application/task-execution/task-selection.js";
import { importTaskGraphFromMarkdown } from "../application/task-execution/task-graph-import.js";
import { reclaimEvidencelessSynthesizedTasks, reclaimExternalInputNodes } from "../application/architecture/wave-reclaim.js";
import type { WaveDispatchSlot } from "../application/scheduling/wave-dispatch-model.js";
import type { SlotLeaseMutation } from "../application/scheduling/slot-task-runner.js";
import { readTaskGraphSnapshot, writeTaskGraphSnapshot } from "../infrastructure/persistence/task-graph-store.js";
import { readWaveSnapshot, writeWaveSnapshot } from "../infrastructure/state/wave-snapshot-store.js";
import { recordWaveEvent } from "../infrastructure/state/wave-events.js";
import { readResumeCheckpoint, recordResumeCheckpoint } from "../infrastructure/state/resume-checkpoint.js";
import { ensureWorktreeRuntime } from "../infrastructure/git/worktrees/worktree-runtime.js";
import { reapOrphanWorktrees } from "../infrastructure/git/worktrees/orphan-worktree-reaper.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";
import { reapDeadLeases, schedulingFs } from "./loop-adapters.js";
import { architectureWavePorts } from "./architecture-adapters.js";
import { cliEntryPath, type RuntimeRoots } from "./runtime-context.js";
import { createWaveIntegrationAdapters } from "./wave-integration-adapters.js";
import { taskRunPorts } from "./coordinator-execution-adapters.js";
import { cliChildRunner } from "./coordinator-adapters.js";
import { createTaskStateStore } from "../infrastructure/state/task-state-store.js";
import {
  ledgerDuplicate,
  locateTaskBucket,
  readQueueSchedulableTasks,
  taskHasAcceptedWork,
  waveWorktreePort,
  type WaveInputAdapterDeps,
} from "./wave-scheduler-adapters.js";

/** Sistemos remonto užduoties failas — jis eina savo keliu, ne per įprastą tęsimą. */
const AUDIT_REPAIR_TASK_FILE = "claude-audit-repair.md";

export type LoopCommandDeps = {
  roots: RuntimeRoots;
  log: (message: string) => Promise<void>;
  out: (message: string) => void;
  emptyQueue: EmptyQueuePorts;
  preconditions: LoopPreconditionPorts;
  taskSelection: TaskSelectionPorts;
  /** Stop vėliavos suvartojimas (UI kelias). */
  consumeStopRequest: () => Promise<boolean>;
  /** Nutrūkusio task'o tęsimas; `true` = pavyko. */
  resumeTask: (task: ResumableTask) => Promise<boolean>;
  /** Nepavykusio kokybės audito remonto užduoties vykdymas. */
  processAuditRepairTask: (content: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
};

export function buildLoopCyclePorts(deps: LoopCommandDeps): LoopCyclePorts {
  const { projectRoot, agRoot, runtimeRoot } = deps.roots;
  const runId = randomUUID();
  const now = (): string => new Date().toISOString();
  const inputs: WaveInputAdapterDeps = { projectRoot, agRoot, runtimeRoot, resolution: noRuntimeAttemptResolution };
  const leaseStore = { fs: schedulingFs };
  const readWorkerLeases = (): Promise<Awaited<ReturnType<typeof listWorkerLeases>>> => listWorkerLeases(schedulingFs, projectRoot);
  const absolutePath = (relativeFile: string): string => path.join(projectRoot, relativeFile);
  const stateDir = path.join(runtimeRoot, "state");

  // Aprūpinimas gauna PLANUOKLIO būseną (grafą ir tai, kas dirba) per fabriką: konstantos čia
  // reikštų aklą aprūpinimą — be grafo write-set'as tuščias, o be „kas dirba" tas pats task'as
  // gautų antrą lease'ą.
  const provisioning = (access: ProvisioningStateAccess): WaveProvisioningCoordinator =>
    createWaveProvisioningCoordinator({
      workspaceRoot: projectRoot,
      runId,
      // Proceso tapatybė paduodama, ne skaitoma application viduje.
      ownerId: `loop-${process.pid}`,
      leaseStore,
      worktree: waveWorktreePort({ projectRoot, agRoot }),
      now,
      log: deps.log,
      ...access,
    });

  const integrationAdapters = createWaveIntegrationAdapters({
    projectRoot,
    agRoot,
    taskStore: createTaskStateStore({ runtimeRoot, agRoot }),
    leaseStore,
    readWorkerLeases,
  });
  const integration: WaveIntegrationIo = integrationAdapters;

  const scheduler = createWaveScheduler({
    projectRoot,
    runId,
    now,
    log: deps.log,
    absolutePath,
    readTasks: () => readQueueSchedulableTasks(inputs),
    locateTask: (taskId) => locateTaskBucket(inputs, taskId),
    hasAcceptedWork: (taskId) => taskHasAcceptedWork(inputs, taskId),
    // Planuokliui reikia tik pjūvio; pilnas checkpoint'as neša laukus, kurių sprendimas nenaudoja.
    readCheckpoint: async () => {
      const checkpoint = await readResumeCheckpoint(runtimeRoot, "claude");
      return checkpoint === undefined
        ? undefined
        : {
            status: checkpoint.status,
            ...(checkpoint.task_id === undefined ? {} : { task_id: checkpoint.task_id }),
            ...(checkpoint.graph_hash === undefined ? {} : { graph_hash: checkpoint.graph_hash }),
            ...(checkpoint.attempt_id === undefined ? {} : { attempt_id: checkpoint.attempt_id }),
            updated_at: checkpoint.updated_at,
          };
    },
    readSnapshot: () => readWaveSnapshot(stateDir),
    writeSnapshot: async (snapshot) => {
      await writeWaveSnapshot(stateDir, snapshot);
    },
    recordEvent: (event) => recordWaveEvent(runtimeRoot, event),
    recordCheckpoint: (checkpoint) => recordResumeCheckpoint({ projectRoot, runtimeRoot, checkpoint }),
    importGraph: () =>
      importTaskGraphFromMarkdown({
        listTasksInBucket: async (bucket) => {
          const dir = path.join(agRoot, "tasks", bucket);
          const names = (await nodeFsAdapter.listDirectoryIfExists(dir)) ?? [];
          const entries: { file: string; text: string }[] = [];
          for (const name of names.filter((entry) => entry.endsWith(".md"))) {
            const text = await nodeFsAdapter.readTextFileIfExists(path.join(dir, name));
            if (text !== undefined) entries.push({ file: `AG/tasks/${bucket}/${name}`, text });
          }
          return entries;
        },
      }),
    writeGraphSnapshot: async (graph) => {
      await writeTaskGraphSnapshot(graph, runtimeRoot, { source: "markdown:queue", generatedAt: now() });
    },
    readGraphSnapshot: async () => {
      const stored = await readTaskGraphSnapshot(runtimeRoot);
      return stored.ok ? { ok: true, graph: stored.graph } : { ok: false, reason: stored.reason, errors: stored.errors };
    },
    readySetBudget: () => undefined,
    approvals: () => [],
    requestedWorkers: createWaveWorkerRequestReader({
      readRequest: async () => {
        const state = await readWorkerRequest({ fs: schedulingFs }, stateDir);
        return { requested: state.requested, ...(state.invalid === undefined ? {} : { invalid: state.invalid }) };
      },
      readControl: () => readLoopControl({ fs: schedulingFs }, stateDir),
      log: deps.log,
    }),
    ledgerDuplicate: (taskId, absoluteTaskFile) => ledgerDuplicate(inputs, taskId, absoluteTaskFile),
    integration,
    provisioning,
    readWorkerLeases,
  });

  const runSlotTask = createSlotTaskRunner({
    log: deps.log,
    // Vieno slot'o kelias — TAS PATS koordinatorius, kurį kviečia `process-queued-task`.
    runInProcess: (absoluteFile) =>
      createRunCoordinator(
        taskRunPorts({
          projectRoot,
          runtimeRoot,
          agRoot,
          resolution: noRuntimeAttemptResolution,
          ...cliChildRunner(projectRoot),
        }),
      ).start(absoluteFile),
    runChild: async (slot, worktreeAbs) => {
      // Task failas perduodamas RELIATYVUS: vaikas jį išsprendžia prieš savo darbo katalogą, tad
      // jokio kelių vertimo tarp medžių čia nereikia.
      const result = await run(process.execPath, [cliEntryPath(), PROCESS_QUEUED_TASK_COMMAND, slot.file], {
        cwd: worktreeAbs,
        env: buildChildEnvironment(deps.env ?? process.env, "CLAUDE_PROJECT_DIR", worktreeAbs, slot.attempt_ref),
      });
      return result.code === 0;
    },
    resolveWorktree: (worktreePath) => path.resolve(projectRoot, worktreePath),
    readLease: (workerId) => readWorkerLease(schedulingFs, projectRoot, workerId),
    heartbeat: async (claim, workerId): Promise<SlotLeaseMutation> => {
      const renewed = await heartbeatWorkerLease({ deps: leaseStore, projectRoot, claim, workerId, ttlMs: WAVE_SLOT_LEASE_TTL_MS });
      return renewed.status === "ok" ? { status: "ok" } : { status: "denied", reason: renewed.authority.reason };
    },
    release: async (claim, workerId): Promise<SlotLeaseMutation> => {
      const released = await releaseWorkerLease({ deps: leaseStore, projectRoot, claim, workerId });
      return released.status === "ok" ? { status: "ok" } : { status: "denied", reason: released.authority.reason };
    },
    prepareWorktree: (worktreeAbs) =>
      ensureWorktreeRuntime({
        projectRoot,
        worktreeAbs,
        layout: {
          distDir: "dist",
          nodeModulesDir: "node_modules",
          configFiles: [path.relative(projectRoot, path.join(runtimeRoot, "config", "local.env")).split(path.sep).join("/")],
          optionalJunctions: [],
        },
        log: deps.log,
        runProductInstall: (request) =>
          run(request.command, request.args, { cwd: request.cwd, timeoutMs: 15 * 60 * 1000 }).then((result) => result.code),
      }),
  });

  return {
    scheduler,
    absolutePath,
    log: deps.log,
    out: deps.out,
    recordEvent: (event) => recordWaveEvent(runtimeRoot, event),
    reapDeadLeases: () => reapDeadLeases(projectRoot, new Date()),
    reapOrphanWorktrees: async () =>
      await reapOrphanWorktrees({ projectRoot, runtimeRoot, agRoot, leases: await readWorkerLeases() }),
    reclaimQueue: async () => {
      // Eilės valymas prieš imant darbą: išgalvoti mazgai ir be įrodymų sintezuoti task'ai.
      // Be grafo tai švarus no-op, tad klaida čia nėra vartai — ji tik prarastų eilutę.
      const lines: string[] = [];
      const wavePorts = architectureWavePorts(projectRoot);
      const external = await reclaimExternalInputNodes(wavePorts, projectRoot);
      if (external.nodes.length > 0) lines.push(`ARCHITECTURE EXTERNAL INPUT NODES RECLAIMED: ${external.nodes.join(", ")}`);
      const evidenceless = await reclaimEvidencelessSynthesizedTasks(wavePorts, projectRoot);
      if (evidenceless.nodes.length > 0) {
        lines.push(`ARCHITECTURE EVIDENCE-LESS TASKS RECLAIMED: ${evidenceless.nodes.join(", ")}`);
      }
      return lines;
    },
    consumeStopRequest: deps.consumeStopRequest,
    readLoopControl: () => readLoopControl({ fs: schedulingFs }, stateDir),
    productTreeDirtyEntries: () => productTreeDirtyEntries(deps.preconditions, projectRoot),
    selectNextResumableTask: async () => {
      const found = await selectNextResumableTask(agRoot, deps.taskSelection);
      return found === undefined ? undefined : { bucket: found.bucket, file: found.file };
    },
    resumeTask: deps.resumeTask,
    isAuditRepairTask: (task) => task.bucket === "error" && path.basename(task.file) === AUDIT_REPAIR_TASK_FILE,
    processAuditRepairTask: () => deps.processAuditRepairTask(AUDIT_REPAIR_TASK_CONTENT),
    handleEmptyQueue: (bootstrapAttempted) => handleEmptyQueue(deps.emptyQueue, projectRoot, bootstrapAttempted),
    runSlotTask: (slot: WaveDispatchSlot) => runSlotTask(slot),
  };
}

/** `verqestra loop` kūnas: portų suvedimas + ciklas. Exit kodas 0 — sustojimas visada švarus. */
export async function runLoopCommand(deps: LoopCommandDeps): Promise<number> {
  const ports = buildLoopCyclePorts(deps);
  await ports.scheduler.recoverFromCrash();
  await runLoopCycle(ports);
  return 0;
}
